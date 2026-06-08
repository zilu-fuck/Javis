import { useState } from "react";

export interface ScanRootItem {
  id: string;
  path: string;
  label?: string;
  kinds: Array<"documents" | "images">;
  enabled: boolean;
  source: "default" | "custom";
}

interface DirectoryPanelProps {
  roots: ScanRootItem[];
  activeKind: "documents" | "images";
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: (path: string) => void;
  onRefresh: (id: string) => void;
  onClose: () => void;
}

const KIND_LABELS: Record<string, string> = {
  documents: "文档",
  images: "图片",
};

export function DirectoryPanel({
  roots,
  activeKind,
  onToggle,
  onRemove,
  onAdd,
  onRefresh,
  onClose,
}: DirectoryPanelProps) {
  const [addPath, setAddPath] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const defaultRoots = roots.filter((r) => r.source === "default");
  const customRoots = roots.filter((r) => r.source === "custom");

  function handleAdd() {
    const trimmed = addPath.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setAddPath("");
    setShowAdd(false);
  }

  return (
    <div className="javis-directory-panel">
      <div className="javis-directory-panel-header">
        <strong>扫描目录管理</strong>
        <button aria-label="关闭目录面板" onClick={onClose} type="button">
          ×
        </button>
      </div>

      <div className="javis-directory-panel-body">
        {defaultRoots.length > 0 && (
          <div className="javis-directory-section">
            <div className="javis-directory-section-title">默认目录</div>
            {defaultRoots.map((root) => (
              <DirectoryRow
                key={root.id}
                root={root}
                activeKind={activeKind}
                onToggle={onToggle}
                onRemove={onRemove}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        )}

        {customRoots.length > 0 && (
          <div className="javis-directory-section">
            <div className="javis-directory-section-title">自定义目录</div>
            {customRoots.map((root) => (
              <DirectoryRow
                key={root.id}
                root={root}
                activeKind={activeKind}
                onToggle={onToggle}
                onRemove={onRemove}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        )}

        {showAdd ? (
          <div className="javis-directory-add-form">
            <input
              className="javis-directory-add-input"
              onChange={(e) => setAddPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") setShowAdd(false);
              }}
              placeholder="输入目录路径..."
              value={addPath}
            />
            <button onClick={handleAdd} type="button">确定</button>
            <button onClick={() => setShowAdd(false)} type="button">取消</button>
          </div>
        ) : (
          <button
            className="javis-directory-add-button"
            onClick={() => setShowAdd(true)}
            type="button"
          >
            + 添加目录
          </button>
        )}
      </div>
    </div>
  );
}

function DirectoryRow({
  root,
  activeKind,
  onToggle,
  onRemove,
  onRefresh,
}: {
  root: ScanRootItem;
  activeKind: "documents" | "images";
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const kindLabels = root.kinds.map((k) => KIND_LABELS[k] ?? k).join("+");
  const relevantToActive = root.kinds.includes(activeKind);

  return (
    <div className={`javis-directory-row${!relevantToActive ? " javis-directory-row--other" : ""}`}>
      <label className="javis-directory-check">
        <input
          checked={root.enabled}
          onChange={(e) => onToggle(root.id, e.currentTarget.checked)}
          type="checkbox"
        />
        <span className="javis-directory-path" title={root.path}>
          {root.label ?? root.path}
        </span>
      </label>
      <span className="javis-directory-kinds">{kindLabels}</span>
      <div className="javis-directory-actions">
        <button
          aria-label={`刷新 ${root.label ?? root.path}`}
          onClick={() => onRefresh(root.id)}
          title="刷新此目录"
          type="button"
        >
          ↻
        </button>
        {root.source === "custom" && (
          <button
            aria-label={`移除 ${root.label ?? root.path}`}
            onClick={() => onRemove(root.id)}
            title="移除此目录"
            type="button"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
