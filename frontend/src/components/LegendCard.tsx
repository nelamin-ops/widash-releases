import { useState } from "react";
import type { MyRtsTicket, StatusBucket } from "../types";
import { useLanguage, localeFor } from "../hooks/useLanguage";

interface LegendCardProps {
  buckets: StatusBucket[];
  returnToServiceToday?: number;
  myRtsOpen?: MyRtsTicket[];
  myRtsClosedTotal?: number;
}

const RTS_GREEN = "#34D399";

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

interface RtsRowProps {
  label: string;
  hint?: string;
  count: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  title?: string;
}

function RtsRow({
  label, hint, count, expandable, expanded, onToggle, title,
}: RtsRowProps) {
  const Tag = expandable ? "button" : "div";
  const interactive = expandable
    ? "cursor-pointer surface-1-hover"
    : "";
  return (
    <Tag
      {...(expandable
        ? { type: "button" as const, onClick: onToggle, "aria-expanded": expanded }
        : {})}
      title={title}
      className={`flex items-center gap-3 w-full text-left rounded-md px-1 -mx-1 py-1 transition-colors ${interactive}`}
    >
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: RTS_GREEN }} />
      <span className="text-sm flex-1 min-w-0 flex items-center gap-1">
        <span>{label}</span>
        {hint && <span className="opacity-60">{hint}</span>}
        {expandable && (
          <span
            aria-hidden
            className="opacity-70 inline-block"
            style={{ fontSize: "0.95rem", lineHeight: 1 }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </span>
      <span
        className="tabular-nums font-medium w-8 text-right shrink-0"
        style={{ color: RTS_GREEN }}
      >
        {count}
      </span>
    </Tag>
  );
}

export function LegendCard({
  buckets, returnToServiceToday, myRtsOpen, myRtsClosedTotal,
}: LegendCardProps) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const openTickets = myRtsOpen ?? [];
  const myOpenCount = openTickets.length;
  const hasRtsBlock =
    returnToServiceToday !== undefined ||
    myRtsClosedTotal !== undefined ||
    myOpenCount > 0;

  return (
    <div className="glass p-6">
      <div className="flex items-center gap-2 mb-4">
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: "var(--text-muted)" }}
        />
        <h2 className="text-lg font-medium">{t("legend.title")}</h2>
      </div>
      <ul className="space-y-3">
        {buckets.map((b) => (
          <li key={b.status} className="flex items-center gap-3">
            <span className="w-28 text-sm">{b.status}</span>
            <div className="flex-1 h-2 rounded-full surface-2 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(b.count / max) * 100}%`,
                  background: b.color,
                }}
              />
            </div>
            <span className="w-8 text-right tabular-nums">{b.count}</span>
          </li>
        ))}
      </ul>

      {hasRtsBlock && (
        <div className="mt-4 pt-4 divider-t space-y-1">
          {returnToServiceToday !== undefined && (
            <RtsRow
              label={t("legend.rtsToday")}
              hint={t("legend.rtsTodayHint")}
              count={returnToServiceToday}
              title={t("legend.rtsTodayTitle")}
            />
          )}

          <RtsRow
            label={t("legend.myOpen")}
            count={myOpenCount}
            expandable={myOpenCount > 0}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            title={t("legend.myOpenTitle")}
          />

          {expanded && myOpenCount > 0 && (
            <div className="mt-2 mb-2 overflow-hidden rounded-md border border-soft surface-1">
              <table className="w-full text-xs">
                <thead>
                  <tr
                    className="text-left opacity-60 uppercase tracking-wide"
                    style={{ background: "rgba(52, 211, 153, 0.06)" }}
                  >
                    <th className="py-1.5 px-2 w-24">{t("legend.tableTicket")}</th>
                    <th className="py-1.5 px-2 w-14">{t("legend.tableLocation")}</th>
                    <th className="py-1.5 px-2">{t("legend.tableSubject")}</th>
                    <th className="py-1.5 px-2 w-16 text-right">{t("legend.tableSetAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {openTickets.map((ticket) => (
                    <tr
                      key={ticket.id}
                      className="divider-t"
                      style={{ color: RTS_GREEN }}
                    >
                      <td className="py-1.5 px-2 font-mono">
                        <a
                          href={ticket.gusUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                          title={t("common.openInGus")}
                        >
                          {ticket.name}
                        </a>
                      </td>
                      <td className="py-1.5 px-2 opacity-80">{ticket.location}</td>
                      <td className="py-1.5 px-2 opacity-80 truncate" title={ticket.subject}>
                        {ticket.subject}
                      </td>
                      <td className="py-1.5 px-2 text-right opacity-70 tabular-nums whitespace-nowrap">
                        {formatDate(ticket.setAt, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {myRtsClosedTotal !== undefined && (
            <RtsRow
              label={t("legend.closed")}
              hint={t("legend.closedHint")}
              count={myRtsClosedTotal}
              title={t("legend.closedTitle")}
            />
          )}
        </div>
      )}
    </div>
  );
}
