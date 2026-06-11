use tauri::AppHandle;

#[cfg(windows)]
mod platform {
    use once_cell::sync::Lazy;
    use std::{
        ptr::null_mut,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc, Mutex,
        },
        thread,
        time::Duration,
    };
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::{SystemInformation::GetTickCount64, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::VK_ESCAPE,
            WindowsAndMessaging::{
                CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
                UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
                LLKHF_LOWER_IL_INJECTED, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT,
                WM_SYSKEYDOWN,
            },
        },
    };

    const EMERGENCY_STOP_EVENT: &str = "computer-use://emergency-stop-requested";
    const ESCAPE_EVENT_THROTTLE_MS: u64 = 300;
    const HOTKEY_THREAD_START_TIMEOUT: Duration = Duration::from_secs(2);

    static HOTKEY_STATE: Lazy<Mutex<Option<HotkeyState>>> = Lazy::new(|| Mutex::new(None));
    static HOTKEY_APP: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));
    static LAST_ESCAPE_EVENT_MS: AtomicU64 = AtomicU64::new(0);

    struct HotkeyState {
        thread_id: u32,
    }

    pub(crate) fn set_global_emergency_hotkey_enabled(
        app: AppHandle,
        enabled: bool,
    ) -> Result<(), String> {
        if enabled {
            start_global_emergency_hotkey(app)
        } else {
            stop_global_emergency_hotkey();
            Ok(())
        }
    }

    pub(crate) fn stop_global_emergency_hotkey() {
        let state = HOTKEY_STATE.lock().ok().and_then(|mut guard| guard.take());
        if let Some(state) = state {
            unsafe {
                let _ = PostThreadMessageW(state.thread_id, WM_QUIT, 0, 0);
            }
        }
        clear_app_handle();
    }

    fn start_global_emergency_hotkey(app: AppHandle) -> Result<(), String> {
        {
            let mut app_guard = HOTKEY_APP
                .lock()
                .map_err(|_| "Computer Use emergency hotkey app lock is poisoned.".to_string())?;
            *app_guard = Some(app);
        }

        let mut state_guard = HOTKEY_STATE
            .lock()
            .map_err(|_| "Computer Use emergency hotkey state lock is poisoned.".to_string())?;
        if state_guard.is_some() {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("javis-computer-use-emergency-hotkey".to_string())
            .spawn(move || run_hotkey_thread(tx))
            .map_err(|error| format!("Failed to start Computer Use emergency hotkey: {error}"))?;

        let thread_id = match rx.recv_timeout(HOTKEY_THREAD_START_TIMEOUT) {
            Ok(Ok(thread_id)) => thread_id,
            Ok(Err(error)) => {
                clear_app_handle();
                return Err(format!(
                    "Failed to register Computer Use emergency hotkey: {error}"
                ));
            }
            Err(_) => {
                clear_app_handle();
                return Err("Computer Use emergency hotkey did not start in time.".to_string());
            }
        };

        *state_guard = Some(HotkeyState { thread_id });
        Ok(())
    }

    fn clear_app_handle() {
        if let Ok(mut app) = HOTKEY_APP.lock() {
            *app = None;
        }
    }

    fn run_hotkey_thread(started: mpsc::Sender<Result<u32, String>>) {
        unsafe {
            let thread_id = GetCurrentThreadId();
            let mut bootstrap_msg: MSG = std::mem::zeroed();
            let _ = PeekMessageW(&mut bootstrap_msg, null_mut(), 0, 0, PM_NOREMOVE);

            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), null_mut(), 0);
            if hook.is_null() {
                let _ = started.send(Err(std::io::Error::last_os_error().to_string()));
                return;
            }

            let _ = started.send(Ok(thread_id));

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {}

            let _ = UnhookWindowsHookEx(hook);
        }
    }

    unsafe extern "system" fn keyboard_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && is_escape_keydown(wparam, lparam) {
            emit_escape_event();
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    unsafe fn is_escape_keydown(wparam: WPARAM, lparam: LPARAM) -> bool {
        let message = wparam as u32;
        if message != WM_KEYDOWN && message != WM_SYSKEYDOWN {
            return false;
        }
        if lparam == 0 {
            return false;
        }
        let event = *(lparam as *const KBDLLHOOKSTRUCT);
        event.vkCode == VK_ESCAPE as u32
            && event.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED) == 0
    }

    fn emit_escape_event() {
        let now = unsafe { GetTickCount64() };
        let previous = LAST_ESCAPE_EVENT_MS.load(Ordering::Relaxed);
        if now.saturating_sub(previous) < ESCAPE_EVENT_THROTTLE_MS {
            return;
        }
        LAST_ESCAPE_EVENT_MS.store(now, Ordering::Relaxed);

        if let Ok(app_guard) = HOTKEY_APP.lock() {
            if let Some(app) = app_guard.as_ref() {
                let _ = app.emit(EMERGENCY_STOP_EVENT, ());
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::AppHandle;

    pub(crate) fn set_global_emergency_hotkey_enabled(
        _app: AppHandle,
        enabled: bool,
    ) -> Result<(), String> {
        if enabled {
            Err("Computer Use global emergency hotkey is only available on Windows.".to_string())
        } else {
            Ok(())
        }
    }

    pub(crate) fn stop_global_emergency_hotkey() {}
}

#[tauri::command]
pub(crate) fn computer_set_emergency_hotkey_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    platform::set_global_emergency_hotkey_enabled(app, enabled)
}

pub(crate) fn stop_global_emergency_hotkey() {
    platform::stop_global_emergency_hotkey();
}
