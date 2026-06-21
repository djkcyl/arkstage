interface Props {
  count: number;
  busy: boolean;
  /** Whether a download is currently visible (so we stack above its bar). */
  downloadActive: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

/**
 * Persistent batch-action bar shown whenever ≥1 story is selected. Sits above
 * the safe-area inset, and lifts above the global <DownloadBar> when a download
 * is in flight so both stay readable. Download/clear-all selection drive the
 * page's selection state; download/delete act on the selected page-titles.
 */
export default function SelectionBar({
  count,
  busy,
  downloadActive,
  onSelectAll,
  onClear,
  onDownload,
  onDelete,
}: Props) {
  if (count === 0) return null;
  return (
    <div className={`selection-bar ${downloadActive ? "above-download" : ""}`}>
      <span className="sel-count">
        已选 <strong>{count}</strong> 个剧情
      </span>
      <div className="sel-actions">
        <button className="sel-btn" onClick={onSelectAll}>
          全选
        </button>
        <button className="sel-btn" onClick={onClear}>
          清空
        </button>
        <button className="sel-btn primary" disabled={busy} onClick={onDownload}>
          ⬇ 批量下载
        </button>
        <button className="sel-btn danger" onClick={onDelete}>
          🗑 批量删除
        </button>
      </div>
    </div>
  );
}
