import { createPortal } from "react-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useWriteMode } from "../hooks/useWriteMode";

interface ChatterPostMode {
  kind: "post";
  source: "chatter" | "caseComments";
  body: string;
  mentions?: Array<{ userId: string; displayName: string }>;
}

interface ChatterEditMode {
  kind: "edit";
  oldBody: string;
  newBody: string;
}

interface ChatterPostBatchMode {
  kind: "post-batch";
  source: "chatter" | "caseComments";
  entries: Array<{ caseNumber: string; body: string; mentions?: Array<{ userId: string; displayName: string }> }>;
}

interface ChatterEditBatchMode {
  kind: "edit-batch";
  entries: Array<{ caseNumber: string; oldBody: string; newBody: string }>;
}

export type ChatterConfirmMode =
  | ChatterPostMode
  | ChatterEditMode
  | ChatterPostBatchMode
  | ChatterEditBatchMode;

interface Props {
  caseNumber: string;
  mode: ChatterConfirmMode;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}

export function ChatterConfirmModal({
  caseNumber, mode, onCancel, onConfirm, busy, error,
}: Props) {
  const { t } = useLanguage();
  const { enabled } = useWriteMode();

  const title = (mode.kind === "post-batch" || mode.kind === "edit-batch")
    ? t("chatterConfirm.batchTitle")
    : t("chatterConfirm.title");

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 flex items-start justify-center pt-12 px-4 overflow-y-auto"
      style={{ zIndex: 2200, background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="solid-panel p-6 w-full max-w-2xl">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold mb-1">
              {title}
            </h2>
            <p className="text-xs opacity-70">Case {caseNumber}</p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onCancel}
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >✕</button>
        </div>

        {!enabled && (
          <div className="mb-3 p-3 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-800 dark:text-amber-200 text-xs">
            {t("chatterConfirm.dryRunNote")}
          </div>
        )}

        {mode.kind === "post" && (
          <div>
            <p className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-2">
              {t("chatterConfirm.postHeader", { source: mode.source })}
            </p>
            <div className="surface-1 rounded-md p-3 whitespace-pre-wrap break-words text-sm">
              {mode.mentions && mode.mentions.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {mode.mentions.map((m) => (
                    <span key={m.userId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-200">
                      @{m.displayName}
                    </span>
                  ))}
                </div>
              )}
              {mode.body}
            </div>
          </div>
        )}

        {mode.kind === "edit" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-1">
                {t("chatterConfirm.oldBody")}
              </p>
              <div className="surface-1 rounded-md p-3 whitespace-pre-wrap break-words text-sm opacity-70">
                {mode.oldBody}
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-1">
                {t("chatterConfirm.newBody")}
              </p>
              <div className="surface-1 rounded-md p-3 whitespace-pre-wrap break-words text-sm">
                <span className="text-emerald-700 dark:text-emerald-300">
                  {mode.newBody}
                </span>
              </div>
            </div>
          </div>
        )}

        {mode.kind === "post-batch" && (
          <div>
            <p className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-2">
              {t("chatterConfirm.batchPostHeader", { count: mode.entries.length, source: mode.source })}
            </p>
            <div className="surface-1 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide opacity-70">
                    <th className="px-3 py-2 w-24">{t("edit.colCase")}</th>
                    <th className="px-3 py-2">{t("chatterConfirm.colBody")}</th>
                  </tr>
                </thead>
                <tbody>
                  {mode.entries.map((e, i) => (
                    <tr key={i} className="divider-t">
                      <td className="px-3 py-2 font-mono text-xs opacity-80">{e.caseNumber}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap break-words">
                        {e.mentions && e.mentions.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1">
                            {e.mentions.map((m) => (
                              <span key={m.userId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-200">
                                @{m.displayName}
                              </span>
                            ))}
                          </div>
                        )}
                        {e.body}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {mode.kind === "edit-batch" && (
          <div>
            <p className="text-xs uppercase tracking-wider opacity-70 font-semibold mb-2">
              {t("chatterConfirm.batchEditHeader", { count: mode.entries.length })}
            </p>
            <div className="surface-1 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide opacity-70">
                    <th className="px-3 py-2 w-24">{t("edit.colCase")}</th>
                    <th className="px-3 py-2 w-1/2">{t("chatterConfirm.oldBody")}</th>
                    <th className="px-3 py-2">{t("chatterConfirm.newBody")}</th>
                  </tr>
                </thead>
                <tbody>
                  {mode.entries.map((e, i) => (
                    <tr key={i} className="divider-t">
                      <td className="px-3 py-2 font-mono text-xs opacity-80">{e.caseNumber}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap break-words opacity-70">{e.oldBody}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap break-words">
                        <span className="text-emerald-700 dark:text-emerald-300">{e.newBody}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
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
            {t("chatterConfirm.cancel")}
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
            {busy ? "…"
              : enabled ? t("chatterConfirm.confirmWrite")
              : t("chatterConfirm.confirmDryRun")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
