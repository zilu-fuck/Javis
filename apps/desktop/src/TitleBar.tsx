import appIconUrl from "./assets/app-icon.png";

interface TitleBarWindow {
  startDragging(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

interface TitleBarProps {
  currentWindow: TitleBarWindow | null;
  onDragError: (error: unknown) => void;
}

export function TitleBar({ currentWindow, onDragError }: TitleBarProps) {
  const isDesktop = currentWindow !== null;

  function handleDragStart() {
    currentWindow?.startDragging().catch(onDragError);
  }

  async function handleMinimize() {
    await currentWindow?.minimize();
  }

  async function handleToggleMaximize() {
    await currentWindow?.toggleMaximize();
  }

  async function handleClose() {
    await currentWindow?.close();
  }

  function handleNotifications() {
    // Placeholder for future message and notification prompts.
  }

  return (
    <header
      className="javis-titlebar"
      data-tauri-drag-region={isDesktop ? true : undefined}
      onDoubleClick={handleToggleMaximize}
      onPointerDown={(event) => {
        if (event.button === 0 && event.detail === 1) {
          handleDragStart();
        }
      }}
    >
      <div className="javis-titlebar-brand" data-tauri-drag-region={isDesktop ? true : undefined}>
        <img className="javis-titlebar-icon" src={appIconUrl} alt="" aria-hidden="true" />
        <span data-tauri-drag-region={isDesktop ? true : undefined}>Javis</span>
      </div>
      {isDesktop ? (
        <div className="javis-titlebar-controls">
          <button
            aria-label="娑堟伅鎻愮ず"
            className="notifications"
            onClick={handleNotifications}
            title="娑堟伅鎻愮ず"
            type="button"
          >
            <span aria-hidden="true" />
          </button>
          <button aria-label="Minimize" className="minimize" onClick={handleMinimize} type="button">
            <span aria-hidden="true" />
          </button>
          <button aria-label="Maximize" className="maximize" onClick={handleToggleMaximize} type="button">
            <span aria-hidden="true" />
          </button>
          <button aria-label="Close" className="close" onClick={handleClose} type="button">
            <span aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </header>
  );
}
