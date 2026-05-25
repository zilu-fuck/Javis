import { useState } from "react";
import type { WorkbenchLocale } from "../types";
import { formatWorkspaceName } from "../utils";

interface WorkspaceContextProps {
  currentWorkspacePath: string;
  labels: WorkbenchLocale["labels"];
  recentWorkspacePaths: string[];
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function WorkspaceContext({
  currentWorkspacePath,
  labels,
  recentWorkspacePaths,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: WorkspaceContextProps) {
  const [workspaceBrowseError, setWorkspaceBrowseError] = useState(false);

  async function handleBrowseWorkspace() {
    setWorkspaceBrowseError(false);
    try {
      await onBrowseWorkspacePath?.();
    } catch {
      setWorkspaceBrowseError(true);
    }
  }

  return (
    <div className="javis-workspace-context" aria-label={labels.currentWorkspace}>
      <details className="javis-workspace-menu">
        <summary title={currentWorkspacePath || labels.workspacePathPlaceholder}>
          <span className="javis-workspace-glyph">▱</span>
          <span>{formatWorkspaceName(currentWorkspacePath) || labels.currentWorkspace}</span>
          <span className="javis-workspace-chevron">⌄</span>
        </summary>
        <div className="javis-workspace-popover">
          <label>
            <span>{labels.currentWorkspace}</span>
            <input
              aria-label={labels.currentWorkspace}
              onChange={(event) => onWorkspacePathChange?.(event.currentTarget.value)}
              placeholder={labels.workspacePathPlaceholder}
              value={currentWorkspacePath}
            />
          </label>
          <div className="javis-workspace-actions">
            <button
              disabled={!currentWorkspacePath.trim()}
              onClick={() => onUseWorkspacePath?.(currentWorkspacePath)}
              type="button"
            >
              {labels.useWorkspace}
            </button>
            <button onClick={handleBrowseWorkspace} type="button">
              {labels.browseWorkspace}
            </button>
          </div>
          {workspaceBrowseError ? (
            <p role="alert">{labels.workspaceBrowseError}</p>
          ) : null}
          {recentWorkspacePaths.length > 0 ? (
            <div className="javis-workspace-recent">
              <p>{labels.recentWorkspaces}</p>
              {recentWorkspacePaths.map((path) => (
                <div className="javis-workspace-recent-entry" key={path}>
                  <button
                    onClick={() => onUseWorkspacePath?.(path)}
                    title={path}
                    type="button"
                  >
                    {path}
                  </button>
                  <button
                    aria-label={`${labels.removeWorkspace}: ${path}`}
                    onClick={() => onDeleteRecentWorkspacePath?.(path)}
                    title={labels.removeWorkspace}
                    type="button"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
