import {
  ChevronLeft,
  Globe,
  PanelLeft,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { launchPreview, type PreviewEntry, type usePreviews } from "./previews";
import "./previews.css";

type Previews = ReturnType<typeof usePreviews>;
export function PreviewRows({
  entries,
  previews,
  onSelect,
}: {
  entries: PreviewEntry[];
  previews: Previews;
  onSelect: (id: string) => void;
}) {
  return entries.map((entry) => (
    <div
      className="preview-row"
      key={entry.id}
      data-selected={previews.selectedId === entry.id}
    >
      <button
        type="button"
        className="preview-row-open"
        aria-current={previews.selectedId === entry.id ? "page" : undefined}
        onClick={() => onSelect(entry.id)}
      >
        <Globe size={16} aria-hidden="true" />
        <span className="preview-row-label">
          <strong>{entry.name}</strong>
          <small>
            <span
              className="preview-status-dot"
              data-online={entry.available}
              role="img"
              aria-label={
                entry.available ? "Server available" : "Server unavailable"
              }
            />
            localhost:{entry.port}
          </small>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn preview-row-close"
        aria-label={`Close preview ${entry.name}`}
        title="Close preview (keep dev server running)"
        disabled={previews.closingIds.includes(entry.id)}
        onClick={() => void previews.close(entry.id)}
      >
        <X size={14} />
      </button>
    </div>
  ));
}
function PreviewFrame({
  entry,
  domain,
  refresh,
}: {
  entry: PreviewEntry;
  domain: string;
  refresh: number;
}) {
  const [loaded, setLoaded] = useState<{
    url: string;
    path: string;
    refresh: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  useEffect(() => {
    if (
      !entry.available ||
      (loadedRef.current?.path === entry.path &&
        loadedRef.current.refresh === refresh)
    )
      return;
    const controller = new AbortController();
    void launchPreview(
      entry.id,
      domain,
      AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
    )
      .then((url) => {
        if (!controller.signal.aborted) {
          setLoaded({ url, path: entry.path, refresh });
          setError(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not open preview. Try refreshing.");
      });
    return () => controller.abort();
  }, [domain, entry.available, entry.id, entry.path, refresh]);
  if (!loaded)
    return (
      <div className="preview-empty" role="status">
        <Globe size={26} />
        <strong>
          {error ??
            (entry.available
              ? "Opening preview…"
              : "Dev server is unavailable")}
        </strong>
        <span>
          {entry.available
            ? "Your application will appear here."
            : `Start localhost:${entry.port}; this preview will reconnect automatically.`}
        </span>
      </div>
    );
  return (
    <>
      <iframe
        className="preview-frame"
        title={`${entry.name} preview`}
        src={loaded.url}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
      />
      {error ? (
        <div className="preview-error" role="status">
          {error}
        </div>
      ) : null}
    </>
  );
}
export function PreviewSurface({
  previews,
  onBack,
  onMenu,
  compact,
  spaceLabel,
}: {
  previews: Previews;
  onBack: () => void;
  onMenu: () => void;
  compact: boolean;
  spaceLabel: string | null;
}) {
  const entry = previews.snapshot?.previews.find(
    (item) => item.id === previews.selectedId,
  );
  const [refreshes, setRefreshes] = useState<Record<string, number>>({});
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (previews.selectedId) backRef.current?.focus({ preventScroll: true });
  }, [previews.selectedId]);
  return (
    <section
      className="stage preview-stage"
      hidden={!entry}
      inert={!entry}
      aria-hidden={!entry}
      aria-label="Application preview"
    >
      <div className="stage-bar">
        <button
          className={`icon-btn ${compact ? "back-btn" : ""}`}
          type="button"
          aria-label={compact ? "Back to workspaces" : "Toggle sidebar"}
          title={compact ? "Back" : "Toggle sidebar"}
          onClick={onMenu}
        >
          {compact ? <ChevronLeft size={20} /> : <PanelLeft size={18} />}
        </button>
        <div className="stage-id preview-stage-id">
          <span className="stage-title">{entry?.name}</span>
          <span className="stage-sub">
            {spaceLabel ? `${spaceLabel} · ` : ""}localhost:{entry?.port}
            <span
              className="preview-status-dot"
              data-online={entry?.available ?? false}
              role="img"
              aria-label={
                entry?.available ? "Server available" : "Server unavailable"
              }
            />
          </span>
        </div>
        <div className="stage-actions">
          <button
            ref={backRef}
            className="icon-btn"
            type="button"
            aria-label="Return to terminal"
            title="Return to terminal"
            onClick={onBack}
          >
            <SquareTerminal size={17} />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Refresh preview"
            title="Refresh preview"
            disabled={!entry}
            onClick={() => {
              if (entry)
                setRefreshes((values) =>
                  Object.fromEntries(
                    (previews.snapshot?.previews ?? []).map((item) => [
                      item.id,
                      (values[item.id] ?? 0) + (item.id === entry.id ? 1 : 0),
                    ]),
                  ),
                );
              previews.refresh();
            }}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Close preview"
            title="Close preview (keep dev server running)"
            disabled={!entry || previews.closingIds.includes(entry.id)}
            onClick={() => {
              if (entry) void previews.close(entry.id);
            }}
          >
            <X size={17} />
          </button>
        </div>
      </div>
      {previews.error ? (
        <div className="preview-error" role="status">
          {previews.error}
        </div>
      ) : null}
      <div className="preview-content">
        {previews.retainedIds.map((id) => {
          const retained = previews.snapshot?.previews.find(
            (item) => item.id === id,
          );
          return retained && previews.snapshot ? (
            <div
              className="preview-slot"
              hidden={id !== previews.selectedId}
              inert={id !== previews.selectedId}
              aria-hidden={id !== previews.selectedId}
              key={id}
            >
              <PreviewFrame
                entry={retained}
                domain={previews.snapshot.domain}
                refresh={refreshes[id] ?? 0}
              />
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}
