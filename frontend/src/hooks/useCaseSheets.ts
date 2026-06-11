import { useCallback, useEffect, useState } from "react";
import type { RmaTicket } from "../types";

const STORAGE_KEY = "widash.caseSheets";
// Global "preferred height" — once the user resizes any sheet, every
// subsequent sheet (new or restored) opens at that height instead of
// falling back to 50vh. Persisted so the preference survives reloads.
const PREFERRED_HEIGHT_KEY = "widash.caseSheetHeight";
const DEFAULT_HEIGHT_VH = 50;
const MIN_HEIGHT_VH = 30;
const MAX_HEIGHT_VH = 100;

export interface CaseSheet {
  /** Salesforce case Id (the route key — stable, unlike CaseNumber). */
  id: string;
  /** Display label, e.g. "90524212". */
  caseNumber: string;
  /** Status from the bucket — used for accent colour on the tab. */
  status?: string;
  statusColor?: string;
  /** Snapshot of the ticket so the sheet stays useful even after a refresh. */
  ticket: RmaTicket;
  minimized: boolean;
  heightVh: number;
}

interface PersistedSheet {
  id: string;
  caseNumber: string;
  status?: string;
  statusColor?: string;
  ticket: RmaTicket;
  minimized: boolean;
  heightVh: number;
}

const TABS_PINNED_KEY = "widash.tabsPinned";

function loadInitial(): CaseSheet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedSheet[];
    return parsed.map((s) => ({
      ...s,
      heightVh: clampHeight(s.heightVh ?? DEFAULT_HEIGHT_VH),
    }));
  } catch {
    return [];
  }
}

function clampHeight(vh: number): number {
  return Math.min(MAX_HEIGHT_VH, Math.max(MIN_HEIGHT_VH, vh));
}

function loadTabsPinned(): boolean {
  try { return localStorage.getItem(TABS_PINNED_KEY) === "1"; }
  catch { return false; }
}

function loadPreferredHeight(): number {
  try {
    const raw = localStorage.getItem(PREFERRED_HEIGHT_KEY);
    if (!raw) return DEFAULT_HEIGHT_VH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_HEIGHT_VH;
    return clampHeight(n);
  } catch { return DEFAULT_HEIGHT_VH; }
}

function savePreferredHeight(vh: number): void {
  try { localStorage.setItem(PREFERRED_HEIGHT_KEY, String(vh)); }
  catch { /* ignore */ }
}

export function useCaseSheets() {
  const [sheets, setSheets] = useState<CaseSheet[]>(() => loadInitial());
  /** Global toggle — when true, the bottom tab bar is parked just above
   *  the open sheet instead of at the bottom of the screen. Persisted
   *  in localStorage so it survives reloads. */
  const [tabsPinned, setTabsPinned] = useState<boolean>(() => loadTabsPinned());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sheets));
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [sheets]);

  useEffect(() => {
    try { localStorage.setItem(TABS_PINNED_KEY, tabsPinned ? "1" : "0"); }
    catch { /* ignore */ }
  }, [tabsPinned]);

  const toggleTabsPinned = useCallback(() => {
    setTabsPinned((v) => !v);
  }, []);

  const open = useCallback(
    (
      ticket: RmaTicket,
      meta: { status?: string; statusColor?: string },
    ) => {
      setSheets((prev) => {
        // Whoever becomes the active sheet adopts the preferred height —
        // so a manual resize on case A carries over when the user clicks
        // case B's pill instead of bouncing back to 50vh.
        const preferred = loadPreferredHeight();
        const existing = prev.find((s) => s.id === ticket.id);
        if (existing) {
          return prev.map((s) =>
            s.id === ticket.id
              ? { ...s, minimized: false, ticket, heightVh: preferred }
              : { ...s, minimized: true },
          );
        }
        const minimised = prev.map((s) => ({ ...s, minimized: true }));
        return [
          ...minimised,
          {
            id: ticket.id,
            caseNumber: ticket.name,
            status: meta.status,
            statusColor: meta.statusColor,
            ticket,
            minimized: false,
            heightVh: preferred,
          },
        ];
      });
    },
    [],
  );

  const close = useCallback((id: string) => {
    setSheets((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const minimize = useCallback((id: string) => {
    setSheets((prev) =>
      prev.map((s) => (s.id === id ? { ...s, minimized: true } : s)),
    );
  }, []);

  const restore = useCallback((id: string) => {
    const preferred = loadPreferredHeight();
    setSheets((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, minimized: false, heightVh: preferred }
          : { ...s, minimized: true },
      ),
    );
  }, []);

  const setHeight = useCallback((id: string, vh: number) => {
    const clamped = clampHeight(vh);
    // Persist as the new preferred height so subsequent sheet opens
    // and pill switches inherit it instead of resetting to 50vh.
    savePreferredHeight(clamped);
    setSheets((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, heightVh: clamped } : s,
      ),
    );
  }, []);

  // Sync stale ticket data when fresh details come in (e.g. after refresh).
  const updateTicket = useCallback((ticket: RmaTicket) => {
    setSheets((prev) =>
      prev.map((s) => (s.id === ticket.id ? { ...s, ticket } : s)),
    );
  }, []);

  /** Update the cached status / colour shown on the sheet header and
   *  the minimized tab. Called after a successful save so the user
   *  sees the new colour without having to close the sheet.
   *
   *  Also patches `ticket.status` on the snapshot so re-renders that
   *  fall back to `ticket.status` (e.g. after a reload) pick up the
   *  fresh value too. */
  const updateStatus = useCallback(
    (id: string, status?: string, statusColor?: string) => {
      setSheets((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                statusColor,
                ticket: status ? { ...s.ticket, status } : s.ticket,
              }
            : s,
        ),
      );
    },
    [],
  );

  return {
    sheets, open, close, minimize, restore, setHeight,
    updateTicket, updateStatus,
    tabsPinned, toggleTabsPinned,
  };
}

export const SHEET_LIMITS = {
  MIN: MIN_HEIGHT_VH,
  MAX: MAX_HEIGHT_VH,
  DEFAULT: DEFAULT_HEIGHT_VH,
} as const;
