import { useEffect, useRef } from "react";

/**
 * Fire ``onRefocus`` when the browser tab regains visibility AFTER
 * being hidden for at least ``minHiddenMs``.
 *
 * Used by the dashboard + open case sheets to refresh stale data when
 * the user comes back to the tab. The ``isBlocked`` callback lets the
 * caller veto a refresh — typically while the user has unsaved drafts,
 * a write is in flight, or the confirm modal is open. The hook never
 * issues writes itself; it just triggers a re-fetch in the parent.
 */
export function useTabRefocus(
  onRefocus: () => void,
  isBlocked: () => boolean = () => false,
  minHiddenMs = 30_000,
): void {
  const hiddenAt = useRef<number | null>(null);
  // Keep the latest callbacks in refs so the visibilitychange listener
  // doesn't need to be re-bound on every render.
  const onRefocusRef = useRef(onRefocus);
  const isBlockedRef = useRef(isBlocked);
  useEffect(() => { onRefocusRef.current = onRefocus; }, [onRefocus]);
  useEffect(() => { isBlockedRef.current = isBlocked; }, [isBlocked]);

  useEffect(() => {
    function handle() {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      if (document.visibilityState !== "visible") return;
      const since = hiddenAt.current;
      hiddenAt.current = null;
      if (since == null) return;
      if (Date.now() - since < minHiddenMs) return;
      if (isBlockedRef.current()) return;
      onRefocusRef.current();
    }
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [minHiddenMs]);
}
