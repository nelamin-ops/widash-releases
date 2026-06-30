import { useEffect, useMemo, useState } from "react";
import { fetchWorkItems } from "../api";
import type { WorkItem } from "../types";
import { useCollapsed } from "../hooks/useCollapsed";
import { useLanguage } from "../hooks/useLanguage";

// Work-item statuses are their own vocabulary (ADM_Work__c), distinct
// from the RMA statuses in statusColors.ts — so they get a small local
// palette here rather than reusing colorForStatus (which would grey
// every one of them out). Unknown statuses fall back to slate.
const WI_STATUS_COLORS: Record<string, string> = {
  "New": "#94A3B8",            // slate-400
  "Triaged": "#A3E635",        // lime-400
  "In Progress": "#38BDF8",    // sky-400
  "QA In Progress": "#818CF8", // indigo-400
  "Waiting": "#F59E0B",        // amber-500
  "Fixed": "#34D399",          // emerald-400
  "Closed": "#6B7280",         // gray-500
};

function wiColor(status: string): string {
  return WI_STATUS_COLORS[status] ?? "#9CA3AF";
}

interface WorkItemsSectionProps {
  /** Open a work item in its own sheet tab. */
  onOpenWorkItem: (wi: WorkItem) => void;
}

/** Open GUS work items (ADM_Work__c) for the active region, shown as a
 *  collapsible list so the whole team sees who is blocked on what.
 *  Lives directly under the donut overview. Read-only. */
export function WorkItemsSection({ onOpenWorkItem }: WorkItemsSectionProps) {
  const { t } = useLanguage();
  const [collapsed, toggle] = useCollapsed("section.workItems");
  const [filter, setFilter] = useState("");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Load only once expanded, then refresh on the 60s cadence the
  // backend caches at. Collapsed → no ADM_Work__c round-trip at all.
  useEffect(() => {
    if (collapsed) return;
    let alive = true;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const resp = await fetchWorkItems(200);
        if (!alive) return;
        setItems(resp.items);
        setSites(resp.sites);
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const id = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [collapsed]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((w) =>
      w.name.toLowerCase().includes(q) ||
      w.subject.toLowerCase().includes(q) ||
      w.team.toLowerCase().includes(q) ||
      w.assignee.toLowerCase().includes(q) ||
      w.status.toLowerCase().includes(q),
    );
  }, [items, filter]);

  const regionLabel = useMemo(() => {
    const prefixes = [...new Set(sites.map((s) => s.replace(/[0-9].*$/, "")))];
    return prefixes.join(" / ");
  }, [sites]);

  return (
    <section className="glass mb-6 overflow-hidden">
      <header
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        style={{ background: "var(--surface-2)" }}
        onClick={toggle}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t("workItems.title")}
          className="surface-1-hover rounded p-0.5 -ml-1 shrink-0"
          onClick={(e) => { e.stopPropagation(); toggle(); }}
        >
          <svg
            viewBox="0 0 24 24" width="14" height="14" fill="none"
            stroke="currentColor" strokeWidth="2.5"
            style={{
              transition: "transform 150ms ease",
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
            aria-hidden focusable="false"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        <h2 className="text-base font-semibold">
          {regionLabel
            ? t("workItems.titleRegion", { region: regionLabel })
            : t("workItems.title")}
        </h2>
        {!loading && !error && (
          <span className="ml-auto text-xs opacity-60">
            {t("workItems.count", { count: items.length })}
          </span>
        )}
      </header>

      {!collapsed && (
        <div className="px-4 py-4 space-y-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("workItems.filterPlaceholder")}
            className="w-full surface-1 border-soft rounded px-3 py-2 text-sm
                       outline-none focus:ring-2 focus:ring-sky-500/40"
            aria-label={t("workItems.filterPlaceholder")}
          />

          {loading && (
            <p className="text-sm opacity-60 py-2">{t("workItems.loading")}</p>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400 py-2">
              {t("workItems.error")}
            </p>
          )}
          {!loading && !error && filtered.length === 0 && (
            <p className="text-sm opacity-60 py-2">{t("workItems.empty")}</p>
          )}
          {!loading && !error && filtered.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="font-medium py-1.5 pr-3">{t("workItems.colId")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("workItems.colSubject")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("workItems.colStatus")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("workItems.colTeam")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("workItems.colAssignee")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((w) => (
                    <tr key={w.id} className="border-t border-soft align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onOpenWorkItem(w)}
                          className="font-mono text-xs text-sky-600 dark:text-sky-400 hover:underline"
                          title={t("workItems.openTab")}
                        >
                          {w.name}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span>{w.subject}</span>
                        {w.caseNumber && (
                          <span className="ml-2 text-xs opacity-60">
                            ({t("workItems.linkedCase", { caseNumber: w.caseNumber })})
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <span
                          className="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
                          style={{
                            background: `${wiColor(w.status)}22`,
                            color: wiColor(w.status),
                          }}
                        >
                          {w.status}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap opacity-80">
                        {w.team}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap opacity-80">
                        {w.assignee || t("workItems.unassigned")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
