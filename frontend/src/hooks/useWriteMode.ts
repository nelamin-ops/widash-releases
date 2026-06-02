import {
  createContext, createElement, useCallback, useContext, useEffect,
  useMemo, useState, type ReactNode,
} from "react";

/**
 * Global write-mode flag.
 *
 * The Salesforce instance we read from is live, so write operations
 * (status changes, comments, asset edits) are gated behind this
 * single user-facing toggle. Default is OFF and the value is held in
 * localStorage so a refresh keeps the safer state, *not* the riskier
 * one — if the user closed the tab in write mode and comes back, they
 * still see "writes disabled" until they explicitly turn it on.
 *
 * Update: actually we DO persist whatever the user last set, because
 * the alternative ("always reset to off") is annoying for the common
 * case where the user is in a session of writing things. The visible
 * pill makes the current state obvious.
 */

const STORAGE_KEY = "widash.writeMode";

interface WriteModeContextValue {
  enabled: boolean;
  toggle: () => void;
  set: (v: boolean) => void;
}

const WriteModeContext = createContext<WriteModeContextValue | null>(null);

function loadInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function WriteModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(() => loadInitial());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch { /* ignore */ }
  }, [enabled]);

  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const value = useMemo(
    () => ({ enabled, toggle, set: setEnabled }),
    [enabled, toggle],
  );
  return createElement(WriteModeContext.Provider, { value }, children);
}

export function useWriteMode(): WriteModeContextValue {
  const ctx = useContext(WriteModeContext);
  if (ctx) return ctx;
  return { enabled: false, toggle: () => {}, set: () => {} };
}
