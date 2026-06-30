import { useEffect, useRef, useState } from "react";
import { fetchWorkItemDetail, fetchWorkItemFeed } from "../api";
import type {
  DetailsBlock, DetailsSegment, WorkItemDetail, WorkItemFeedEntry,
} from "../types";
import { useLanguage, localeFor } from "../hooks/useLanguage";

interface WorkItemSheetProps {
  /** ADM_Work__c id (stack key) and the human work id for the fetch. */
  sheetId: string;
  workId: string;
  statusColor?: string;
  heightVh: number;
  tabsPinned: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onResize: (vh: number) => void;
  onToggleTabsPinned: () => void;
  /** Open the linked RMA case (only offered when the work item carries
   *  a Case__c link, which most FRA items don't). */
  onOpenLinkedCase?: (caseNumber: string) => void;
}

// Work-item status palette — mirrors WorkItemsSection so the accent is
// consistent between the list and the open sheet. Distinct from the RMA
// statusColors map (different vocabulary).
const WI_STATUS_COLORS: Record<string, string> = {
  "New": "#94A3B8",
  "Triaged": "#A3E635",
  "In Progress": "#38BDF8",
  "QA In Progress": "#818CF8",
  "Waiting": "#F59E0B",
  "Fixed": "#34D399",
  "Closed": "#6B7280",
};

