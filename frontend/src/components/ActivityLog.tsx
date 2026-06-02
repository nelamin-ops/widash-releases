import { useMemo, useRef, useState } from "react";
import type { ActivityEvent, ActivityFilter, RmaTicket } from "../types";
import { useSort } from "../hooks/useSort";
import { useGenericColumnConfig } from "../hooks/useColumnConfig";
import { SortHeader } from "./SortHeader";
import { IconButton } from "./IconButton";
import { TruncatedCell } from "./TruncatedCell";
import { ColumnManagerPanel } from "./ColumnManagerPanel";
import {
  ACTIVITY_COLUMNS, ACTIVITY_COLUMN_INDEX, ACTIVITY_DEFAULT_ORDER,
  type ActivityColumnDef, type ActivityColumnId,
} from "./activityColumns";
import {
  useLanguage, localeFor, type TranslationKey,
} from "../hooks/useLanguage";
import { colorForStatus, STATUS_COLORS } from "../statusColors";

type Anchor = { x: number; y: number };

interface MeIdentity {
  id: string;
  username: string;
  name: string;
}

interface ActivityLogProps {
  events: ActivityEvent[];
  filter: ActivityFilter;
  onFilterChange: (f: ActivityFilter) => void;
  onOpenText: (id: string, title: string, text: string, anchor: Anchor) => void;
  /** Look up the active ticket record for a given Salesforce case Id.
   *  Activity events on still-open cases route through this so a click
   *  on the case number opens the same case-detail tab as the donut →
   *  details-table → tab path. Closed/RTS cases miss and stay un-clickable. */
  onLookupTicket?: (caseSfId: string) => RmaTicket | undefined;
  onOpenTicket?: (ticket: RmaTicket) => void;
  /** Active Salesforce user — used by the "Me" filter so it works for
   *  any engineer running the dashboard without hardcoding a username. */
  me?: MeIdentity | null;
  includeBots: boolean;
  onToggleIncludeBots: () => void;
}

const WORK_HOUR_START = 9;
const WORK_HOUR_END = 17;

