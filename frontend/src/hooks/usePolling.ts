import { useEffect, useRef } from "react";

/**
 * Run ``onTick`` every ``intervalMs`` while the document is visible.
 * Skipped when ``isBlocked()`` returns true (typically open edits,
 * confirm modal, in-flight save).
 *
 * - Pauses automatically when the tab is hidden so we don't burn API
 *   quota or update the UI behind the user's back. The ``visibilitychange``
 *   listener restarts the timer when the tab is visible again.
 * - Never overlapping calls: the next tick only fires after the
 *   previous ``onTick`` resolves, so a slow request can't pile up
 *   parallel polls.
 */
export function usePolling(
  onTick: () => Promise<void> | void,
  intervalMs = 30_000,
  isBlocked: () => boolean = () => false,
): void {
  const onTickRef = useRef(onTick);
  const isBlockedRef = useRef(isBlocked);
  useEffect(() => { onTickRef.current = onTick; }, [onTick]);
  useEffect(() => { isBlockedRef.current = isBlocked; }, [isBlocked]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        // Will be re-armed by the visibilitychange handler.
        return;
      }
      if (!isBlockedRef.current()) {
        try { await onTickRef.current(); } catch { /* swallow */ }
      }
      if (cancelled) return;
      timer = setTimeout(tick, intervalMs);
    }

    function arm() {
      if (timer) { clearTimeout(timer); timer = null; }
      timer = setTimeout(tick, intervalMs);
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        arm();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
