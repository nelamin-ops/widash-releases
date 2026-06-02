import { useCallback, useEffect, useRef, useState } from "react";
import { useTabRefocus } from "../hooks/useTabRefocus";
import { usePolling } from "../hooks/usePolling";
import { useCollapsed } from "../hooks/useCollapsed";
import type {
  CaseDetailResponse, CaseDetailSection as ApiSection,
  CoolanComponent, RmaTicket,
} from "../types";
import { useLanguage } from "../hooks/useLanguage";
import { formatAssetPath } from "../assetPath";
import { colorForStatus } from "../statusColors";
import { useWriteMode } from "../hooks/useWriteMode";
import { SHEET_LIMITS } from "../hooks/useCaseSheets";
import {
  useSectionEdits, type SectionKind,
} from "../hooks/useSectionEdits";
import {
  buildMockSections, type SheetField, type SheetSection,
} from "./sheetSections";
import { type ChatterSource, type FeedEntry } from "./sheetChatter";
import { ChatterPanel } from "./ChatterPanel";
import { EditConfirmModal } from "./EditConfirmModal";
import {
  fetchCaseDetail, fetchCaseFeed, fetchCoolanComponents,
  fetchPatchplanCables, refreshPatchplan,
  patchCase, patchAsset, patchChatterEntry,
  postCaseComment, searchLookup,
  type CaseFeedEntry, type PatchplanCable,
} from "../api";

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Pull the device hostname out of the asset name.
 *
 * Asset names look like ``"832245 / CZ20280S3T / e04u08-124-fra"``.
 * The third segment is the GUS Hostname which the master patchplan
 * indexes under. Any of the other segments occasionally have spaces
 * or punctuation, so we deliberately only return the last one.
 */