function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleString(locale, {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function isOutsideWorkHours(iso: string): boolean {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0 || day === 6) return true;
  const hour = d.getHours();
  return hour < WORK_HOUR_START || hour >= WORK_HOUR_END;
}

function gusUrl(sfId: string): string {
  return `https://gus.lightning.force.com/lightning/r/Case/${sfId}/view`;
}

const ACTIVITY_KNOWN_IDS = new Set<ActivityColumnId>(
  ACTIVITY_COLUMNS.map((c) => c.id),
);

const ALL_STATUSES = Object.keys(STATUS_COLORS);

export function ActivityLog({
  events, filter, onFilterChange, onOpenText,
  onLookupTicket, onOpenTicket,
  me,
  includeBots, onToggleIncludeBots,
}: ActivityLogProps) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const filters: { key: ActivityFilter; label: string }[] = [
    { key: "all", label: t("activity.filterAll") },
    { key: "status_change", label: t("activity.filterStatus") },
    { key: "comment", label: t("activity.filterComment") },
  ];

  const {
    order, hidden, visibleColumns,
    toggleVisibility, reorder, reset,
  } = useGenericColumnConfig<ActivityColumnId>(
    "activity", ACTIVITY_DEFAULT_ORDER, ACTIVITY_KNOWN_IDS,
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsBtnRef = useRef<HTMLButtonElement | null>(null);
  // Empty selectedStatuses == no status filter applied. We store as Set
  // for cheap lookups while filtering.
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [commentQuery, setCommentQuery] = useState("");
  const [meOnly, setMeOnly] = useState(false);
  const [ticketQuery, setTicketQuery] = useState("");

  const handleToggleVisibility = (id: ActivityColumnId) => {
    if (ACTIVITY_COLUMN_INDEX[id].pinned) return;
    toggleVisibility(id);
  };

  // Apply filter pills (status set) + comment text search BEFORE
  // sorting so a non-matching event doesn't cost cycles in the
  // sort accessors.
  // Identity tokens used by the "Me" filter: lowercase username,
  // display name, and the bare username before the @ — covers the
  // various shapes the report cell carries (e.g. "nelamin@gus.com",
  // "@nelamin", "Najih El Amin").
  const meTokens = useMemo(() => {
    if (!me) return [] as string[];
    const set = new Set<string>();
    if (me.username) set.add(me.username.toLowerCase());
    if (me.username?.includes("@")) {
      set.add(me.username.split("@")[0].toLowerCase());
    }
    if (me.name) set.add(me.name.toLowerCase());
    return [...set].filter(Boolean);
  }, [me]);

  const filteredEvents = useMemo(() => {
    // Ticket-id search short-circuits everything else. Once the user
    // commits to a specific ticket, the other filters are irrelevant
    // — they want the full timeline for that one case, newest first.
    const ticketQ = ticketQuery.trim().toLowerCase();
    if (ticketQ) {
      return events.filter(
        (e) => (e.ticketId || "").toLowerCase().includes(ticketQ),
      );
    }
    const q = commentQuery.trim().toLowerCase();
    return events.filter((e) => {
      if (selectedStatuses.size > 0) {
        if (!e.caseStatus || !selectedStatuses.has(e.caseStatus)) return false;
      }
      if (q) {
        // Search restricted to comment events; status changes drop out
        // because they have no comment body.
        if (e.type !== "comment") return false;
        const body = (e.commentText || "").toLowerCase();
        if (!body.includes(q)) return false;
      }
      if (meOnly) {
        // "Me" = I'm the actor OR I was @-mentioned. Both signals come
        // from the backend so this works for any engineer without a
        // hardcoded username here.
        const actor = (e.actor || "").toLowerCase();
        const isMine = meTokens.some((tok) => actor.includes(tok));
        if (!isMine && !e.mentionsMe) return false;
      }
      return true;
    });
  }, [events, selectedStatuses, commentQuery, meOnly, meTokens, ticketQuery]);

  const accessors = Object.fromEntries(
    visibleColumns
      .map((id) => {
        const def = ACTIVITY_COLUMN_INDEX[id];
        if (!def.sortable || !def.accessor) return [id, undefined];
        return [id, def.accessor];
      })
      .filter(([, a]) => Boolean(a)),
  ) as Record<ActivityColumnId, (e: ActivityEvent) => unknown>;

  const { sorted, sort, toggle } = useSort<ActivityEvent, ActivityColumnId>(
    filteredEvents, { key: "timestamp", dir: "desc" }, accessors,
  );

  const headerCell = (col: ActivityColumnDef) => {
    if (!col.sortable) {
      return <span className="opacity-60">{t(col.i18nKey as TranslationKey)}</span>;
    }
    return (
      <SortHeader
        label={t(col.i18nKey as TranslationKey)}
        active={sort.key === col.id}
        dir={sort.dir}
        onToggle={() => toggle(col.id)}
        align={col.alignRight ? "right" : "left"}
      />
    );
  };

  function tryOpenTicket(e: ActivityEvent) {
    if (!onLookupTicket || !onOpenTicket) return;
    const ticket = onLookupTicket(e.ticketSfId);
    if (ticket) onOpenTicket(ticket);
  }

  function toggleStatus(s: string) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const renderCell = (col: ActivityColumnDef, e: ActivityEvent) => {
    const outside = isOutsideWorkHours(e.timestamp);
    const isNewCase = e.type === "status_change" && e.toStatus === "New";
    const mentionsMe = !!e.mentionsMe;

    switch (col.id) {
      case "timestamp":
        return (
          <span className="tabular-nums whitespace-nowrap">
            <span className="opacity-80">{formatDateTime(e.timestamp, locale)}</span>
            {isNewCase && (
              <span
                className="ml-2 pill bg-emerald-500/25 text-emerald-700 dark:text-emerald-200 text-[10px] px-2 py-0.5 font-medium"
                title={t("activity.newCase")}
              >
                ★ NEW
              </span>
            )}
            {mentionsMe && (
              <span
                className="ml-2 pill bg-fuchsia-500/25 text-fuchsia-700 dark:text-fuchsia-200 text-[10px] px-2 py-0.5"
                title={t("activity.mentionsMe")}
              >
                @
              </span>
            )}
            {outside && (
              <span
                className="ml-2 pill bg-amber-500/25 text-amber-700 dark:text-amber-200 text-[10px] px-2 py-0.5"
                title={t("activity.outsideHours", { start: `${WORK_HOUR_START}:00`, end: `${WORK_HOUR_END}:00` })}
              >
                ⏰
              </span>
            )}
          </span>
        );
      case "ticketId": {
        const statusForColor = e.caseStatus
          ?? (e.type === "status_change" ? e.toStatus ?? null : null);
        const color = colorForStatus(statusForColor);
        const ticket = onLookupTicket?.(e.ticketSfId);
        if (ticket) {
          return (
            <button
              type="button"
              onClick={() => tryOpenTicket(e)}
              className="font-mono whitespace-nowrap hover:underline cursor-pointer text-left"
              style={{ color }}
              title={`${t("sheet.restore")} · ${e.ticketId}`}
            >
              {e.ticketId}
            </button>
          );
        }
        return (
          <span
            className="font-mono whitespace-nowrap"
            style={{ color }}
            title={e.ticketId}
          >
            {e.ticketId}
          </span>
        );
      }
      case "location":
        return <span className="pill surface-1 text-xs">{e.location}</span>;
      case "event":
        if (e.type === "status_change") {
          return (
            <span className="whitespace-nowrap">
              <span className="opacity-60">{t("activity.eventStatus")}</span>{" "}
              <span className="pill surface-1 text-xs">{e.fromStatus ?? "—"}</span>
              <span className="mx-1 opacity-50">→</span>
              <span className="pill surface-2 text-xs">{e.toStatus ?? "—"}</span>
            </span>
          );
        }
        return (
          <TruncatedCell
            id={`comment:${e.id}`}
            title={t("activity.commentTooltipTitle", { ticketId: e.ticketId })}
            text={
              e.commentText
                ? `${t("activity.eventComment")} "${e.commentText}"`
                : ""
            }
            onOpen={(id, title, _text, anchor) =>
              onOpenText(id, title, e.commentText ?? "", anchor)
            }
            className="italic"
          />
        );
      case "actor":
        return (
          <TruncatedCell
            id={`actor:${e.id}`}
            title={`${t("activity.colActor")} · ${e.ticketId}`}
            text={e.actor}
            onOpen={onOpenText}
          />
        );
      case "gus":
        return (
          <a
            href={gusUrl(e.ticketSfId)}
            target="_blank"
            rel="noreferrer"
            aria-label={t("common.openInGus")}
            title={t("common.openInGus")}
            className="pill surface-1-hover"
          >
            ↗
          </a>
        );
    }
  };

  return (
    <div className="glass p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-lg font-medium">
          {t("activity.title")}
          <span className="ml-2 text-xs opacity-60">
            {t("activity.outsideHint", { start: `${WORK_HOUR_START}:00`, end: `${WORK_HOUR_END}:00` })}
          </span>
        </h2>
        <div className="flex gap-2 items-center flex-wrap">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`pill ${
                filter === f.key
                  ? "surface-3 active"
                  : "surface-1 surface-1-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
          {me && (
            <button
              type="button"
              onClick={() => setMeOnly((v) => !v)}
              aria-pressed={meOnly}
              title={t("activity.filterMeTitle", { name: me.name })}
              className={`pill ${
                meOnly
                  ? "surface-3 active"
                  : "surface-1 surface-1-hover"
              }`}
            >
              {t("activity.filterMe")}
            </button>
          )}
          <span className="opacity-30 mx-1">·</span>
          {/* Status filter — opens a dropdown of pills, multi-select. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setStatusMenuOpen((v) => !v)}
              aria-expanded={statusMenuOpen}
              className={`pill ${
                selectedStatuses.size > 0
                  ? "surface-3 active"
                  : "surface-1 surface-1-hover"
              }`}
              title={t("activity.statusFilter")}
            >
              {t("activity.statusFilter")}
              {selectedStatuses.size > 0 && (
                <span className="ml-1 opacity-80">({selectedStatuses.size})</span>
              )}
            </button>
            {statusMenuOpen && (
              <>
                {/* Click-outside catcher — clicks anywhere else close
                    the menu without affecting the parent layout. */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setStatusMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="solid-panel absolute right-0 mt-1 p-2 z-50 min-w-[260px]"
                >
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-xs uppercase tracking-wide opacity-60">
                      {t("activity.statusFilter")}
                    </span>
                    {selectedStatuses.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedStatuses(new Set())}
                        className="text-xs opacity-70 hover:opacity-100 underline"
                      >
                        {t("activity.statusClear")}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_STATUSES.map((s) => {
                      const on = selectedStatuses.has(s);
                      const color = STATUS_COLORS[s];
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => toggleStatus(s)}
                          aria-pressed={on}
                          className={`pill text-xs whitespace-nowrap ${
                            on ? "surface-3 active" : "surface-1 surface-1-hover"
                          }`}
                          style={
                            on
                              ? { color, borderColor: color }
                              : { color }
                          }
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
          <input
            type="search"
            value={commentQuery}
            onChange={(ev) => setCommentQuery(ev.target.value)}
            placeholder={t("activity.searchComments")}
            aria-label={t("activity.searchComments")}
            disabled={ticketQuery.trim().length > 0}
            className="surface-1 surface-1-hover rounded-md px-3 py-1.5 text-sm w-56 disabled:opacity-40"
          />
          <input
            type="search"
            value={ticketQuery}
            onChange={(ev) => setTicketQuery(ev.target.value)}
            placeholder={t("activity.searchTickets")}
            aria-label={t("activity.searchTickets")}
            title={t("activity.searchTicketsTitle")}
            className={`surface-1 surface-1-hover rounded-md px-3 py-1.5 text-sm w-44 font-mono ${
              ticketQuery.trim() ? "ring-2 ring-sky-500/40" : ""
            }`}
          />
          <span className="opacity-30 mx-1">·</span>
          <button
            type="button"
            onClick={onToggleIncludeBots}
            aria-pressed={includeBots}
            title={t("activity.toggleBotsTitle")}
            className={`pill ${
              includeBots
                ? "surface-3 active"
                : "surface-1 surface-1-hover opacity-70"
            }`}
          >
            🤖 {t(includeBots ? "activity.botsOn" : "activity.botsOff")}
          </button>
          <span className="opacity-30 mx-1">·</span>
          <IconButton
            ref={columnsBtnRef}
            aria-label={t("details.columnsManager")}
            title={t("details.columnsManager")}
            onClick={() => setColumnsOpen((v) => !v)}
          >
            <svg
              viewBox="0 0 24 24" width="16" height="16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden focusable="false"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </IconButton>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm table-fixed">
          {/* Fixed column widths so long comments truncate inside the
              event cell instead of stretching the whole row. */}
          <colgroup>
            {visibleColumns.map((id) => (
              <col
                key={id}
                style={{ width: ACTIVITY_COLUMN_INDEX[id].width }}
              />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left opacity-60 text-xs uppercase tracking-wide">
              {visibleColumns.map((id) => {
                const col = ACTIVITY_COLUMN_INDEX[id];
                return (
                  <th
                    key={id}
                    className={`py-2 pr-3 ${col.alignRight ? "text-right" : ""}`}
                  >
                    {headerCell(col)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const outside = isOutsideWorkHours(e.timestamp);
              return (
                <tr
                  key={e.id}
                  className={`divider-t ${outside ? "bg-amber-400/10" : ""}`}
                >
                  {visibleColumns.map((id) => {
                    const col = ACTIVITY_COLUMN_INDEX[id];
                    return (
                      <td
                        key={id}
                        className={`py-2 pr-3 ${col.alignRight ? "text-right" : ""}`}
                      >
                        {renderCell(col, e)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={visibleColumns.length}
                  className="text-center opacity-50 py-6"
                >
                  {t("activity.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ColumnManagerPanel
        triggerRef={columnsBtnRef}
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        order={order}
        hidden={hidden}
        labelFor={(id) => {
          const def = ACTIVITY_COLUMN_INDEX[id];
          const label = t(def.i18nKey as TranslationKey);
          return def.pinned ? `${label} *` : label;
        }}
        onToggleVisibility={handleToggleVisibility}
        onReorder={reorder}
        onReset={reset}
      />
    </div>
  );
}
