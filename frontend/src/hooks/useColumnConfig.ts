import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_COLUMN_ORDER, DETAILS_COLUMN_INDEX, type DetailsColumnId,
} from "../components/detailsColumns";

/**
 * Generic column-config store: persists order + hidden-set in
 * localStorage under a namespaced key. The DetailsTable wrapper at
 * the bottom of this file preserves the original (non-generic) call
 * site so existing imports keep working.
 */
export function useGenericColumnConfig<Id extends string>(
  namespace: string,
  defaultOrder: readonly Id[],
  knownIds: ReadonlySet<Id>,
) {
  const orderKey = `widash.${namespace}.columnOrder`;
  const hiddenKey = `widash.${namespace}.hiddenColumns`;

  function loadOrder(): Id[] {
    try {
      const raw = localStorage.getItem(orderKey);
      if (!raw) return defaultOrder.slice();
      const parsed = JSON.parse(raw) as string[];
      const known = parsed.filter((id) => knownIds.has(id as Id)) as Id[];
      const missing = defaultOrder.filter((id) => !known.includes(id));
      return [...known, ...missing];
    } catch {
      return defaultOrder.slice();
    }
  }
  function loadHidden(): Set<Id> {
    try {
      const raw = localStorage.getItem(hiddenKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as string[];
      return new Set(parsed.filter((id) => knownIds.has(id as Id)) as Id[]);
    } catch {
      return new Set();
    }
  }

  const [order, setOrder] = useState<Id[]>(() => loadOrder());
  const [hidden, setHidden] = useState<Set<Id>>(() => loadHidden());

  useEffect(() => {
    try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch {/* ignore */}
  }, [order, orderKey]);
  useEffect(() => {
    try { localStorage.setItem(hiddenKey, JSON.stringify([...hidden])); } catch {/* ignore */}
  }, [hidden, hiddenKey]);

  const toggleVisibility = useCallback((id: Id) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const reorder = useCallback((fromId: Id, toId: Id) => {
    setOrder((prev) => {
      const fromIdx = prev.indexOf(fromId);
      const toIdx = prev.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setOrder(defaultOrder.slice());
    setHidden(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleColumns = order.filter((id) => !hidden.has(id));

  return { order, hidden, visibleColumns, toggleVisibility, reorder, reset };
}

// --- Backwards-compat wrapper for the existing DetailsTable import. ---
const DETAILS_KNOWN_IDS = new Set<DetailsColumnId>(
  Object.keys(DETAILS_COLUMN_INDEX) as DetailsColumnId[],
);

export function useColumnConfig() {
  return useGenericColumnConfig<DetailsColumnId>(
    "details", DEFAULT_COLUMN_ORDER, DETAILS_KNOWN_IDS,
  );
}