function wiColor(status: string): string {
  return WI_STATUS_COLORS[status] ?? "#9CA3AF";
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  // Date-only display; the time component on Due/Created is noise here.
  return iso.slice(0, 10);
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  // History rows want the day + minute the change landed.
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Render one inline run of rich-text — an embedded image (loaded through
 *  the backend ContentDocument proxy; the id was 069…-whitelisted
 *  server-side), a link (real <a>, never raw HTML; href was
 *  http/https-validated server-side), or plain text, optionally bold. */
function Seg({ seg }: { seg: DetailsSegment }) {
  if (seg.imageId) {
    return (
      <img
        src={`/api/work-item-image/${seg.imageId}`}
        alt={seg.text}
        loading="lazy"
        className="max-w-full rounded border border-soft my-1"
      />
    );
  }
  const inner = seg.bold ? <strong>{seg.text}</strong> : seg.text;
  if (seg.href) {
    return (
      <a
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-600 dark:text-sky-400 hover:underline"
      >
        {inner}
      </a>
    );
  }
  return <>{inner}</>;
}

/** Join a run of segments with spaces between them. */
function Segs({ segs }: { segs: DetailsSegment[] }) {
  return (
    <>
      {segs.map((s, i) => (
        <span key={i}>
          <Seg seg={s} />
          {i < segs.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

/** Render one structured Details block: paragraph, heading, list, or the
 *  asset tables GUS work items routinely carry. */
function DetailsBlockView({ block }: { block: DetailsBlock }) {
  switch (block.kind) {
    case "h":
      return (
        <h3 className="text-sm font-semibold mt-3">
          <Segs segs={block.segments} />
        </h3>
      );
    case "ul":
    case "ol": {
      const cls = block.kind === "ul" ? "list-disc" : "list-decimal";
      return (
        <ul className={`${cls} pl-5 space-y-1`}>
          {block.items.map((item, i) => (
            <li key={i}><Segs segs={item} /></li>
          ))}
        </ul>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse">
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const Cell = ri === 0 ? "th" : "td";
                    return (
                      <Cell
                        key={ci}
                        className="border border-soft px-2 py-1 text-left align-top whitespace-nowrap"
                      >
                        <Segs segs={cell} />
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default: // "p"
      return (
        <p className="whitespace-pre-wrap"><Segs segs={block.segments} /></p>
      );
  }
}

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2)
    .join("").toUpperCase() || "?";
}

function FeedAvatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        className="w-7 h-7 rounded-full object-cover surface-2 shrink-0 mt-0.5"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center w-7 h-7 rounded-full surface-2 text-[10px] font-medium shrink-0 mt-0.5"
    >
      {initials(name)}
    </span>
  );
}

/** One feed entry — a post, a threaded comment, or a tracked field change.
 *  Read-only (no compose/edit; writing to a work item is a future
 *  writes-gated feature). */
function FeedEntryView({ entry, locale }: {
  entry: WorkItemFeedEntry;
  locale: string;
}) {
  const when = new Date(entry.at).toLocaleString(locale, {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return (
    <div className="flex items-start gap-2">
      <FeedAvatar name={entry.author} photoUrl={entry.authorPhotoUrl} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.author}</span>
          <span className="opacity-50 text-[10px]">{when}</span>
        </div>
        {entry.kind === "trackedChange" ? (
          <div className="text-xs mt-1">
            <span className="opacity-60">{entry.fieldLabel}:</span>{" "}
            {entry.fromValue ? (
              <>
                <span className="pill surface-1 text-[10px]">{entry.fromValue}</span>
                <span className="mx-1 opacity-50">→</span>
              </>
            ) : null}
            <span className="pill surface-2 text-[10px]">{entry.toValue || "—"}</span>
          </div>
        ) : (
          <div className="text-sm mt-0.5 space-y-1 break-words">
            {entry.blocks.length === 0 ? (
              <span className="opacity-50">—</span>
            ) : (
              entry.blocks.map((b, i) => <DetailsBlockView key={i} block={b} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The right-hand feed column: top-level entries newest-first, comments
 *  threaded one level under their parent (oldest-first, like GUS). */
function FeedColumn({ entries, loading, t, locale }: {
  entries: WorkItemFeedEntry[];
  loading: boolean;
  t: ReturnType<typeof useLanguage>["t"];
  locale: string;
}) {
  const ids = new Set(entries.map((e) => e.id));
  const repliesByParent: Record<string, WorkItemFeedEntry[]> = {};
  const topLevel: WorkItemFeedEntry[] = [];
  for (const e of entries) {
    if (e.kind === "comment" && e.parentId && ids.has(e.parentId)) {
      (repliesByParent[e.parentId] ||= []).push(e);
    } else {
      topLevel.push(e);
    }
  }
  for (const k of Object.keys(repliesByParent)) {
    repliesByParent[k].sort((a, b) => a.at.localeCompare(b.at));
  }
  return (
    <div className="space-y-4">
      <h3 className="text-xs uppercase tracking-wide opacity-50">
        {t("workItemSheet.feed")}
      </h3>
      {loading && entries.length === 0 && (
        <p className="text-sm opacity-60">{t("workItemSheet.feedLoading")}</p>
      )}
      {!loading && entries.length === 0 && (
        <p className="text-sm opacity-60">{t("workItemSheet.feedEmpty")}</p>
      )}
      {topLevel.map((e) => (
        <div key={e.id} className="space-y-2">
          <FeedEntryView entry={e} locale={locale} />
          {(repliesByParent[e.id] || []).length > 0 && (
            <div className="ml-9 space-y-2 border-l border-soft pl-3">
              {repliesByParent[e.id].map((r) => (
                <FeedEntryView key={r.id} entry={r} locale={locale} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** One labelled field in the work-item sheet. */
function Field({ label, value, mono }: {
  label: string; value: string; mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs opacity-50">{label}</span>
      <span className={mono ? "font-mono text-sm" : "text-sm"}>
        {value || "—"}
      </span>
    </div>
  );
}

export function WorkItemSheet({
  // sheetId is the caller's stack key; the sheet itself doesn't read it.
  workId, statusColor, heightVh, tabsPinned,
  onClose, onMinimize, onResize, onToggleTabsPinned, onOpenLinkedCase,
}: WorkItemSheetProps) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const dragRef = useRef<HTMLDivElement | null>(null);
  const startState = useRef<{ y: number; vh: number } | null>(null);
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [feed, setFeed] = useState<WorkItemFeedEntry[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);

  // Drag-to-resize — identical mechanic to CaseDetailSheet so both
  // sheet kinds feel the same and share the persisted preferred height.
  useEffect(() => {
    const handle = dragRef.current;
    if (!handle) return;
    function onPointerDown(e: PointerEvent) {
      startState.current = { y: e.clientY, vh: heightVh };
      handle?.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function onPointerMove(e: PointerEvent) {
      if (!startState.current) return;
      const dy = startState.current.y - e.clientY;
      const dvh = (dy / window.innerHeight) * 100;
      onResize(startState.current.vh + dvh);
    }
    function onPointerUp(e: PointerEvent) {
      if (!startState.current) return;
      handle?.releasePointerCapture(e.pointerId);
      startState.current = null;
    }
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }, [heightVh, onResize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setFeed([]);
    fetchWorkItemDetail(workId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        // Feed lookup needs the SF id, which the detail response carries.
        setFeedLoading(true);
        fetchWorkItemFeed(res.id)
          .then((f) => { if (!cancelled) setFeed(f.entries); })
          .catch(() => { /* feed is best-effort; sheet still works */ })
          .finally(() => { if (!cancelled) setFeedLoading(false); });
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workId]);

  const accent = statusColor
    ?? (detail ? wiColor(detail.status) : "var(--text-muted)");

  return (
    <div
      className="fixed left-0 right-0 bottom-0 solid-panel shadow-2xl flex flex-col"
      style={{ height: `${heightVh}vh`, zIndex: 1800 }}
      role="dialog"
      aria-label={t("workItemSheet.title", { workId })}
    >
      {/* Resize handle */}
      <div
        ref={dragRef}
        className="absolute left-0 right-0 -top-1 h-3 cursor-ns-resize"
        style={{ touchAction: "none" }}
        aria-hidden
      />
      {/* Header */}
      <header
        className="flex items-center gap-3 px-5 py-3 border-b border-soft shrink-0"
        style={{ borderTop: `3px solid ${accent}` }}
      >
        <span className="text-xs uppercase tracking-wide opacity-50 shrink-0">
          {t("workItemSheet.badge")}
        </span>
        <span className="font-mono text-base font-semibold">{workId}</span>
        {detail && (
          <span
            className="inline-block rounded px-2 py-0.5 text-xs font-medium"
            style={{ background: `${accent}22`, color: accent }}
          >
            {detail.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <a
            href={detail?.gusUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pill px-3 py-1.5 text-sm"
            title={t("workItems.openInGus")}
          >
            {t("workItems.openInGus")}
          </a>
          <button
            type="button"
            onClick={onToggleTabsPinned}
            className="pill surface-1-hover w-8 h-8 flex items-center justify-center text-xs"
            title={t("sheet.pinTabs")}
            aria-pressed={tabsPinned}
          >
            📌
          </button>
          <button
            type="button"
            onClick={onMinimize}
            className="pill surface-1-hover w-8 h-8 flex items-center justify-center"
            title={t("sheet.minimize")}
            aria-label={t("sheet.minimize")}
          >
            —
          </button>
          <button
            type="button"
            onClick={onClose}
            className="pill surface-1-hover w-8 h-8 flex items-center justify-center"
            title={t("sheet.close")}
            aria-label={t("sheet.close")}
          >
            ✕
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && (
          <p className="text-sm opacity-60">{t("workItemSheet.loading")}</p>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {t("workItemSheet.error")}
          </p>
        )}
        {detail && !loading && !error && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-8">
          <div className="space-y-5 min-w-0">
            <h2 className="text-lg font-semibold leading-snug">
              {detail.subject || "—"}
            </h2>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4">
              <Field label={t("workItemSheet.type")} value={detail.type} />
              <Field label={t("workItemSheet.priority")} value={detail.priority} />
              <Field label={t("workItemSheet.storyStatus")} value={detail.storyStatus} />
              <Field
                label={t("workItemSheet.storyPoints")}
                value={detail.storyPoints != null ? String(detail.storyPoints) : ""}
                mono
              />
              <Field label={t("workItems.colTeam")} value={detail.team} />
              <Field label={t("workItems.colAssignee")} value={detail.assignee} />
              <Field label={t("workItemSheet.productOwner")} value={detail.productOwner} />
              <Field label={t("workItemSheet.qaEngineer")} value={detail.qaEngineer} />
              <Field label={t("workItemSheet.sprint")} value={detail.sprint} mono />
              <Field label={t("workItemSheet.epic")} value={detail.epic} />
              <Field label={t("workItemSheet.productTag")} value={detail.productTag} mono />
              {detail.theme && (
                <Field label={t("workItemSheet.theme")} value={detail.theme} />
              )}
              <Field
                label={t("workItemSheet.age")}
                value={detail.ageDays != null ? t("workItemSheet.days", { n: String(Math.round(detail.ageDays)) }) : ""}
                mono
              />
              <Field
                label={t("workItemSheet.daysInProgress")}
                value={detail.daysInProgress != null ? t("workItemSheet.days", { n: String(Math.round(detail.daysInProgress)) }) : ""}
                mono
              />
              <Field label={t("workItemSheet.dueDate")} value={fmtDate(detail.dueDate)} mono />
              <Field label={t("workItemSheet.created")} value={fmtDate(detail.createdDate)} mono />
            </div>

            {detail.caseNumber && (
              <div>
                <span className="text-xs opacity-50">
                  {t("workItemSheet.linkedCase")}
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => onOpenLinkedCase?.(detail.caseNumber)}
                    className="font-mono text-sm text-sky-600 dark:text-sky-400 hover:underline"
                  >
                    {detail.caseNumber}
                  </button>
                </div>
              </div>
            )}

            <div>
              <span className="text-xs opacity-50">
                {t("workItemSheet.details")}
              </span>
              {detail.detailsBlocks.length === 0 ? (
                <p className="text-sm mt-1 opacity-90">—</p>
              ) : (
                <div className="text-sm mt-1 opacity-90 space-y-2">
                  {detail.detailsBlocks.map((block, bi) => (
                    <DetailsBlockView key={bi} block={block} />
                  ))}
                </div>
              )}
            </div>

            {/* Status-Verlauf — tracked field changes, newest first. */}
            <div>
              <span className="text-xs opacity-50">
                {t("workItemSheet.history")}
              </span>
              {detail.history.length === 0 ? (
                <p className="text-sm opacity-60 mt-1">
                  {t("workItemSheet.historyEmpty")}
                </p>
              ) : (
                <ol className="mt-2 space-y-2 border-l border-soft pl-4">
                  {detail.history.map((h, i) => {
                    // Colour the dot by the new status where the change is a
                    // status move; neutral otherwise.
                    const dot =
                      h.field === "Status" ? wiColor(h.newValue) : "var(--text-muted)";
                    return (
                      <li key={i} className="relative text-sm">
                        <span
                          className="absolute -left-[1.3rem] top-1 w-2 h-2 rounded-full"
                          style={{ background: dot }}
                          aria-hidden
                        />
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{h.field}</span>
                          <span className="opacity-80">
                            {h.oldValue ? `${h.oldValue} → ` : ""}
                            <span className="font-medium">{h.newValue || "—"}</span>
                          </span>
                        </div>
                        <div className="text-xs opacity-50">
                          {fmtDateTime(h.at)}
                          {h.by ? ` · ${t("workItemSheet.historyBy", { name: h.by })}` : ""}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>

          {/* Right column: the work item's Chatter feed (read-only). */}
          <div className="min-w-0 lg:border-l lg:border-soft lg:pl-6">
            <FeedColumn entries={feed} loading={feedLoading} t={t} locale={locale} />
          </div>
          </div>
        )}
      </div>
    </div>
  );
}
