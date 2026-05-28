import type { ReactNode } from "react";

interface ResourceShellProps {
  title: string;
  icon: string;
  countLabel?: string;
  tabs?: string[];
  actions?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}

export function ResourceShell({
  title,
  icon,
  countLabel,
  tabs,
  actions,
  onBack,
  children,
}: ResourceShellProps) {
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
            <span className="javis-resource-pill-icon" aria-hidden="true">
              {icon}
            </span>
            <span>{title}</span>
          </div>
          <button className="javis-resource-add" type="button" aria-label="Add">
            +
          </button>
        </div>
        {actions && <div className="javis-resource-actions">{actions}</div>}
      </header>
      <div className="javis-resource-body">
        <div className="javis-resource-kicker">
          <strong>{countLabel ?? title}</strong>
          {tabs && (
            <nav className="javis-resource-tabs" aria-label={title}>
              {tabs.map((tab, index) => (
                <button
                  className={index === 0 ? "active" : ""}
                  key={tab}
                  type="button"
                >
                  {tab}
                </button>
              ))}
            </nav>
          )}
        </div>
        {children}
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