function extractHostname(ticket: RmaTicket): string {
  const parts = (ticket.assetName || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * Parse the asset location path into (room, rack) for the patchplan
 * lookup. ``Frankfurt - FRA3 - 14.1 - 124 - E04`` → ``{ room: "124",
 * rack: "E04" }``. Last two segments are room then rack; everything
 * before is region / site / floor and irrelevant for the cable index.
 */
function extractRoomRack(ticket: RmaTicket): { room: string; rack: string } {
  const parts = (ticket.assetLocationPath || "")
    .split("-")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return { room: "", rack: "" };
  return {
    room: parts[parts.length - 2],
    rack: parts[parts.length - 1],
  };
}

function extractMachineUuid(ticket: RmaTicket): string | null {
  for (const l of ticket.coolanLinks) {
    const m = UUID_RE.exec(l.url);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

interface CaseDetailSheetProps {
  ticket: RmaTicket;
  status?: string;
  statusColor?: string;
  heightVh: number;
  /** Global "park tabs above the sheet" toggle. Same value for every
   *  sheet — toggling it from any sheet flips it for all of them. */
  tabsPinned: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onResize: (vh: number) => void;
  onToggleTabsPinned: () => void;
  onOpenCoolan: (ticket: RmaTicket, anchor: { x: number; y: number }) => void;
  /** Click on a Coolan component pill — opens the kv-tooltip with the
   *  curated attribute list for that component, scoped to this ticket. */
  onOpenComponent?: (
    ticket: RmaTicket,
    component: CoolanComponent,
    anchor: { x: number; y: number },
  ) => void;
  /** Called after a successful save so the parent can refresh the
   *  cached status / colour shown on the sheet header and the tab. */
  onStatusChanged?: (status: string | undefined) => void;
}

// Fallback list used until the live Status field options arrive from
// the backend describe call. Keep it short and RMA-relevant; the real
// (full) picklist supersedes this once `detail` is loaded.
const STATUS_FALLBACK = [
  "New", "In Progress", "Working",
  "Pending Drain", "Drained", "Remediating",
  "Waiting for External Party", "Escalated",
  "Return to Service", "HW Repaired",
  "Resolved", "Closed",
];

export function CaseDetailSheet({
  ticket, status, statusColor, heightVh, tabsPinned,
  onClose, onMinimize, onResize, onToggleTabsPinned,
  onOpenCoolan, onOpenComponent, onStatusChanged,
}: CaseDetailSheetProps) {
  const { t } = useLanguage();
  const dragRef = useRef<HTMLDivElement | null>(null);
  const startState = useRef<{ y: number; vh: number } | null>(null);
  const [statusEditOpen, setStatusEditOpen] = useState(false);
  const [components, setComponents] = useState<CoolanComponent[] | null>(null);
  const [componentsErr, setComponentsErr] = useState<string | null>(null);
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [cables, setCables] = useState<PatchplanCable[] | null>(null);
  const [cablesLoading, setCablesLoading] = useState(false);
  const [cablesTotalIndexed, setCablesTotalIndexed] = useState(0);
  const [cablesSearch, setCablesSearch] = useState("");
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [chatter, setChatter] = useState<FeedEntry[]>([]);
  const [chatterLoading, setChatterLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeToast, setWriteToast] = useState<string | null>(null);
  const writeMode = useWriteMode();
  const editor = useSectionEdits();

  // Drag-to-resize: pointer down on the handle starts a drag, pointer up
  // ends it. While dragging, mouse Y → height in vh.
  useEffect(() => {
    const handle = dragRef.current;
    if (!handle) return;
    function onPointerDown(e: PointerEvent) {
      startState.current = { y: e.clientY, vh: heightVh };
      handle?.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function onPointerMove(e: PointerEvent) {
      if (!startState.current) return;
      const dy = startState.current.y - e.clientY;
      const dvh = (dy / window.innerHeight) * 100;
      onResize(startState.current.vh + dvh);
    }
    function onPointerUp(e: PointerEvent) {
      if (!startState.current) return;
      handle?.releasePointerCapture(e.pointerId);
      startState.current = null;
    }
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }, [heightVh, onResize]);

  // Auto-dismiss the success/dry-run toast.
  useEffect(() => {
    if (!writeToast) return;
    const id = setTimeout(() => setWriteToast(null), 2500);
    return () => clearTimeout(id);
  }, [writeToast]);

  // Load the case detail (case + asset fields) from the backend so
  // the sheet renders live values instead of the buildMockSections fallback.
  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    editor.clearAll();
    setConfirmOpen(false);
    fetchCaseDetail(ticket.id)
      .then((res) => { if (!cancelled) setDetail(res); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  // Load the live Chatter / CaseComment / Email feed for this case.
  useEffect(() => {
    let cancelled = false;
    setChatterLoading(true);
    setChatter([]);
    fetchCaseFeed(ticket.id, 50)
      .then((res) => {
        if (cancelled) return;
        setChatter(res.entries.map(adaptFeedEntry));
      })
      .catch(() => { if (!cancelled) setChatter([]); })
      .finally(() => { if (!cancelled) setChatterLoading(false); });
    return () => { cancelled = true; };
  }, [ticket.id]);

  // Load Coolan components when the sheet opens for a ticket.
  // Triggered by ticket.id (case Id) so switching cases re-fetches.
  useEffect(() => {
    const uuid = extractMachineUuid(ticket);
    if (!uuid) {
      setComponents(null);
      setComponentsErr(null);
      return;
    }
    let cancelled = false;
    setComponentsLoading(true);
    setComponentsErr(null);
    fetchCoolanComponents(uuid)
      .then((res) => {
        if (cancelled) return;
        setComponents(res.components);
      })
      .catch((err) => {
        if (cancelled) return;
        setComponentsErr(err?.message ?? "Failed to load components");
      })
      .finally(() => { if (!cancelled) setComponentsLoading(false); });
    return () => { cancelled = true; };
  }, [ticket.id, ticket.coolanLinks]);

  // Patchplan: combine hostname + rack + manual search. Server RMAs
  // typically miss the hostname filter (servers aren't indexed in the
  // patchplan), so the rack filter catches all cables landing in the
  // same physical rack — usually the ToR switch's uplinks. The search
  // box lets the engineer narrow down by hand.
  useEffect(() => {
    const host = extractHostname(ticket);
    const { room, rack } = extractRoomRack(ticket);
    const q = cablesSearch.trim();
    if (!host && !(room && rack) && !q) {
      setCables([]);
      return;
    }
    let cancelled = false;
    setCablesLoading(true);
    const id = setTimeout(() => {
      fetchPatchplanCables({ hostname: host, room, rack, q })
        .then((res) => {
          if (cancelled) return;
          setCables(res.cables);
          setCablesTotalIndexed(res.totalIndexed);
        })
        .catch(() => { if (!cancelled) setCables([]); })
        .finally(() => { if (!cancelled) setCablesLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(id); };
  }, [ticket.id, ticket.assetName, ticket.assetLocationPath, cablesSearch]);

  // Live status from the polled detail wins over the cached value the
  // parent passes in — otherwise a colleague's edit (or our own polling
  // refresh) doesn't update the header pill, only the chatter feed.
  const liveStatus = (() => {
    if (!detail) return undefined;
    for (const sec of detail.sections) {
      if (sec.kind !== "case") continue;
      for (const g of sec.groups) {
        const f = g.fields.find((x) => x.apiName === "Status");
        if (f && f.value != null) return String(f.value);
      }
    }
    return undefined;
  })();
  const effectiveStatus = liveStatus ?? status ?? ticket.status;
  const liveStatusColor = liveStatus
    ? colorForStatus(liveStatus)
    : undefined;
  const accent = liveStatusColor ?? statusColor ?? "var(--text-muted)";
  // Live data takes precedence, mock sections are the fallback while
  // the fetch is in flight or if the backend returns nothing.
  const sections: SheetSection[] = detail
    ? detail.sections.map(adaptApiSection)
    : buildMockSections(ticket);

  // Live picklist options for Status — falls back to a short RMA list
  // when the backend hasn't responded yet or doesn't surface the field.
  const statusOptions = (() => {
    const caseSection = detail?.sections.find((s) => s.kind === "case");
    for (const g of caseSection?.groups ?? []) {
      const f = g.fields.find((x) => x.apiName === "Status");
      if (f && f.options.length > 0) return f.options;
    }
    return STATUS_FALLBACK;
  })();

  // Coolan reporting-state pill — same colour semantics as the
  // details-table snowflake: active = green, missing = red,
  // unknown / no record = muted.
  const coolanState = ticket.coolanReportingState;
  const hasCoolan = ticket.coolanLinks.length > 0;
  const coolanColor =
    coolanState === "active" ? "text-emerald-600 dark:text-emerald-300"
    : coolanState === "missing" ? "text-rose-600 dark:text-rose-300"
    : "opacity-60";
  const coolanLabel =
    coolanState === "active" ? "Active"
    : coolanState === "missing" ? "Missing"
    : coolanState === "unknown" ? "Unknown"
    : "";
  const coolanTitleParts: string[] = [];
  if (coolanLabel) coolanTitleParts.push(`Coolan: ${coolanLabel}`);
  if (hasCoolan) coolanTitleParts.push(t("details.colCoolan"));
  if (!hasCoolan && !coolanState) {
    coolanTitleParts.push(t("details.coolanNoneAvailable"));
  }

  function handleStatusPick(next: string) {
    setStatusEditOpen(false);
    if (next === ticket.status) return;
    // Stage the status change as a Case-section draft and pop the
    // confirm modal directly — no section-edit detour needed.
    editor.setFieldDraft("case", "Status", next);
    setConfirmOpen(true);
  }

  function reviewChanges() {
    setConfirmOpen(true);
  }
  function cancelEditFlow() {
    editor.clearAll();
    setConfirmOpen(false);
  }
  function backToEdit() {
    // Keep drafts intact, just close the modal so the user lands back
    // in the inputs.
    setConfirmOpen(false);
    if (!editor.isEditing("case") && !editor.isEditing("asset")) {
      // Drafts came purely from the status pill — open case edit so the
      // user has somewhere to fix things.
      editor.startEdit("case");
    }
  }
  async function performWrite() {
    const changes = editor.computeChanges(detail?.sections ?? []);
    if (changes.length === 0) {
      cancelEditFlow();
      return;
    }
    if (!writeMode.enabled) {
      // Dry-run: never call the backend, just log so the user can see
      // what would have been sent.
      // eslint-disable-next-line no-console
      console.log("[dry-run] would write", ticket.id, ticket.name, changes);
      cancelEditFlow();
      setWriteToast(t("edit.toastDryRun"));
      return;
    }
    setWriteBusy(true);
    setWriteError(null);
    try {
      const caseChanges = changes.filter((c) => c.sobject === "case")
        .map((c) => ({ apiName: c.apiName, value: c.newValue }));
      const assetChanges = changes.filter((c) => c.sobject === "asset")
        .map((c) => ({ apiName: c.apiName, value: c.newValue }));
      if (caseChanges.length > 0) {
        await patchCase(ticket.id, caseChanges);
      }
      if (assetChanges.length > 0 && detail?.assetId) {
        await patchAsset(detail.assetId, assetChanges);
      }
      // Re-read the case so the UI reflects what's actually in SF now.
      const fresh = await fetchCaseDetail(ticket.id);
      setDetail(fresh);
      // If the status changed, propagate so the tab + header colour
      // update without forcing the user to close the sheet.
      const newStatus = fieldFromDetail(fresh, "case", "Status");
      if (newStatus && newStatus !== ticket.status) {
        onStatusChanged?.(String(newStatus));
      }
      cancelEditFlow();
      setWriteToast(t("edit.toastSaved"));
    } catch (err: unknown) {
      const e = err as { error?: string; message?: string } | undefined;
      setWriteError(e?.message ?? t("common.unknownError"));
    } finally {
      setWriteBusy(false);
    }
  }

  async function reloadChatter() {
    try {
      const res = await fetchCaseFeed(ticket.id, 50);
      setChatter(res.entries.map(adaptFeedEntry));
    } catch {
      /* keep stale on error */
    }
  }

  // Auto-refresh both the case detail and the chatter feed when the
  // user comes back to the tab after >30s. Vetoed during edits / saves
  // / open confirm modal so we never overwrite drafts or confuse a
  // diff that's currently on screen.
  const reloadAll = useCallback(async () => {
    try {
      const [det] = await Promise.all([
        fetchCaseDetail(ticket.id),
        reloadChatter(),
      ]);
      setDetail(det);
      // Bubble status changes from a polling reload back to the parent
      // so the cached tab pill / minimised pill colour update too — not
      // just the live header. Without this a colleague's status change
      // never reaches the bottom tab bar.
      const newStatus = fieldFromDetail(det, "case", "Status");
      if (newStatus && String(newStatus) !== ticket.status) {
        onStatusChanged?.(String(newStatus));
      }
    } catch {
      /* keep stale on error */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);
  const isBlocked = useCallback(
    () => editor.anyEditing || confirmOpen || writeBusy,
    [editor.anyEditing, confirmOpen, writeBusy],
  );
  useTabRefocus(reloadAll, isBlocked);
  // Background polling so a colleague's edits to the same case show up
  // without the user having to refocus the tab. Same veto rules: never
  // while editing / confirming / saving. Pauses automatically when the
  // tab is hidden.
  usePolling(reloadAll, 30_000, isBlocked);

  async function handleChatterSubmit(
    body: string, source: ChatterSource, parentId?: string,
  ) {
    // Email is read-only — the panel hides compose for that tab anyway.
    if (source === "email") return;
    if (!writeMode.enabled) {
      // eslint-disable-next-line no-console
      console.log("[dry-run chatter]", source, parentId ?? "top", body);
      setWriteToast(t("edit.toastDryRun"));
      return;
    }
    // Optimistic insert: render the user's draft immediately with a
    // temporary id, then re-fetch so the real SF id (and timestamp)
    // takes over once the write returns.
    const tempId = `temp-${Date.now()}`;
    const optimistic: FeedEntry = {
      id: tempId,
      kind: parentId ? "comment" : "post",
      source,
      parentId,
      author: "You",
      isMine: true,
      at: new Date().toISOString(),
      body,
    };
    setChatter((prev) => [optimistic, ...prev]);
    try {
      await postCaseComment(ticket.id, {
        source, body,
        parentFeedItemId: parentId,
      });
      await reloadChatter();
      setWriteToast(t("edit.toastPosted"));
    } catch (err: unknown) {
      // Roll back the optimistic entry so the user can retry.
      setChatter((prev) => prev.filter((e) => e.id !== tempId));
      const e = err as { message?: string } | undefined;
      setWriteError(e?.message ?? t("common.unknownError"));
      setConfirmOpen(true);
    }
  }

  async function handleChatterEdit(entry: FeedEntry, newBody: string) {
    if (!writeMode.enabled) {
      // eslint-disable-next-line no-console
      console.log("[dry-run chatter edit]", entry.id, newBody);
      setWriteToast(t("edit.toastDryRun"));
      return;
    }
    // Optimistic body swap, with rollback on failure.
    const original = entry.body;
    setChatter((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, body: newBody } : e)),
    );
    try {
      await patchChatterEntry(
        ticket.id, entry.id,
        entry.kind === "post" ? "post" : "comment",
        newBody,
      );
      setWriteToast(t("edit.toastSaved"));
    } catch (err: unknown) {
      setChatter((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, body: original } : e)),
      );
      const e = err as { message?: string } | undefined;
      setWriteError(e?.message ?? t("common.unknownError"));
      setConfirmOpen(true);
    }
  }

  return (
    <div
      role="dialog"
      aria-label={t("sheet.heading", { name: ticket.name })}
      style={{
        position: "fixed",
        left: 0, right: 0, bottom: 0,
        height: `${heightVh}vh`,
        zIndex: 1800,
        borderTop: `2px solid ${accent}`,
        boxShadow: "0 -8px 24px rgba(0,0,0,0.25)",
      }}
      className="solid-panel rounded-none flex flex-col"
    >
      {/* Drag handle */}
      <div
        ref={dragRef}
        title={t("sheet.dragHandle")}
        style={{ touchAction: "none", cursor: "ns-resize" }}
        className="w-full pt-1.5 pb-1 flex items-center justify-center select-none"
      >
        <span
          aria-hidden
          className="block h-1 w-12 rounded-full"
          style={{ background: "var(--text-faint)" }}
        />
      </div>

      {/* Sheet header */}
      <div className="flex items-start justify-between px-6 pt-1 pb-3 border-b border-soft gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <span
            aria-hidden
            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: accent }}
          />
          <h2 className="text-xl font-semibold font-mono">{ticket.name}</h2>
          {ticket.assetLocationPath && (
            <span
              className="text-xl font-semibold font-mono opacity-70 truncate"
              title={ticket.assetLocationPath}
            >
              {formatAssetPath(
                ticket.assetLocationPath,
                ticket.assetName,
                { includeSitePrefix: true },
              )}
            </span>
          )}
          {/* Status with edit affordance */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setStatusEditOpen((v) => !v)}
              title={t("sheet.editStatus")}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md surface-1-hover text-sm"
              style={{ color: accent }}
            >
              {effectiveStatus}
              <span aria-hidden className="opacity-60 text-xs">✎</span>
            </button>
            {statusEditOpen && (
              <div
                role="listbox"
                className="solid-panel absolute top-full left-0 mt-1 py-1 min-w-[220px] z-50 text-sm max-h-72 overflow-y-auto"
              >
                {statusOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    role="option"
                    aria-selected={opt === effectiveStatus}
                    onClick={() => handleStatusPick(opt)}
                    className={`block w-full text-left px-3 py-1.5 surface-1-hover ${
                      opt === effectiveStatus ? "font-medium" : ""
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Coolan reporting state — same colour scheme as the
              details table, click opens the standard tooltip. */}
          <button
            type="button"
            disabled={!hasCoolan && !coolanState}
            aria-label={t("details.colCoolan")}
            title={coolanTitleParts.join(" · ")}
            onClick={(ev) => {
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenCoolan(ticket, { x: r.right, y: r.bottom + 4 });
            }}
            className={`pill text-xl leading-none ${coolanColor} ${
              hasCoolan || coolanState
                ? "surface-1-hover cursor-pointer"
                : "opacity-30 cursor-not-allowed"
            }`}
          >
            ❄
          </button>

          {/* Case Category / Subcategory / Resolution — picker pills
              that stage a draft and pop the confirm modal directly,
              same flow as the Status pill. */}
          {(() => {
            const catField = fullFieldFromDetail(detail, "case", "SM_Case_Category__c");
            const subField = fullFieldFromDetail(detail, "case", "SM_Case_Subcategory__c");
            const resField = fullFieldFromDetail(detail, "case", "SM_Case_Resolution__c");
            // Effective parent for the Subcategory dropdown — drafted
            // Category wins so cascading reflects the in-progress edit.
            const draftedCat = editor.getDraft("case", "SM_Case_Category__c");
            const effectiveCatId =
              draftedCat !== undefined
                ? (draftedCat as string | null)
                : (catField?.value as string | null | undefined) ?? null;

            function pickCase(
              apiName: string,
              id: string | null,
              name: string | null,
            ) {
              editor.setFieldDraft("case", apiName, id);
              if (id && name) editor.recordLookupName(id, name);
              // Picking a different Category invalidates the existing
              // Subcategory — drop it from the draft so the modal shows
              // the user a clean cascade.
              if (apiName === "SM_Case_Category__c") {
                editor.setFieldDraft("case", "SM_Case_Subcategory__c", null);
              }
              setConfirmOpen(true);
            }
            return (
              <>
                <LookupHeaderPill
                  field={catField}
                  accent={accent}
                  onPick={pickCase}
                />
                <LookupHeaderPill
                  field={subField}
                  accent={accent}
                  parentValue={effectiveCatId}
                  onPick={pickCase}
                />
                <LookupHeaderPill
                  field={resField}
                  accent={accent}
                  onPick={pickCase}
                />
              </>
            );
          })()}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {detailLoading && (
            <span
              role="status"
              aria-live="polite"
              className="pill bg-sky-500/20 text-sky-700 dark:text-sky-200 text-xs flex items-center gap-1.5"
            >
              <span aria-hidden className="inline-block animate-spin">⟳</span>
              {t("sheet.loadingLive")}
            </span>
          )}
          {!detailLoading && detail && (
            <span
              className="pill bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px]"
              title={t("sheet.liveTitle")}
            >
              {t("sheet.liveBadge")}
            </span>
          )}
          {!detailLoading && !detail && (
            <span
              className="pill bg-amber-500/20 text-amber-700 dark:text-amber-200 text-[10px]"
              title={t("sheet.fallbackMock")}
            >
              {t("sheet.cachedBadge")}
            </span>
          )}
          <button
            type="button"
            aria-label={t("sheet.minimize")}
            title={t("sheet.minimize")}
            onClick={onMinimize}
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center text-base leading-none"
          >▾</button>
          <a
            href={ticket.gusUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="GUS"
            title="GUS"
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >↗</a>
          <button
            type="button"
            onClick={onToggleTabsPinned}
            aria-pressed={tabsPinned}
            aria-label={t(tabsPinned ? "sheet.unpinTabs" : "sheet.pinTabs")}
            title={t(tabsPinned ? "sheet.unpinTabs" : "sheet.pinTabs")}
            className={`pill w-9 h-9 flex items-center justify-center ${
              tabsPinned
                ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
                : "surface-1-hover opacity-70"
            }`}
          >📌</button>
          <button
            type="button"
            aria-label={t("sheet.close")}
            title={t("sheet.close")}
            onClick={onClose}
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >✕</button>
        </div>
      </div>

      {/* Body: two columns — fields (75%) + chatter (25%) */}
      <div className="flex-1 min-h-0 flex">
        <div
          className="flex-1 overflow-y-auto px-6 py-4 space-y-6"
          style={{ overscrollBehavior: "contain", flexBasis: "75%" }}
        >
          {!detail && !detailLoading && (
            <p className="text-xs opacity-60 italic">
              {t("sheet.fallbackMock")}
            </p>
          )}
          {sections.map((section) => (
            <SheetSectionView
              key={section.kind}
              section={section}
              accent={section.kind === "case" ? accent : "var(--text-muted)"}
              editing={editor.isEditing(section.kind as SectionKind)}
              onEdit={() => editor.startEdit(section.kind as SectionKind)}
              onCancel={() => editor.cancelEdit(section.kind as SectionKind)}
              onSave={() => reviewChanges()}
              getDraft={(api) => editor.getDraft(section.kind as SectionKind, api)}
              setDraft={(api, v) =>
                editor.setFieldDraft(
                  section.kind as SectionKind, api,
                  v as string | number | boolean | null,
                )
              }
              recordLookupName={editor.recordLookupName}
            />
          ))}
          <CoolanComponentsSection
            components={components}
            loading={componentsLoading}
            error={componentsErr}
            hasMachine={extractMachineUuid(ticket) !== null}
            onOpenComponent={
              onOpenComponent
                ? (c, anchor) => onOpenComponent(ticket, c, anchor)
                : undefined
            }
          />
          <PatchplanConnectionsSection
            cables={cables}
            loading={cablesLoading}
            hostname={extractHostname(ticket)}
            roomRack={extractRoomRack(ticket)}
            totalIndexed={cablesTotalIndexed}
            search={cablesSearch}
            onSearchChange={setCablesSearch}
            onRefresh={async () => {
              setCablesLoading(true);
              try {
                await refreshPatchplan();
                const host = extractHostname(ticket);
                const { room, rack } = extractRoomRack(ticket);
                const res = await fetchPatchplanCables({
                  hostname: host, room, rack, q: cablesSearch.trim(),
                });
                setCables(res.cables);
                setCablesTotalIndexed(res.totalIndexed);
              } finally {
                setCablesLoading(false);
              }
            }}
          />
        </div>
        <div
          className="hidden md:flex shrink-0"
          style={{ flexBasis: "25%", minWidth: 280, width: "25%" }}
        >
          <ChatterPanel
            entries={chatter}
            loading={chatterLoading}
            onSubmit={handleChatterSubmit}
            onEdit={handleChatterEdit}
          />
        </div>
      </div>

      {confirmOpen && (
        <EditConfirmModal
          caseNumber={ticket.name}
          changes={editor.computeChanges(detail?.sections ?? [])}
          onCancel={cancelEditFlow}
          onEdit={backToEdit}
          onConfirm={performWrite}
          busy={writeBusy}
          error={writeError}
        />
      )}

      {writeToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 solid-panel px-4 py-2 text-sm flex items-center gap-2"
          style={{ zIndex: 2300 }}
        >
          <span aria-hidden style={{ color: "#34D399" }}>✓</span>
          <span>{writeToast}</span>
        </div>
      )}
    </div>
  );
}

function SheetSectionView({
  section, accent, editing, onEdit, onCancel, onSave,
  getDraft, setDraft, recordLookupName,
}: {
  section: SheetSection;
  accent: string;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  getDraft: (api: string) => unknown;
  setDraft: (api: string, value: unknown) => void;
  recordLookupName: (id: string, name: string) => void;
}) {
  const { t } = useLanguage();
  const hasEditableField = section.groups.some(
    (g) => g.fields.some((f) => f.editable),
  );
  // Persisted collapse state, scoped by section kind (case / asset).
  const [collapsed, toggleCollapsed] = useCollapsed(`section.${section.kind}`);
  // Keep the section open while the user is editing — collapsing while
  // edits are pending would hide the inputs and the cancel button.
  const effectiveCollapsed = collapsed && !editing;

  return (
    <section className="surface-1 rounded-lg overflow-hidden">
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={{
          borderLeft: `4px solid ${accent}`,
          background: "var(--surface-2)",
        }}
      >
        <CollapseToggle
          collapsed={effectiveCollapsed}
          onToggle={toggleCollapsed}
          label={section.title}
        />
        <h3 className="text-base font-semibold">{section.title}</h3>
        {section.subtitle && (
          <span className="font-mono text-xs opacity-70 truncate flex-1">
            {section.subtitle}
          </span>
        )}
        {hasEditableField && !editing && (
          <button
            type="button"
            onClick={onEdit}
            title={t("sheet.editSection")}
            className="pill surface-1 surface-1-hover text-xs flex items-center gap-1 ml-auto"
          >
            <span aria-hidden>✎</span>
            <span>{t("sheet.editSection")}</span>
          </button>
        )}
      </header>
      {!effectiveCollapsed && (
      <div className="px-4 py-4 space-y-5">
        {section.groups.map((group) => (
          <div key={group.title}>
            <h4 className="text-xs uppercase tracking-wider font-semibold opacity-70 mb-2 pb-1 border-b border-soft">
              {group.title}
            </h4>
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2.5 text-sm">
              {group.fields.map((field) => (
                <FieldView
                  key={field.apiName}
                  field={field}
                  editing={editing}
                  draft={getDraft(field.apiName)}
                  onChange={(v) => setDraft(field.apiName, v)}
                  recordLookupName={recordLookupName}
                  getFieldEffectiveValue={(api) => {
                    const drafted = getDraft(api);
                    if (drafted !== undefined) return drafted;
                    for (const g of section.groups) {
                      const f = g.fields.find((x) => x.apiName === api);
                      if (f) return f.value;
                    }
                    return undefined;
                  }}
                />
              ))}
            </dl>
          </div>
        ))}
        {editing && (
          <div className="flex justify-end gap-2 pt-2 border-t border-soft">
            <button
              type="button"
              onClick={onCancel}
              className="pill surface-1 surface-1-hover text-sm"
            >
              {t("sheet.cancelSection")}
            </button>
            <button
              type="button"
              onClick={onSave}
              className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 text-sm"
            >
              {t("sheet.saveSection")}
            </button>
          </div>
        )}
      </div>
      )}
    </section>
  );
}

/**
 * Disclosure arrow shown to the left of a section heading. Rotates 90°
 * when expanded; collapsed state points right ▶, expanded points down ▼.
 * Uses ``aria-expanded`` so screen readers and tests have a stable hook.
 */
function CollapseToggle({
  collapsed, onToggle, label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  const { t } = useLanguage();
  const aria = collapsed
    ? t("sheet.expandSection", { name: label })
    : t("sheet.collapseSection", { name: label });
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={aria}
      title={aria}
      className="surface-1-hover rounded p-0.5 -ml-1 shrink-0"
    >
      <svg
        viewBox="0 0 24 24" width="14" height="14"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
        aria-hidden focusable="false"
        style={{
          transition: "transform 150ms ease",
          transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
        }}
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

function FieldView({
  field, editing, draft, onChange, recordLookupName,
  getFieldEffectiveValue,
}: {
  field: SheetField;
  editing: boolean;
  draft: unknown;
  onChange: (v: string | boolean | null) => void;
  recordLookupName: (id: string, name: string) => void;
  getFieldEffectiveValue: (apiName: string) => unknown;
}) {
  const display = formatValue(field);
  // In edit mode the draft (if any) wins over the live value, otherwise
  // we seed from the live value so a user typing in a textarea sees what
  // was already there.
  const editValue = draft !== undefined ? draft : field.value;

  return (
    <div className={field.wide ? "sm:col-span-2 lg:col-span-3" : ""}>
      <dt className="text-[11px] uppercase tracking-wide opacity-60 mb-0.5">
        {field.label}
      </dt>
      <dd className={`break-words ${field.mono ? "font-mono text-xs" : ""}`}>
        {editing && field.editable ? (
          <FieldInput
            field={field}
            value={editValue}
            onChange={onChange}
            recordLookupName={recordLookupName}
            getFieldEffectiveValue={getFieldEffectiveValue}
          />
        ) : field.type === "lookup" && field.linkUrl ? (
          <a
            href={field.linkUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline text-sky-700 dark:text-sky-300"
            title={field.linkUrl}
          >
            {field.displayValue || display || "—"}
          </a>
        ) : (
          display !== "" ? display : <span className="opacity-40">—</span>
        )}
      </dd>
    </div>
  );
}

function FieldInput({
  field, value, onChange, recordLookupName, getFieldEffectiveValue,
}: {
  field: SheetField;
  value: unknown;
  onChange: (v: string | boolean | null) => void;
  recordLookupName: (id: string, name: string) => void;
  getFieldEffectiveValue: (apiName: string) => unknown;
}) {
  const v = value === null || value === undefined ? "" : String(value);
  const monoCls = field.mono ? "font-mono text-xs" : "text-sm";
  const baseCls = `w-full p-1.5 rounded-md surface-2 ${monoCls}`;

  if (field.type === "bool") {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{value === true ? "yes" : "no"}</span>
      </label>
    );
  }
  const opts = field.options ?? [];
  if (field.type === "picklist" && opts.length > 0) {
    return (
      <select
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className={baseCls}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (field.type === "textarea") {
    return (
      <textarea
        value={v}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={baseCls}
        style={{ resize: "vertical" }}
      />
    );
  }
  if (field.type === "date") {
    // The SF value is "YYYY-MM-DD"; the input expects the same.
    return (
      <input
        type="date"
        value={v ? v.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={baseCls}
      />
    );
  }
  if (field.type === "datetime") {
    // SF returns ISO with offset; convert to "YYYY-MM-DDTHH:mm" for the
    // datetime-local input. On change, send back the original ISO-ish.
    const local = v ? v.slice(0, 16) : "";
    return (
      <input
        type="datetime-local"
        value={local}
        onChange={(e) => onChange(e.target.value || null)}
        className={baseCls}
      />
    );
  }
  if (field.type === "lookup") {
    const parentApi = field.lookupParentField || null;
    const parentValue = parentApi
      ? (getFieldEffectiveValue(parentApi) as string | null | undefined)
      : null;
    return (
      <LookupCombobox
        field={field}
        value={value as string | null | undefined}
        onChange={(id) => onChange(id ?? null)}
        recordLookupName={recordLookupName}
        parentLookupValue={parentValue ?? null}
      />
    );
  }
  // text / number / multipicklist (best-effort) — plain text input.
  return (
    <input
      type={field.type === "number" || field.type === "currency" ? "number" : "text"}
      value={v}
      onChange={(e) => onChange(e.target.value)}
      className={baseCls}
    />
  );
}

/**
 * Header pill for a lookup picker — same write-flow as the Status pill
 * (open dropdown → choose → stage as Case-section draft → confirm modal
 * pops). Used for Case Category / Subcategory / Resolution which live
 * in the header rather than the body.
 */
function LookupHeaderPill({
  field, accent, parentValue, onPick,
}: {
  field: import("../types").CaseDetailField | undefined;
  accent: string;
  /** For cascading lookups: the parent's resolved id (Category for the
   *  Subcategory pill). Null disables the picker. */
  parentValue?: string | null;
  /** Stage a Case draft change. The parent fires the confirm modal. */
  onPick: (apiName: string, id: string | null, displayName: string | null) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  // Hooks must run unconditionally — derive everything from optional
  // ``field`` and bail out at render time below.
  const sobject = field?.referenceTo?.[0] ?? "";
  const isCascading = !!field?.lookupParentField;
  const lookupListType = field?.lookupListType;
  const lookupRecordTypeFilter = field?.lookupRecordTypeFilter;

  useEffect(() => {
    if (!field) return;
    if (!open) return;
    if (!sobject) return;
    if (isCascading && !parentValue) return;
    let cancelled = false;
    setLoading(true);
    searchLookup(sobject, "", 100, {
      listType: lookupListType,
      recordTypeFilter: lookupRecordTypeFilter,
      parentId: parentValue ?? null,
    })
      .then((res) => { if (!cancelled) setResults(res.results); })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [
    field, open, sobject, parentValue, isCascading,
    lookupListType, lookupRecordTypeFilter,
  ]);

  if (!field) return null;
  const disabled = !field.editable || (isCascading && !parentValue);

  const labelShort = field.label.replace(/^Case\s+/i, "");
  const display = field.displayValue || "—";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={
          disabled && isCascading && !parentValue
            ? t("sheet.pickParentFirst")
            : `${field.label}: ${display}`
        }
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-sm ${
          disabled ? "opacity-40 cursor-not-allowed" : "surface-1-hover"
        }`}
        style={!disabled && field.value ? { color: accent } : undefined}
      >
        <span className="opacity-60 text-xs uppercase tracking-wide">
          {labelShort}:
        </span>
        <span className="truncate max-w-[140px]">
          {display}
        </span>
        {!disabled && (
          <span aria-hidden className="opacity-60 text-xs">✎</span>
        )}
      </button>
      {open && (
        <div
          role="listbox"
          className="solid-panel absolute top-full left-0 mt-1 py-1 min-w-[260px] z-50 text-sm max-h-72 overflow-y-auto"
          onMouseLeave={() => setOpen(false)}
        >
          {loading && (
            <div className="px-3 py-2 italic opacity-60 text-xs">
              {t("common.loading")}
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 italic opacity-60 text-xs">
              {t("chatter.empty")}
            </div>
          )}
          {!loading && results.map((r) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={r.id === field.value}
              onClick={() => {
                onPick(field.apiName, r.id, r.name);
                setOpen(false);
              }}
              className={`block w-full text-left px-3 py-1.5 surface-1-hover ${
                r.id === field.value ? "font-medium" : ""
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LookupCombobox({
  field, value, onChange, recordLookupName, parentLookupValue,
}: {
  field: SheetField;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  recordLookupName: (id: string, name: string) => void;
  /** When this lookup is cascading (Subcategory under Category), the
   *  parent field's currently effective value. Empty / null disables
   *  the dropdown until the parent is set. */
  parentLookupValue?: string | null;
}) {
  // Local UI state is decoupled from the parent draft so the user can
  // type freely without resetting the field id until they pick a result.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(
    value ? field.displayValue ?? null : null,
  );
  const sobject = field.referenceTo?.[0] ?? "";

  // Cascading dropdown: when the parent value changes (e.g. user picks
  // a different Category), drop our current selection — the old
  // Subcategory likely doesn't fit the new Category.
  const isCascading = !!field.lookupParentField;
  useEffect(() => {
    if (!isCascading) return;
    setPicked(null);
    onChange(null);
    setResults([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentLookupValue]);

  // Type-ahead search, debounced. Cascading dropdowns refuse to fetch
  // while the parent is empty — that would just be every Subcategory.
  useEffect(() => {
    if (!sobject) return;
    if (!open) return;
    if (isCascading && !parentLookupValue) return;
    let cancelled = false;
    const id = setTimeout(() => {
      setLoading(true);
      searchLookup(sobject, query, 100, {
        listType: field.lookupListType,
        recordTypeFilter: field.lookupRecordTypeFilter,
        parentId: parentLookupValue ?? null,
      })
        .then((res) => { if (!cancelled) setResults(res.results); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(id); };
  }, [
    sobject, query, open,
    field.lookupListType, field.lookupRecordTypeFilter,
    parentLookupValue, isCascading,
  ]);

  // Currently displayed pill: either a selected name, or "—".
  const currentLabel = picked ?? "—";

  function clear() {
    setPicked(null);
    onChange(null);
  }

  function pick(r: { id: string; name: string }) {
    setPicked(r.name);
    onChange(r.id);
    recordLookupName(r.id, r.name);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 surface-2 rounded-md p-1.5 text-sm">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-1 text-left truncate"
          title="Click to change"
        >
          {currentLabel}
        </button>
        {picked && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear"
            title="Clear"
            className="opacity-60 hover:opacity-100 px-1"
          >✕</button>
        )}
      </div>
      {open && (
        <div
          role="listbox"
          className="solid-panel absolute top-full left-0 mt-1 w-full min-w-[260px] z-50 text-sm"
        >
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Type to search…"
            className="w-full p-2 surface-1 border-b border-soft text-sm"
          />
          <ul className="max-h-64 overflow-y-auto">
            {loading && (
              <li className="px-3 py-2 opacity-60 italic text-xs">Loading…</li>
            )}
            {!loading && results.length === 0 && (
              <li className="px-3 py-2 opacity-60 italic text-xs">No matches</li>
            )}
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                  className="block w-full text-left px-3 py-1.5 surface-1-hover"
                >
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function adaptFeedEntry(e: CaseFeedEntry): FeedEntry {
  return {
    id: e.id,
    kind: e.kind,
    source: e.source,
    parentId: e.parentId,
    author: e.author || e.authorUsername || "—",
    authorUsername: e.authorUsername,
    authorPhotoUrl: e.authorPhotoUrl,
    isMine: e.isMine,
    at: e.at,
    body: e.body,
    fromValue: e.fromValue,
    toValue: e.toValue,
    fieldLabel: e.fieldLabel,
  };
}

function fieldFromDetail(
  detail: CaseDetailResponse | null,
  kind: "case" | "asset",
  apiName: string,
): string | number | boolean | null | undefined {
  const section = detail?.sections.find((s) => s.kind === kind);
  for (const g of section?.groups ?? []) {
    const f = g.fields.find((x) => x.apiName === apiName);
    if (f) return f.value;
  }
  return undefined;
}

function fullFieldFromDetail(
  detail: CaseDetailResponse | null,
  kind: "case" | "asset",
  apiName: string,
) {
  const section = detail?.sections.find((s) => s.kind === kind);
  for (const g of section?.groups ?? []) {
    const f = g.fields.find((x) => x.apiName === apiName);
    if (f) return f;
  }
  return undefined;
}

// Heuristics to keep the live payload visually consistent with the
// mock layout: long-text fields go full-width, machine-style identifiers
// render in monospace.
const WIDE_FIELDS = new Set([
  "Subject", "Description", "SM_Last_Comment__c",
  "Asset_Type_Configuration_Description__c", "Name",
]);
const MONO_FIELDS = new Set([
  "Name", "CaseNumber", "Asset_Number__c", "Tech_Ops_Serial_Number__c",
  "Device_Name__c", "Discovered_Host_Name__c",
  "MAC_Address__c", "DRAC_MAC_Address__c",
]);

// Lookup fields we explicitly DON'T expose as editable, even when the
// describe says they are. Owner is read-only on purpose (reassignment
// goes through Team); CreatedById / LastModifiedById are system fields
// anyway. Showing them as clickable links to GUS is enough.
const READ_ONLY_FIELDS = new Set([
  "OwnerId", "CreatedById", "LastModifiedById",
]);

function adaptApiSection(s: ApiSection): SheetSection {
  return {
    kind: s.kind,
    title: s.title,
    subtitle: s.subtitle,
    // Hidden groups (prefix "__hidden_") carry fields that are rendered
    // elsewhere — e.g. case category pills in the header — and should
    // not appear in the section body.
    groups: s.groups
      .filter((g) => !g.title.startsWith("__hidden_"))
      .map((g) => ({
      title: g.title,
      fields: g.fields.map((f) => ({
        apiName: f.apiName,
        label: f.label,
        value: f.value,
        type: f.type,
        editable: f.editable && !READ_ONLY_FIELDS.has(f.apiName),
        options: f.options,
        sobject: s.kind === "case" ? "Case" : "Tech_Asset__c",
        wide: WIDE_FIELDS.has(f.apiName),
        mono: MONO_FIELDS.has(f.apiName),
        displayValue: f.displayValue,
        linkUrl: f.linkUrl,
        referenceTo: f.referenceTo,
        lookupListType: f.lookupListType,
        lookupRecordTypeFilter: f.lookupRecordTypeFilter,
        lookupParentField: f.lookupParentField,
      })),
    })),
  };
}

function PatchplanConnectionsSection({
  cables, loading, hostname, roomRack, totalIndexed,
  search, onSearchChange, onRefresh,
}: {
  cables: PatchplanCable[] | null;
  loading: boolean;
  hostname: string;
  roomRack: { room: string; rack: string };
  totalIndexed: number;
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => Promise<void>;
}) {
  // Hooks must run unconditionally before any early return — Rules of
  // Hooks. A whitescreen-bug from this exact pattern is documented in
  // CLAUDE.md.
  const [collapsed, toggleCollapsed] = useCollapsed("section.connections");
  // Hide the section entirely when there's no asset context AND no
  // CSV data — keeps the sheet uncluttered for non-network RMAs.
  const hasContext =
    !!hostname || (!!roomRack.room && !!roomRack.rack);
  if (!hasContext && !search) return null;
  if (totalIndexed === 0 && (cables?.length ?? 0) === 0 && !search) {
    return null;
  }

  const list = cables ?? [];
  const matchLabel = (() => {
    const parts: string[] = [];
    if (hostname) parts.push(hostname);
    if (roomRack.room && roomRack.rack) {
      parts.push(`${roomRack.room}-${roomRack.rack}`);
    }
    return parts.length ? parts.join(" / ") : "—";
  })();

  function statusPill(c: PatchplanCable) {
    const v = (c.cabled || "").toLowerCase();
    if (v === "x") return { text: "active", tone: "ok" as const };
    if (v === "n") return { text: "planned", tone: "muted" as const };
    if (v === "p") return { text: "partial", tone: "warn" as const };
    return { text: c.cabled || "—", tone: "muted" as const };
  }

  function endLabel(end: PatchplanCable["sideA"]): {
    deviceCell: React.ReactNode;
    locCell: React.ReactNode;
  } {
    const loc = [end.room, end.rack, end.uLoc].filter(Boolean).join("-");
    return {
      deviceCell: (
        <span title={end.device} className="font-mono">
          {end.device ? <strong>{end.device}</strong> : <span className="opacity-40">—</span>}
          {end.port && (
            <>
              <span className="opacity-50">:</span>
              <span>{end.port}</span>
            </>
          )}
        </span>
      ),
      locCell: loc ? (
        <span className="font-mono opacity-80" title={loc}>{loc}</span>
      ) : <span className="opacity-30">—</span>,
    };
  }

  function hopsCell(hops: PatchplanCable["hops"]): React.ReactNode {
    if (hops.length === 0) {
      return <span className="opacity-50" aria-hidden>→</span>;
    }
    return (
      <span className="font-mono opacity-90" title={hops.map((h) => `${h.label} ${h.panel}${h.port ? ":" + h.port : ""}`).join(" → ")}>
        {hops.map((h, i) => (
          <span key={i}>
            <span className="opacity-50">→ </span>
            <span>{h.panel}</span>
            {h.port && <span className="opacity-60">:{h.port}</span>}
            {" "}
          </span>
        ))}
        <span className="opacity-50">→</span>
      </span>
    );
  }

  return (
    <section className="surface-1 rounded-lg overflow-hidden">
      <header
        className="flex items-center gap-3 flex-wrap px-4 py-3"
        style={{ borderLeft: "4px solid #818CF8", background: "var(--surface-2)" }}
      >
        <CollapseToggle
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          label="Connections"
        />
        <h3 className="text-base font-semibold">Connections</h3>
        <span className="text-sm opacity-70">
          <strong>{list.length}</strong>
          <span className="opacity-60"> cables · </span>
          <span className="font-mono">{matchLabel}</span>
        </span>
        {!collapsed && (
          <>
            <input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter (device / port / cable id)…"
              aria-label="Filter cables"
              className="surface-1 surface-1-hover rounded-md px-3 py-1 text-sm w-64 ml-auto"
            />
            <button
              type="button"
              onClick={() => { void onRefresh(); }}
              disabled={loading}
              className="pill text-sm surface-1 surface-1-hover disabled:opacity-50"
              title="Re-read patchplan CSVs"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </>
        )}
      </header>
      {!collapsed && (
      <div className="px-4 py-3">
        {loading && list.length === 0 && (
          <div className="text-sm opacity-60 italic">Loading…</div>
        )}
        {!loading && list.length === 0 && (
          <div className="text-sm opacity-60 italic">
            No cables found for this hostname.
          </div>
        )}
        {list.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr className="text-left opacity-60 text-xs uppercase tracking-wide">
                  <th className="py-2 pr-3 whitespace-nowrap">Cable</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Status</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Type</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Len</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Side A</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Loc A</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Hops</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Side B</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Loc B</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Tab</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const st = statusPill(c);
                  const a = endLabel(c.sideA);
                  const b = endLabel(c.sideB);
                  return (
                    <tr
                      key={c.cableId + ":" + c.tab}
                      className="divider-t align-top"
                    >
                      <td className="py-2 pr-3 font-mono whitespace-nowrap">
                        {c.cableId}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`pill text-xs uppercase tracking-wide whitespace-nowrap ${
                            st.tone === "ok"
                              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
                              : st.tone === "warn"
                                ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
                                : "surface-1 opacity-70"
                          }`}
                        >
                          {st.text}
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {c.cableType || <span className="opacity-30">—</span>}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {c.length || <span className="opacity-30">—</span>}
                      </td>
                      <td className="py-2 pr-3">{a.deviceCell}</td>
                      <td className="py-2 pr-3">{a.locCell}</td>
                      <td className="py-2 pr-3">{hopsCell(c.hops)}</td>
                      <td className="py-2 pr-3">{b.deviceCell}</td>
                      <td className="py-2 pr-3">{b.locCell}</td>
                      <td
                        className="py-2 pr-3 whitespace-nowrap opacity-60"
                        title={c.tab}
                      >
                        {c.tab}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </section>
  );
}

function CoolanComponentsSection({
  components, loading, error, hasMachine, onOpenComponent,
}: {
  components: CoolanComponent[] | null;
  loading: boolean;
  error: string | null;
  hasMachine: boolean;
  onOpenComponent?: (
    component: CoolanComponent,
    anchor: { x: number; y: number },
  ) => void;
}) {
  const [unhealthyOnly, setUnhealthyOnly] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed("section.coolan");

  if (!hasMachine) {
    // No Coolan UUID resolvable — likely a NetApp / non-Coolan asset.
    return null;
  }

  const isUnhealthy = (c: CoolanComponent) => c.effective_state !== "ACTIVE";
  const totalCount = components?.length ?? 0;
  const unhealthyCount = components?.filter(isUnhealthy).length ?? 0;
  const filtered = unhealthyOnly
    ? (components ?? []).filter(isUnhealthy)
    : components ?? [];

  // Group filtered components by asset_type, unhealthy types first.
  const groups = new Map<string, CoolanComponent[]>();
  for (const c of filtered) {
    const key = c.asset_type || "OTHER";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const aBad = groups.get(a)!.some(isUnhealthy);
    const bBad = groups.get(b)!.some(isUnhealthy);
    if (aBad !== bBad) return aBad ? -1 : 1;
    return a.localeCompare(b);
  });

  return (
    <section className="surface-1 rounded-lg overflow-hidden">
      <header
        className="flex items-center gap-3 flex-wrap px-4 py-3"
        style={{ borderLeft: "4px solid #34D399", background: "var(--surface-2)" }}
      >
        <CollapseToggle
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          label="Coolan Components"
        />
        <h3 className="text-base font-semibold">Coolan Components</h3>
        {components && (
          <span className="text-xs opacity-70 font-mono">
            {totalCount} total
            {unhealthyCount > 0 && (
              <>
                {" · "}
                <span className="text-rose-700 dark:text-rose-300">
                  {unhealthyCount} unhealthy
                </span>
              </>
            )}
          </span>
        )}
        {components && unhealthyCount > 0 && !collapsed && (
          <button
            type="button"
            onClick={() => setUnhealthyOnly((v) => !v)}
            aria-pressed={unhealthyOnly}
            className={`pill text-xs ml-auto transition-colors ${
              unhealthyOnly
                ? "bg-rose-500/25 text-rose-700 dark:text-rose-200"
                : "surface-1 surface-1-hover opacity-70"
            }`}
          >
            {unhealthyOnly ? "Showing alerts only" : "Show alerts only"}
          </button>
        )}
      </header>
      {!collapsed && (
      <div className="px-4 py-4">
        {loading && (
          <div className="text-sm opacity-60 italic">Loading components…</div>
        )}
        {error && !loading && (
          <div className="text-sm text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        {!loading && !error && components && components.length === 0 && (
          <div className="text-sm opacity-60 italic">No components reported.</div>
        )}
        {!loading && !error && components && components.length > 0 && filtered.length === 0 && (
          <div className="text-sm opacity-60 italic">
            No unhealthy components. ✓
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-4">
            {sortedKeys.map((type) => (
              <div key={type}>
                <h4 className="text-xs uppercase tracking-wider font-semibold opacity-70 mb-2 pb-1 border-b border-soft">
                  {prettyType(type)}{" "}
                  <span className="opacity-50 font-normal">
                    ({groups.get(type)!.length})
                  </span>
                </h4>
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
                  {groups.get(type)!.map((c, idx) => {
                    // Components with curated attributes get a click
                    // affordance — opens a tooltip with the details
                    // tied back to this ticket.
                    const hasDetails = (c.attributes?.length ?? 0) > 0;
                    const clickable = hasDetails && !!onOpenComponent;
                    return (
                      <li
                        key={`${type}-${idx}`}
                        className="flex items-center gap-2 min-w-0"
                      >
                        <ComponentStatePill state={c.effective_state} />
                        {clickable ? (
                          <button
                            type="button"
                            onClick={(ev) => {
                              const r = (ev.currentTarget as HTMLElement)
                                .getBoundingClientRect();
                              onOpenComponent!(c, { x: r.left, y: r.bottom + 4 });
                            }}
                            className="font-mono text-xs flex-1 truncate text-left hover:underline cursor-pointer"
                            title={`${c.display_name} — click for details`}
                          >
                            {c.display_name || "—"}
                          </button>
                        ) : (
                          <span
                            className="font-mono text-xs flex-1 truncate"
                            title={c.display_name || ""}
                          >
                            {c.display_name || "—"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </section>
  );
}

function ComponentStatePill({ state }: { state: string }) {
  // green = healthy, red = gone, amber = degraded/warning, grey = unknown
  const styles =
    state === "ACTIVE"
      ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
      : state === "REMOVED" || state === "MISSING" || state === "FAILED"
        ? "bg-rose-500/25 text-rose-700 dark:text-rose-200"
        : state === "DEGRADED" || state === "WARNING" || state === "ANOMALOUS"
          ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
          : "surface-2";
  return (
    <span
      className={`pill text-[10px] uppercase tracking-wide whitespace-nowrap ${styles}`}
      style={{ minWidth: 70, textAlign: "center" }}
    >
      {state}
    </span>
  );
}

function prettyType(t: string): string {
  return t.replace(/_/g, " ").toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatValue(field: SheetField): string {
  const v = field.value;
  if (v === null || v === undefined) return "";
  if (field.type === "lookup") return field.displayValue || "";
  if (field.type === "bool") return v ? "✓ yes" : "— no";
  if (field.type === "datetime" && typeof v === "string") {
    try { return new Date(v).toLocaleString(); } catch { return v; }
  }
  if (field.type === "date" && typeof v === "string") {
    try { return new Date(v).toLocaleDateString(); } catch { return v; }
  }
  if (field.type === "currency" && typeof v === "number") {
    return v.toFixed(2);
  }
  return String(v);
}

export { SHEET_LIMITS };
