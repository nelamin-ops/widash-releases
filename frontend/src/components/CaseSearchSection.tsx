import { useRef, useState } from "react";
import { lookupCaseByIdentifier } from "../api";
import type { CaseLookupResult } from "../api";
import { useCollapsed } from "../hooks/useCollapsed";
import { useLanguage } from "../hooks/useLanguage";
import { colorForStatus } from "../statusColors";

interface CaseSearchSectionProps {
  /** Open a case sheet for a clicked search hit. App owns the sheet
   *  stack, so the section only hands back the resolved lookup. */
  onOpenCase: (hit: CaseLookupResult) => void;
}

/** Classify a free-text query into the lookup kind the backend
 *  understands. Mirrors the regexes in _LOOKUP_KINDS server-side;
 *  returns null when it doesn't look like an openable identifier. */
function classifyQuery(
  q: string,
): "case_number" | "hostname" | "serial" | null {
  const v = q.trim();
  if (/^[0-9]{6,12}$/.test(v)) return "case_number";
  if (/^[Ww]-?\d+$/.test(v)) return null;  // W-ids are work items, not cases
  if (/^[A-Za-z0-9][A-Za-z0-9.\-]{2,79}$/.test(v)) {
    return v.includes(".") || /-[a-z]{2,4}\d{0,3}$/.test(v)
      ? "hostname"
      : "serial";
  }
  return null;
}

export function CaseSearchSection({ onOpenCase }: CaseSearchSectionProps) {
  const { t } = useLanguage();
  const [collapsed, toggle] = useCollapsed("section.caseSearch");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [hit, setHit] = useState<CaseLookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runSearch() {
    const v = query.trim();
    setHit(null);
    setNotFound(false);
    const kind = classifyQuery(v);
    if (!kind) { setNotFound(true); return; }
    setBusy(true);
    try {
      // Ambiguous text: try the classified kind first, then the other
      // identifier shape, so the user needn't know which GUS field
      // stores the value. Case numbers are unambiguous (one match).
      const order: Array<"case_number" | "hostname" | "serial"> =
        kind === "case_number" ? ["case_number"]
        : kind === "hostname" ? ["hostname", "serial"]
        : ["serial", "hostname"];
      for (const k of order) {
        const r = await lookupCaseByIdentifier(k, v);
        if (r) { setHit(r); return; }
      }
      setNotFound(true);
    } catch {
      setNotFound(true);
    } finally {
      setBusy(false);
    }
  }

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
          aria-label={t("search.title")}
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
        <h2 className="text-base font-semibold">{t("search.title")}</h2>
      </header>

      {!collapsed && (
        <div className="px-4 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setNotFound(false);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
              placeholder={t("search.placeholder")}
              className="flex-1 surface-1 border-soft rounded px-3 py-2 text-sm
                         outline-none focus:ring-2 focus:ring-sky-500/40"
              aria-label={t("search.title")}
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={busy || !query.trim()}
              className="pill px-3 py-2 text-sm shrink-0 disabled:opacity-40"
            >
              {busy ? t("search.searching") : t("search.button")}
            </button>
          </div>
          <p className="text-xs opacity-50">{t("search.hint")}</p>

          {notFound && !busy && (
            <p className="text-sm text-amber-600 dark:text-amber-400 py-1">
              {t("search.noCase", { value: query.trim() })}
            </p>
          )}

          {/* Single search hit — Case structure (number, status,
              location, subject). Clicking the case number opens it in a
              tab, exactly like a row from a donut segment. */}
          {hit && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left opacity-60">
                    <th className="font-medium py-1.5 pr-3">{t("search.colCase")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("search.colStatus")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("search.colLocation")}</th>
                    <th className="font-medium py-1.5 pr-3">{t("search.colSubject")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-soft align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onOpenCase(hit)}
                        className="font-mono text-sky-600 dark:text-sky-400 hover:underline"
                        title={t("search.openTab")}
                      >
                        {hit.caseNumber}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <span
                        className="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
                        style={{
                          background: `${colorForStatus(hit.status)}22`,
                          color: colorForStatus(hit.status),
                        }}
                      >
                        {hit.status}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap opacity-80">
                      {hit.location || "—"}
                    </td>
                    <td className="py-1.5 pr-3 opacity-80">
                      {hit.subject || "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
