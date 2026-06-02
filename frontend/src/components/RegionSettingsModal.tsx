import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../hooks/useLanguage";
import {
  detectRegion, fetchRegions,
  type RegionDetectResponse, type RegionEntry,
} from "../api";

interface RegionSettingsModalProps {
  open: boolean;
  /** Currently active report ids (from localStorage). Empty = none yet. */
  reportIds: string[];
  onSave: (reportIds: string[]) => void;
  onClose: () => void;
}

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

function isValidId(id: string): boolean {
  return SF_ID_RE.test(id.trim());
}

export function RegionSettingsModal({
  open, reportIds, onSave, onClose,
}: RegionSettingsModalProps) {
  const { t } = useLanguage();
  // Working draft — independent of the prop so the user can stage
  // multiple changes before saving.
  const [drafts, setDrafts] = useState<string[]>(reportIds);
  const [newEntry, setNewEntry] = useState("");
  const [detected, setDetected] = useState<RegionDetectResponse | null>(null);
  const [regions, setRegions] = useState<RegionEntry[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setDrafts(reportIds);
      setNewEntry("");
    }
  }, [open, reportIds]);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    Promise.allSettled([detectRegion(), fetchRegions()])
      .then(([dRes, rRes]) => {
        setDetected(dRes.status === "fulfilled" ? dRes.value : null);
        setRegions(rRes.status === "fulfilled" ? rRes.value.regions : []);
      })
      .finally(() => setBusy(false));
  }, [open]);

  if (!open) return null;

  const trimmedNew = newEntry.trim();
  const newIsValid = isValidId(trimmedNew);
  const newIsDuplicate = drafts.includes(trimmedNew);
  const canAdd = newIsValid && !newIsDuplicate;
  const canSave = drafts.length > 0 && drafts.every(isValidId);
  const suggestion = detected?.suggestedReportId;
  const suggestionAlreadyAdded = suggestion ? drafts.includes(suggestion) : false;

  function addEntry(id: string) {
    const trimmed = id.trim();
    if (!isValidId(trimmed)) return;
    if (drafts.includes(trimmed)) return;
    setDrafts((d) => [...d, trimmed]);
    setNewEntry("");
  }

  function removeAt(idx: number) {
    setDrafts((d) => d.filter((_, i) => i !== idx));
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      className="fixed inset-0 flex items-start justify-center pt-16 px-4 overflow-y-auto"
      style={{ zIndex: 2400, background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="solid-panel p-6 w-full max-w-xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold mb-1">
              {t("settings.title")}
            </h2>
            <p className="text-xs opacity-70">
              {t("settings.subtitleMulti")}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >✕</button>
        </div>

        {busy && (
          <div className="text-xs opacity-60 italic mb-3">
            {t("common.loading")}
          </div>
        )}

        {detected && (
          <div className="surface-1 rounded-md p-3 mb-4 text-sm">
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-xs uppercase tracking-wide opacity-60">
                {t("settings.detected")}
              </span>
              {detected.sitePrefix && (
                <span className="font-mono font-semibold">
                  {detected.sitePrefix}
                </span>
              )}
            </div>
            {detected.suggestedReportId && !suggestionAlreadyAdded ? (
              <div className="flex items-center justify-between gap-3">
                <p className="opacity-80 leading-snug flex-1 min-w-0">
                  {t("settings.detectedHasReport", {
                    prefix: detected.sitePrefix ?? "?",
                  })}{" "}
                  <code className="font-mono text-xs opacity-70 break-all">
                    {detected.suggestedReportId}
                  </code>
                </p>
                <button
                  type="button"
                  onClick={() => addEntry(detected.suggestedReportId!)}
                  className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 text-xs whitespace-nowrap"
                >
                  {t("settings.add")}
                </button>
              </div>
            ) : detected.suggestedReportId ? (
              <p className="opacity-80 leading-snug">
                {t("settings.detectedAlreadyAdded")}
              </p>
            ) : detected.sitePrefix ? (
              <p className="opacity-80 leading-snug">
                {t("settings.detectedNoReport", {
                  prefix: detected.sitePrefix,
                })}
              </p>
            ) : (
              <p className="opacity-80 leading-snug">
                {t("settings.detectedUnknown")}
              </p>
            )}
            {detected.knownRegions.length > 0 && (
              <p className="opacity-50 text-xs mt-2">
                {t("settings.knownRegions")}:{" "}
                {detected.knownRegions.join(", ")}
              </p>
            )}
          </div>
        )}

        <div className="mb-4">
          <h3 className="text-xs uppercase tracking-wide opacity-70 mb-2">
            {t("settings.activeReports")} ({drafts.length})
          </h3>
          {drafts.length === 0 ? (
            <p className="text-sm opacity-60 italic">
              {t("settings.noReports")}
            </p>
          ) : (
            <ul className="space-y-1">
              {drafts.map((id, i) => (
                <li
                  key={`${id}-${i}`}
                  className="flex items-center gap-2 surface-1 rounded-md px-3 py-2"
                >
                  <code className="font-mono text-xs flex-1 break-all">
                    {id}
                  </code>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={t("settings.remove")}
                    title={t("settings.remove")}
                    className="pill surface-1-hover w-7 h-7 flex items-center justify-center text-xs"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {drafts.length > 1 && (
            <p className="text-xs opacity-60 mt-2 leading-snug">
              ⚠ {t("settings.multiWarning")}
            </p>
          )}
        </div>

        {/* Curated region dropdown — same source as the auto-detect
            suggestion. Lists every prefix in SITE_REPORTS that's not
            already in the user's draft list. */}
        {(() => {
          const available = regions.filter((r) => !drafts.includes(r.reportId));
          if (available.length === 0 && !showCustom) {
            return (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setShowCustom(true)}
                  className="text-xs underline opacity-70 hover:opacity-100"
                >
                  {t("settings.addCustomLink")}
                </button>
              </div>
            );
          }
          if (available.length === 0) return null;
          return (
            <div className="mb-3">
              <label className="block text-xs uppercase tracking-wide opacity-70 mb-1">
                {t("settings.addRegionLabel")}
              </label>
              <div className="flex gap-2 flex-wrap">
                {available.map((r) => (
                  <button
                    key={r.prefix}
                    type="button"
                    onClick={() => addEntry(r.reportId)}
                    title={r.reportId}
                    className="pill surface-1 surface-1-hover text-sm"
                  >
                    + {r.prefix}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowCustom((v) => !v)}
                className="text-xs underline opacity-70 hover:opacity-100 mt-2"
              >
                {showCustom
                  ? t("settings.hideCustom")
                  : t("settings.addCustomLink")}
              </button>
            </div>
          );
        })()}

        {showCustom && (
          <>
            <label className="block text-xs uppercase tracking-wide opacity-70 mb-1">
              {t("settings.reportIdLabel")}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newEntry}
                onChange={(e) => setNewEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canAdd) addEntry(trimmedNew);
                }}
                placeholder="00OEE000001HkkD2AS"
                className="flex-1 p-2 rounded-md surface-2 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => addEntry(trimmedNew)}
                disabled={!canAdd}
                className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30 text-sm"
              >
                {t("settings.add")}
              </button>
            </div>
            {newEntry && !newIsValid && (
              <p className="text-xs text-rose-600 dark:text-rose-300 mt-1">
                {t("settings.invalidId")}
              </p>
            )}
            {newIsDuplicate && (
              <p className="text-xs text-amber-600 dark:text-amber-300 mt-1">
                {t("settings.duplicateId")}
              </p>
            )}
            <p className="text-xs opacity-60 mt-1 leading-snug">
              {t("settings.reportIdHint")}
            </p>
          </>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="pill surface-1 surface-1-hover text-sm"
          >
            {t("edit.cancel")}
          </button>
          <button
            type="button"
            onClick={() => canSave && onSave(drafts)}
            disabled={!canSave}
            className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30 text-sm font-medium"
          >
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
