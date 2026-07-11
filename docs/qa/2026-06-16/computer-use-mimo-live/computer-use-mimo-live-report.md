# Computer Use MiMo Live Test

Date: 2026-06-16 10:40-10:41 +08:00

Executable: `E:\Javis\apps\desktop\src-tauri\target\release\javis-desktop.exe`

Model: `mimo-v2.5`

Base URL: `https://token-plan-cn.xiaomimimo.com/v1`

Goal: send the harmless test message `Javis computer-use 测试，请忽略` to QQ contact `凤雏-大聪明`.

Result: PASS

Evidence:

- `qq-window-before-message.png`
- `qq-mimo-step1-non-json.json`
- `qq-mimo-step1-retry-non-json.json`
- `qq-window-after-type-before-send.png`
- `qq-type-action-result.json`
- `qq-window-after-paste-before-send.png`
- `qq-paste-action-result.json`
- `qq-window-after-send.png`
- `qq-send-action-result.json`

Notes:

- MiMo answered the first two prompts with prose instead of valid JSON, so the local parser would reject those outputs.
- `computer.type` now uses Unicode input for text entry, which fixed the QQ smoke case that previously lost leading ASCII text and spaces.
- The final QQ smoke screenshot showed the full text `Javis computer-use 测试` in the input area before clearing the draft.
