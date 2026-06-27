import { createPortal } from "react-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useWriteMode } from "../hooks/useWriteMode";
import type { FieldChange } from "../hooks/useSectionEdits";

interface EditConfirmModalProps {
  caseNumber: string;
  changes: FieldChange[];
  onCancel: () => void;
  /** Goes back to edit mode with drafts intact so the user can fix typos. */
  onEdit: () => void;
  /** User pressed Confirm. Parent decides whether to actually write
   *  (gated by the write-mode pill). */
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}

function formatValue(
  v: unknown,
  display?: string | null,
): string {
  // Lookup display takes precedence — the raw value is just an opaque
  // Salesforce id which is useless to a human reviewing the diff.
  if (display !== undefined && display !== null) {
    return display === "" ? "—" : display;
  }
  if (v === null || v === undefined || v === "") return "—";
  if (v === true) return "✓ yes";
  if (v === false) return "— no";
  return String(v);
}

export function EditConfirmModal({
  caseNumber, changes, onCancel, onEdit, onConfirm, busy, error,
}: EditConfirmModalProps) {
  const { t } = useLanguage();
  const { enabled } = useWriteMode();
  if (changes.length === 0) return null;

  const grouped = {
    case: changes.filter((c) => c.sobject === "case"),
    asset: changes.filter((c) => c.sobject === "asset"),
  };

  // Show a "Case" column if any change has a caseNumber.
  const showCaseColumn = changes.some((c) => c.caseNumber !== undefined);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("edit.confirmTitle")}
      className="fixed inset-0 flex items-start justify-center pt-12 px-4 overflow-y-auto"
      style={{ zIndex: 2200, background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="solid-panel p-6 w-full max-w-3xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold mb-1">
              {t("edit.confirmTitle")}
            </h2>
            <p className="text-xs opacity-70">
              {t("edit.confirmSubtitle", {
                count: changes.length,
                caseNumber,
              })}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onCancel}
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >✕</button>
        </div>

        {!enabled && (
          <div className="mb-4 p-3 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-800 dark:text-amber-200 text-xs">
            <strong className="font-semibold">{t("edit.dryRunHeader")}</strong>{" "}
            {t("edit.dryRunBody")}
          </div>
        )}

        {(["case", "asset"] as const).map((kind) =>
          grouped[kind].length > 0 ? (
            <section key={kind} className="mb-4 last:mb-0">
              <h3 className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-2">
                {kind === "case" ? t("edit.sectionCase") : t("edit.sectionAsset")}{" "}
                <span className="opacity-60 font-normal">
                  ({grouped[kind].length})
                </span>
              </h3>
              <div className="surface-1 rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide opacity-70">
                      {showCaseColumn && (
                        <th className="px-3 py-2 w-24">{t("edit.colCase")}</th>
                      )}
                      <th className="px-3 py-2 w-1/4">{t("edit.colField")}</th>
                      <th className="px-3 py-2 w-1/3">{t("edit.colOld")}</th>
                      <th className="px-3 py-2">{t("edit.colNew")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped[kind].map((c) => (
                      <tr key={c.apiName} className="divider-t">
                        {showCaseColumn && (
                          <td className="px-3 py-2 opacity-70">
                            {c.caseNumber ?? "—"}
                          </td>
                        )}
                        <td className="px-3 py-2 font-medium">{c.label}</td>
                        <td className="px-3 py-2 opacity-70 break-words">
                          {formatValue(c.oldValue, c.oldDisplay)}
                        </td>
                        <td className="px-3 py-2 break-words">
                          <span className="text-emerald-700 dark:text-emerald-300">
                            {formatValue(c.newValue, c.newDisplay)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null,
        )}

        {error && (
          <div className="mt-4 p-3 rounded-md bg-rose-500/15 border border-rose-500/40 text-rose-800 dark:text-rose-200 text-sm break-words">
            {error}
          </div>
        )}

        <div className="flex justify-between items-center mt-5 gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="pill surface-1 surface-1-hover text-sm disabled:opacity-50"
          >
            {t("edit.cancel")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              className="pill surface-1 surface-1-hover text-sm disabled:opacity-50"
            >
              {t("edit.edit")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={`pill text-sm disabled:opacity-50 ${
                enabled
                  ? "bg-rose-500/30 text-rose-800 dark:text-rose-100 hover:bg-rose-500/40 font-medium"
                  : "bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35"
              }`}
            >
              {busy ? t("common.loading")
                : enabled ? t("edit.confirmWrite")
                : t("edit.confirmDryRun")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
