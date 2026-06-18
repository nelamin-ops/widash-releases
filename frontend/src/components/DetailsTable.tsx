import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { RmaTicket } from "../types";
import { useSort } from "../hooks/useSort";
import { useColumnConfig } from "../hooks/useColumnConfig";
import { SortHeader } from "./SortHeader";
import { IconButton } from "./IconButton";
import { ColumnManagerPanel } from "./ColumnManagerPanel";
import { TruncatedCell } from "./TruncatedCell";
import {
  DETAILS_COLUMN_INDEX, type DetailsColumnDef, type DetailsColumnId,
} from "./detailsColumns";
import { useLanguage, localeFor, type TranslationKey } from "../hooks/useLanguage";

type Anchor = { x: number; y: number };

// Coolan + GUS render as icon buttons, not text — exclude them from the
// filter column dropdown.
const NON_FILTERABLE: ReadonlySet<DetailsColumnId> = new Set(["coolan", "gus"]);

function filterText(
  ticket: RmaTicket,
  column: DetailsColumnId,
  locale: string,
): string {
  switch (column) {
    case "priority": return ticket.priority;
    case "name": return ticket.name;
    case "location": return ticket.location;
    case "componentType": return ticket.componentType;
    case "assetName": return ticket.assetName;
    case "assetLocationPath": return ticket.assetLocationPath;
    case "assetType": return ticket.assetType;
    case "description": return ticket.description;
    case "assignee": return ticket.assignee;
    case "createdDate":
      return new Date(ticket.createdDate).toLocaleDateString(locale, {
        day: "2-digit", month: "2-digit",
      });
    case "statusChangedAt": {
      if (!ticket.statusChangedAt) return "";
      const d = new Date(ticket.statusChangedAt);
      return (
        d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })
        + " " +
        d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      );
    }
    default: return "";
  }
}

