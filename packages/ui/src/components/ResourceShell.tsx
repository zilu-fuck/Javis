import type { ReactNode } from "react";

interface ResourceShellProps {
  title: string;
  icon: string;
  countLabel?: string;
  tabs?: string[];
  activeTabIndex?: number;
  onTabChange?: (index: number) => void;
  actions?: ReactNode;
  addLabel?: string;
  onAdd?: () => void;
  onBack?: () => void;
  children: ReactNode;
}

export function ResourceShell({
  title,
  icon,
  countLabel,
  tabs,
  activeTabIndex = 0,
  onTabChange,
  actions,
  addLabel = "Add",
  onAdd,
  onBack,
  children,
}: ResourceShellProps) {
  const shouldShowIcon = icon.trim() !== "" && icon.trim() !== "#";

  return (
    <section className="javis-resource-shell">
      <header className="javis-resource-header">
        <div className="javis-resource-pathbar">
          <button
            className="javis-resource-back"
            disabled={!onBack}
            onClick={onBack}
            type="button"
            aria-label="Back"
          >
            &lt;
          </button>
          <div className="javis-resource-pill">
            {shouldShowIcon ? (
              <span className="javis-resource-pill-icon" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <span>{title}</span>
          </div>
          {onAdd && (
            <button className="javis-resource-add" onClick={onAdd} type="button" aria-label={addLabel} title={addLabel}>
              +
            </button>
          )}
        </div>
        {actions && <div className="javis-resource-actions">{actions}</div>}
      </header>
      <div className="javis-resource-body">
        <div className="javis-resource-kicker">
          <strong>{countLabel ?? title}</strong>
          {tabs && (
            <nav className="javis-resource-tabs" aria-label={title} role="tablist">
              {tabs.map((tab, index) => (
                <button
                  aria-selected={index === activeTabIndex}
                  className={index === activeTabIndex ? "active" : ""}
                  key={tab}
                  onClick={() => onTabChange?.(index)}
                  role="tab"
                  type="button"
                >
                  {tab}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="javis-resource-content" key={activeTabIndex}>
          {children}
        </div>
      </div>
    </section>
  );
}

export function ResourceIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="javis-resource-icon-button"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

export function createCountLabel(title: string, count: number) {
  return `${title}(${count.toLocaleString()})`;
}
