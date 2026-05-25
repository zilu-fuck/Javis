import { useState } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { formatModifiedTime, formatSize } from "../utils";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface DocumentsViewProps {
  documents: WorkbenchFileEntry[];
  locale: WorkbenchLocale;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onOpen?: (path: string) => void;
}

const FILTER_CHIPS = [
  { label: "全部文档", exts: ["docx", "doc", "pdf", "rtf", "odt"] },
  { label: "文档识别", exts: ["docx", "doc", "txt", "md", "rtf", "odt"] },
  { label: "课件", exts: ["pptx", "ppt", "pdf"] },
  { label: "书籍", exts: ["pdf", "epub"] },
  { label: "论文", exts: ["pdf", "docx"] },
];

export function DocumentsView({
  documents,
  locale,
  loading,
  error,
  onRefresh,
  onOpen,
}: DocumentsViewProps) {
  const labels = locale.labels;
  const [query, setQuery] = useState("");

  const filtered = documents.filter((doc) =>
    doc.name.toLowerCase().includes(query.toLowerCase()),
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
        <button type="button">▦</button>
        <button className="active" type="button">☷</button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="▣"
        title={labels.documents}
      >
        <div className="javis-view-loading">
          <span className="javis-spinner" />
          <span>{labels.scanInProgress}</span>
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="▣"
        title={labels.documents}
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
      countLabel={createCountLabel(labels.documents, filtered.length)}
      icon="▣"
      tabs={FILTER_CHIPS.map((chip) => chip.label)}
      title={labels.documents}
    >
      {filtered.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.noDocumentsFound}</p>
        </div>
      ) : (
        <table className="javis-doc-table">
          <thead>
            <tr>
              <th>{labels.documents}</th>
              <th>{labels.modified}</th>
              <th>{labels.status}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((doc) => (
              <tr key={doc.path}>
                <td>
                  <button
                    className="javis-doc-link"
                    onClick={() => onOpen?.(doc.path)}
                    type="button"
                  >
                    <span className="javis-doc-ext">
                      {doc.extension?.toUpperCase() ?? "?"}
                    </span>
                    {doc.name}
                  </button>
                </td>
                <td>
                  {doc.modifiedAt
                    ? formatModifiedTime(doc.modifiedAt)
                    : "—"}
                </td>
                <td>
                  {doc.sizeBytes != null ? formatSize(doc.sizeBytes) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ResourceShell>
  );
}