interface DetailsTableProps {
  status: string;
  statusColor?: string;
  tickets: RmaTicket[];
  onClose: () => void;
  onOpenText: (id: string, title: string, text: string, anchor: Anchor) => void;
  onOpenCoolan: (ticket: RmaTicket, anchor: Anchor) => void;
  onOpenTicket: (ticket: RmaTicket) => void;
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

export function DetailsTable({
  status, statusColor, tickets, onClose, onOpenText, onOpenCoolan, onOpenTicket,
}: DetailsTableProps) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);

  const {
    order, hidden, visibleColumns,
    toggleVisibility, reorder, reset,
  } = useColumnConfig();

  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Per-list filter — case-insensitive substring on a single user-picked
  // column. Local state, resets when the panel is closed.
  const filterableColumns = visibleColumns.filter(
    (id) => !NON_FILTERABLE.has(id),
  );
  const [filterColumn, setFilterColumn] = useState<DetailsColumnId | "">("");
  const [filterValue, setFilterValue] = useState("");

  // If the active filter column gets hidden via the column manager, drop
  // the filter so we don't silently filter on something the user can't see.
  const activeFilterColumn: DetailsColumnId | "" =
    filterColumn && filterableColumns.includes(filterColumn) ? filterColumn : "";

  const filteredTickets = useMemo(() => {
    if (!activeFilterColumn || !filterValue.trim()) return tickets;
    const needle = filterValue.trim().toLowerCase();
    return tickets.filter((tk) =>
      filterText(tk, activeFilterColumn, locale).toLowerCase().includes(needle),
    );
  }, [tickets, activeFilterColumn, filterValue, locale]);

  // Build a sort accessor map only for the columns currently visible.
  const accessors = Object.fromEntries(
    visibleColumns
      .map((id) => [id, DETAILS_COLUMN_INDEX[id].accessor])
      .filter(([, a]) => Boolean(a)),
  ) as Record<DetailsColumnId, (t: RmaTicket) => unknown>;

  const initialSortKey: DetailsColumnId = (
    visibleColumns.find((id) => DETAILS_COLUMN_INDEX[id].sortable)
    ?? "priority"
  );

  const { sorted, sort, toggle } = useSort<RmaTicket, DetailsColumnId>(
    filteredTickets, { key: initialSortKey, dir: "asc" }, accessors,
  );

  // Pin tickets currently on Status="New" to the top, regardless of sort.
  // These represent freshly created cases that need triage before anything
  // else, so they should never sink below other rows.
  const pinned = sorted.filter((tk) => tk.status === "New");
  const rest = sorted.filter((tk) => tk.status !== "New");
  const displayed = [...pinned, ...rest];

  const filterActive = Boolean(activeFilterColumn && filterValue.trim());

  const headerCell = (col: DetailsColumnDef) => {
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

  const renderCell = (col: DetailsColumnDef, ticket: RmaTicket) => {
    switch (col.id) {
      case "priority":
        return <span className="whitespace-nowrap">{ticket.priority}</span>;
      case "name":
        return (
          <button
            type="button"
            onClick={() => onOpenTicket(ticket)}
            className="font-mono whitespace-nowrap hover:underline cursor-pointer text-left"
            style={{ color: statusColor }}
          >
            {ticket.name}
          </button>
        );
      case "location":
        return <span className="whitespace-nowrap">{ticket.location}</span>;
      case "componentType":
        return (
          <TruncatedCell
            id={`subject:${ticket.id}`}
            title={t("details.tooltipTitle", { name: ticket.name })}
            text={ticket.componentType}
            onOpen={onOpenText}
          />
        );
      case "assetName":
        return (
          <TruncatedCell
            id={`assetName:${ticket.id}`}
            title={`${t("details.colAssetName")} · ${ticket.name}`}
            text={ticket.assetName}
            className="font-mono text-xs"
            onOpen={onOpenText}
          />
        );
      case "assetLocationPath":
        return (
          <TruncatedCell
            id={`assetLoc:${ticket.id}`}
            title={`${t("details.colAssetLocation")} · ${ticket.name}`}
            text={ticket.assetLocationPath}
            onOpen={onOpenText}
          />
        );
      case "assetType":
        return (
          <TruncatedCell
            id={`assetType:${ticket.id}`}
            title={`${t("details.colAssetType")} · ${ticket.name}`}
            text={ticket.assetType}
            onOpen={onOpenText}
          />
        );
      case "description":
        return (
          <TruncatedCell
            id={`description:${ticket.id}`}
            title={`${t("details.colDescription")} · ${ticket.name}`}
            text={ticket.description}
            onOpen={onOpenText}
          />
        );
      case "createdDate":
        return (
          <span className="whitespace-nowrap">
            {formatDate(ticket.createdDate, locale)}
          </span>
        );
      case "statusChangedAt": {
        // Fall back to createdDate when no CaseHistory entry exists —
        // this happens when the case was created directly in the current
        // status (no prior transition recorded by Salesforce).
        const raw = ticket.statusChangedAt || ticket.createdDate;
        const d = new Date(raw);
        const date = d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
        const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
        const isFallback = !ticket.statusChangedAt;
        return (
          <span className="whitespace-nowrap" title={isFallback ? "Kein Statuswechsel – Erstelldatum" : undefined}>
            {date} {time}{isFallback && <span className="opacity-40 ml-0.5">*</span>}
          </span>
        );
      }
      case "assignee":
        return (
          <TruncatedCell
            id={`assignee:${ticket.id}`}
            title={`${t("details.colAssignee")} · ${ticket.name}`}
            text={ticket.assignee}
            onOpen={onOpenText}
          />
        );
      case "coolan": {
        const hasCoolan = ticket.coolanLinks.length > 0;
        const state = ticket.coolanReportingState;
        // Colour the snowflake by the reporting state — applied globally
        // across all statuses. active = green (host alive and reporting),
        // delayed = grey (DELAYED_REPORTING / ANOMALOUS — same shade as
        // Coolan's UI, signals "safe to work on the device"), missing =
        // red, unknown = muted grey.
        let colorClass = "";
        let stateLabel = "";
        if (state === "active") {
          colorClass = "text-emerald-600 dark:text-emerald-300";
          stateLabel = "Active";
        } else if (state === "delayed") {
          colorClass = "text-slate-500 dark:text-slate-400";
          stateLabel = "Delayed";
        } else if (state === "missing") {
          colorClass = "text-rose-600 dark:text-rose-300";
          stateLabel = "Missing";
        } else if (state === "unknown") {
          colorClass = "opacity-60";
          stateLabel = "Unknown";
        }
        const titleParts: string[] = [];
        if (state) titleParts.push(`Coolan: ${stateLabel}`);
        if (hasCoolan) titleParts.push(t("details.colCoolan"));
        if (!hasCoolan && !state) titleParts.push(t("details.coolanNoneAvailable"));
        return (
          <button
            type="button"
            disabled={!hasCoolan && !state}
            aria-label={t("details.colCoolan")}
            title={titleParts.join(" · ")}
            onClick={(ev) => {
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenCoolan(ticket, { x: r.right, y: r.bottom + 4 });
            }}
            className={`pill text-xl leading-none ${colorClass} ${
              hasCoolan || state
                ? "surface-1-hover cursor-pointer"
                : "opacity-30 cursor-not-allowed"
            }`}
          >
            ❄
          </button>
        );
      }
      case "gus":
        return (
          <a
            href={ticket.gusUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={t("common.openInGus")}
            className="pill surface-1-hover"
          >
            ↗
          </a>
        );
    }
  };

  // Use the bucket color for the panel border so the open detail view is
  // visually anchored to the segment that was clicked.
  const borderStyle = statusColor
    ? { borderColor: statusColor, boxShadow: `0 0 0 1px ${statusColor}55` }
    : undefined;

  const totalWidth = visibleColumns.reduce(
    (sum, id) => sum + DETAILS_COLUMN_INDEX[id].width + 16, // 16 = pr-4 padding
    0,
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="glass p-6 mb-6"
      style={borderStyle}
    >
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          {statusColor && (
            <span
              aria-hidden
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: statusColor }}
            />
          )}
          <h2 className="text-lg font-medium truncate">
            <span style={statusColor ? { color: statusColor } : undefined}>
              {status}
            </span>
            <span className="opacity-60 ml-2 text-sm">
              {filterActive
                ? `(${displayed.length}/${tickets.length})`
                : `(${tickets.length})`}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
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
          <IconButton
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24" width="16" height="16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden focusable="false"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3 text-sm">
        <label className="opacity-60 text-xs uppercase tracking-wide">
          {t("filter.label")}
        </label>
        <select
          aria-label={t("filter.column")}
          value={activeFilterColumn}
          onChange={(ev) => {
            const next = ev.target.value as DetailsColumnId | "";
            setFilterColumn(next);
            if (!next) setFilterValue("");
          }}
          className="surface-1 surface-1-hover px-2 py-1 rounded text-sm"
        >
          <option value="">{t("filter.columnPlaceholder")}</option>
          {filterableColumns.map((id) => (
            <option key={id} value={id}>
              {t(DETAILS_COLUMN_INDEX[id].i18nKey as TranslationKey)}
            </option>
          ))}
        </select>
        {activeFilterColumn && (
          <>
            <input
              type="text"
              aria-label={t("filter.value")}
              placeholder={t("filter.placeholder")}
              value={filterValue}
              onChange={(ev) => setFilterValue(ev.target.value)}
              autoFocus
              className="surface-1 px-2 py-1 rounded text-sm flex-1 min-w-0 max-w-xs"
            />
            {filterValue && (
              <IconButton
                aria-label={t("filter.clear")}
                title={t("filter.clear")}
                onClick={() => setFilterValue("")}
              >
                <svg
                  viewBox="0 0 24 24" width="14" height="14"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden focusable="false"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </IconButton>
            )}
          </>
        )}
        {filterActive && (
          <span className="opacity-60 text-xs ml-auto">
            {t("filter.counter", {
              shown: String(displayed.length),
              total: String(tickets.length),
            })}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table
          className="text-sm table-fixed"
          style={{ width: totalWidth, minWidth: totalWidth }}
        >
          <colgroup>
            {visibleColumns.map((id) => (
              <col
                key={id}
                style={{ width: DETAILS_COLUMN_INDEX[id].width }}
              />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left opacity-60 text-xs uppercase tracking-wide">
              {visibleColumns.map((id) => {
                const col = DETAILS_COLUMN_INDEX[id];
                return (
                  <th
                    key={id}
                    className={`py-2 pr-4 ${col.alignRight ? "text-right" : ""}`}
                  >
                    {headerCell(col)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayed.map((ticket) => {
              const isNew = ticket.status === "New";
              const isSelected = selectedId === ticket.id;
              return (
                <tr
                  key={ticket.id}
                  onClick={(e) => {
                    const tag = (e.target as HTMLElement).closest("a, button");
                    if (tag) return;
                    setSelectedId(isSelected ? null : ticket.id);
                  }}
                  className={`divider-t align-top cursor-pointer ${
                    isSelected
                      ? "bg-sky-500/20 dark:bg-sky-400/15"
                      : isNew
                        ? "bg-emerald-500/10 hover:bg-emerald-500/20"
                        : "hover:bg-white/5 dark:hover:bg-white/5"
                  }`}
                  style={isSelected && statusColor
                    ? { backgroundColor: `${statusColor}22` }
                    : undefined}
                >
                  {visibleColumns.map((id) => {
                    const col = DETAILS_COLUMN_INDEX[id];
                    return (
                      <td
                        key={id}
                        className={`py-2 pr-4 ${col.alignRight ? "text-right" : ""}`}
                      >
                        {renderCell(col, ticket)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ColumnManagerPanel
        triggerRef={columnsBtnRef}
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        order={order}
        hidden={hidden}
        labelFor={(id) => t(DETAILS_COLUMN_INDEX[id].i18nKey as TranslationKey)}
        onToggleVisibility={toggleVisibility}
        onReorder={reorder}
        onReset={reset}
      />
    </motion.div>
  );
}
