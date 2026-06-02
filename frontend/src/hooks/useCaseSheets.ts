import { useCallback, useEffect, useState } from "react";
import type { RmaTicket } from "../types";

const STORAGE_KEY = "widash.caseSheets";
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
        const existing = prev.find((s) => s.id === ticket.id);
        if (existing) {
          // Re-clicking on the same case re-maximizes its existing sheet
          // and minimizes any other currently-maximized one.
          return prev.map((s) =>
            s.id === ticket.id
              ? { ...s, minimized: false, ticket }
              : { ...s, minimized: true },
          );
        }
        // New case → minimize all existing maximized sheets, push new on top.
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
            heightVh: DEFAULT_HEIGHT_VH,
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
    setSheets((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, minimized: false }
          : { ...s, minimized: true },
      ),
    );
  }, []);

  const setHeight = useCallback((id: string, vh: number) => {
    setSheets((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, heightVh: clampHeight(vh) } : s,
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
