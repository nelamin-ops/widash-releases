import { useLanguage } from "../hooks/useLanguage";
import { useWriteMode } from "../hooks/useWriteMode";

/**
 * Header pill that gates every Salesforce write the dashboard could make.
 *
 * Same visual language as the Coolan pill (round dot + label) so the two
 * status indicators sit next to each other consistently. Default off,
 * persisted in localStorage. Off = warm grey, on = amber/red so it's
 * impossible to miss when writes are armed.
 */
export function WriteModePill() {
  const { t } = useLanguage();
  const { enabled, toggle } = useWriteMode();
  const dotColor = enabled ? "#F87171" : "#94A3B8";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled ? t("writeMode.titleOn") : t("writeMode.titleOff")}
      className={`pill flex items-center gap-1.5 text-xs transition-colors ${
        enabled
          ? "bg-rose-500/20 text-rose-700 dark:text-rose-200 hover:bg-rose-500/30"
          : "surface-1 surface-1-hover"
      }`}
    >
      <span aria-hidden style={{ color: dotColor }}>✎</span>
      <span aria-hidden
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: dotColor }}
      />
      <span>{enabled ? t("writeMode.on") : t("writeMode.off")}</span>
    </button>
  );
}
