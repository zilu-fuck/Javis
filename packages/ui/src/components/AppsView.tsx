import { useState } from "react";
import type { WorkbenchAppEntry, WorkbenchLocale, WorkbenchProgress } from "../types";
import { ProgressBar } from "./ProgressBar";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface AppsViewProps {
  apps: WorkbenchAppEntry[];
  locale: WorkbenchLocale;
  loading?: boolean;
  progress?: WorkbenchProgress;
  error?: string;
  onRefresh?: () => void;
  onOpen?: (path: string) => void;
}

export function AppsView({
  apps,
  locale,
  loading,
  progress,
  error,
  onRefresh,
  onOpen,
}: AppsViewProps) {
  const labels = locale.labels;
  const [query, setQuery] = useState("");

  const filtered = apps.filter((app) =>
    app.name.toLowerCase().includes(query.toLowerCase()),
  );
  const actions = (
    <>
      <label className="javis-resource-search">
        <span aria-hidden="true">⌕</span>
        <input
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={labels.searchPlaceholder}
          value={query}
        />
      </label>
      <ResourceIconButton label={labels.retry} onClick={onRefresh}>⟳</ResourceIconButton>
      <div className="javis-resource-segment">
        <button className="active" type="button">☷</button>
        <button type="button">◷</button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.apps, apps.length)}
        icon="■"
        tabs={["全部应用", "办公学习", "影音娱乐", "系统应用"]}
        title={labels.apps}
      >
        <div className="javis-view-loading">
          <span className="javis-spinner" />
          <ProgressBar
            current={progress?.current}
            indeterminate={!progress}
            label={labels.scanInProgress}
            startedAt={progress?.startedAt}
            total={progress?.total}
          />
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.apps, apps.length)}
        icon="■"
        tabs={["全部应用", "办公学习", "影音娱乐", "系统应用"]}
        title={labels.apps}
      >
        <div className="javis-view-error">
          <p>{error}</p>
          <button onClick={onRefresh} type="button">
            {labels.retry}
          </button>
        </div>
      </ResourceShell>
    );
  }

  return (
    <ResourceShell
      actions={actions}
      countLabel={createCountLabel(labels.apps, filtered.length)}
      icon="■"
      tabs={["全部应用", "办公学习", "影音娱乐", "系统应用"]}
      title={labels.apps}
    >
      {filtered.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.noAppsFound}</p>
        </div>
      ) : (
        <div className="javis-app-grid">
          {filtered.map((app) => (
            <button
              className="javis-app-card"
              key={app.path}
              onClick={() => onOpen?.(app.path)}
              type="button"
            >
              <AppIcon app={app} />
              <span className="javis-app-name">{app.name}</span>
              {app.publisher && (
                <span className="javis-app-publisher">{app.publisher}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </ResourceShell>
  );
}

function AppIcon({ app }: { app: WorkbenchAppEntry }) {
  const [failed, setFailed] = useState(false);
  const initial = app.name.charAt(0).toUpperCase();

  if (app.iconPath && !failed) {
    return (
      <span className="javis-app-icon has-image">
        <img
          alt=""
          aria-hidden="true"
          onError={() => setFailed(true)}
          src={app.iconPath}
        />
      </span>
    );
  }

  return <span className="javis-app-icon">{initial}</span>;
}
