import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "widash:collapsed:";

function storageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function readInitial(id: string): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}

/**
 * Persisted collapsed-state for a named section. The boolean lives in
 * localStorage under ``widash:collapsed:<id>`` and survives reloads, so
 * a section the user always closes (e.g. Coolan Components on a Cisco
 * RMA) stays closed across cases.
 */
export function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readInitial(id));

  useEffect(() => {
    try {
      if (collapsed) localStorage.setItem(storageKey(id), "1");
      else localStorage.removeItem(storageKey(id));
    } catch {
      /* localStorage may be disabled — non-fatal */
    }
  }, [id, collapsed]);

  const toggle = useCallback(() => setCollapsed((v) => !v), []);
  return [collapsed, toggle];
}
