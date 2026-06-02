import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Header, ALL_LOCATIONS, type LocationFilter } from "./components/Header";
import { DonutCard } from "./components/DonutCard";
import { LegendCard } from "./components/LegendCard";
import { DetailsTable } from "./components/DetailsTable";
import { ActivityLog } from "./components/ActivityLog";
import { TextTooltip } from "./components/TextTooltip";
import { AuthBanner } from "./components/AuthBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { CaseTabsBar } from "./components/CaseTabsBar";
import { formatAssetPath } from "./assetPath";
import { RegionSettingsModal } from "./components/RegionSettingsModal";
import { PatchplanExplorer } from "./components/PatchplanExplorer";

// CaseDetailSheet pulls in chatter, edit modal, lookup combobox, and
// the Coolan components panel — all of which the dashboard doesn't
// need on first paint. Lazy-load it so the initial bundle stays small.
const CaseDetailSheet = lazy(() =>
  import("./components/CaseDetailSheet").then((m) => ({
    default: m.CaseDetailSheet,
  })),
);
import { useCaseSheets } from "./hooks/useCaseSheets";
import { useTooltips } from "./hooks/useTooltips";
import { useLanguage } from "./hooks/useLanguage";
import { useTabRefocus } from "./hooks/useTabRefocus";
import { usePolling } from "./hooks/usePolling";
import {
  fetchActive, fetchActivity, fetchDetails, fetchMe,
  refresh as apiRefresh, type MeResponse,
  getActiveReportIds, setActiveReportIds,
} from "./api";
import { colorForStatus } from "./statusColors";
import type {
  ActivityEvent, ActivityFilter, RmaActiveResponse, RmaTicket,
} from "./types";

export default function App() {
  const [active, setActive] = useState<RmaActiveResponse | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [selectedTickets, setSelectedTickets] = useState<RmaTicket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedLocations, setSelectedLocations] = useState<Set<string>>(
    () => new Set(ALL_LOCATIONS),
  );
  const [includeBots, setIncludeBots] = useState<boolean>(() => {
    try { return localStorage.getItem("widash.includeBots") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("widash.includeBots", includeBots ? "1" : "0"); }
    catch { /* ignore */ }
  }, [includeBots]);

  // Load the active SF user's identity once. Used by the activity-log
  // "Me" filter so it works for any engineer running the dashboard
  // without hardcoding a username.
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null));
  }, []);

  // Region/report settings modal — opens automatically on first run if
  // the user hasn't picked any report yet. After that the gear button
  // in the header re-opens it on demand.
  const [settingsOpen, setSettingsOpen] = useState(
    () => getActiveReportIds().length === 0,
  );
  const [reportIds, setReportIds] = useState<string[]>(
    () => getActiveReportIds(),
  );

  function handleSaveReports(ids: string[]) {
    setActiveReportIds(ids);
    setReportIds(ids);
    setSettingsOpen(false);
    // Force a reload so every cached fetcher (active rmas, activity,
    // case detail) re-issues its requests with the new X-Report-Id
    // header. Simpler than threading state through every memo.
    window.location.reload();
  }

  const {
    tooltips, openText, openLinks, openKv, close: closeTooltip, focus: focusTooltip,
  } = useTooltips();
  const { t } = useLanguage();
  const caseSheets = useCaseSheets();

  function toggleLocation(loc: LocationFilter) {
    setSelectedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(loc)) {
        // Don't allow zero locations — re-enable all if user tries to remove the last one.
        if (next.size === 1) return new Set(ALL_LOCATIONS);
        next.delete(loc);
      } else {
        next.add(loc);
      }
      return next;
    });
  }

  async function loadAll() {
    setError(null);
    setAuthExpired(false);
    setLoading(true);
    try {
      const [a, ev] = await Promise.all([
        fetchActive(selectedLocations),
        fetchActivity(filter, 200, selectedLocations, includeBots),
      ]);
      setActive(a);
      setEvents(ev.events);
    } catch (err: any) {
      if (err?.error === "auth_expired") {
        setAuthExpired(true);
      } else {
        setError(err?.message ?? t("common.unknownError"));
      }
    } finally {
      setLoading(false);
    }
  }

  /** Like loadAll but without the big loading spinner — used by the
   *  15s background poll so the dashboard refreshes invisibly. Auth
   *  errors still surface via the existing banner. */
  async function loadAllSilent() {
    try {
      const [a, ev] = await Promise.all([
        fetchActive(selectedLocations),
        fetchActivity(filter, 200, selectedLocations, includeBots),
      ]);
      setActive(a);
      setEvents(ev.events);
      // Refresh the open details list too so a status change is
      // reflected in the table the user might be staring at.
      if (selectedStatus) {
        const detail = await fetchDetails(selectedStatus, selectedLocations);
        setSelectedTickets(detail.tickets);
      }
      setAuthExpired(false);
    } catch (err: any) {
      if (err?.error === "auth_expired") {
        setAuthExpired(true);
      }
      // Silent path: don't toast non-auth errors, just leave stale
      // data on screen and try again on the next tick.
    }
  }

  const didMount = useRef(false);
  useEffect(() => { loadAll(); didMount.current = true; /* initial */ }, []); // eslint-disable-line
  // Refresh dashboard data when the user comes back to the tab after
  // being away for >30s. Read-only — the case sheet manages its own
  // refocus path with its own block conditions.
  useTabRefocus(() => { loadAll(); });
  // Background polling so a status change made elsewhere (a colleague,
  // GUS itself, our own write from inside an open sheet) propagates
  // to the donut + activity log without the user having to refresh.
  // Pure GETs; pauses while the tab is hidden.
  usePolling(async () => { await loadAllSilent(); }, 15_000);
  useEffect(() => {
    if (!didMount.current) return;
    setLoading(true);
    Promise.all([
      fetchActive(selectedLocations).then(setActive),
      fetchActivity(filter, 200, selectedLocations, includeBots).then((r) => setEvents(r.events)),
      selectedStatus
        ? fetchDetails(selectedStatus, selectedLocations)
            .then((d) => setSelectedTickets(d.tickets))
        : Promise.resolve(),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter, selectedLocations, includeBots]); // eslint-disable-line

  async function handleSegmentClick(status: string) {
    if (selectedStatus === status) {
      setSelectedStatus(null);
      setSelectedTickets([]);
      return;
    }
    const detail = await fetchDetails(status, selectedLocations);
    setSelectedStatus(status);
    setSelectedTickets(detail.tickets);
  }

  async function handleRefresh() {
    await apiRefresh();
    await loadAll();
    if (selectedStatus) {
      const detail = await fetchDetails(selectedStatus, selectedLocations);
      setSelectedTickets(detail.tickets);
    }
  }

  function handleOpenTicket(ticket: RmaTicket) {
    const bucket = active?.buckets.find((b) => b.status === ticket.status);
    caseSheets.open(ticket, {
      status: ticket.status,
      statusColor: bucket?.color ?? colorForStatus(ticket.status),
    });
  }

  /** Activity-log row click: only opens a tab for cases still in an
   *  active bucket. The current detail-list (selectedTickets) is the
   *  cheapest hit; anything else triggers a one-shot fetchDetails so
   *  an event in a non-displayed bucket still works. Closed/RTS cases
   *  (not in any active bucket) silently no-op. */
  async function handleOpenFromActivity(caseSfId: string, status?: string | null) {
    // Quick wins first — already in memory.
    const fromSelected = selectedTickets.find((tk) => tk.id === caseSfId);
    if (fromSelected) { handleOpenTicket(fromSelected); return; }
    if (!status) return;
    const inActiveBucket = active?.buckets.some((b) => b.status === status);
    if (!inActiveBucket) return;
    try {
      const detail = await fetchDetails(status, selectedLocations);
      const found = detail.tickets.find((tk) => tk.id === caseSfId);
      if (found) handleOpenTicket(found);
    } catch { /* ignore */ }
  }

  function handleOpenCoolan(ticket: RmaTicket, anchor: { x: number; y: number }) {
    const state = ticket.coolanReportingState;
    const stateLine =
      state === "missing"
        ? t("details.coolanStateMissing")
        : state === "active"
          ? t("details.coolanStateActive")
          : state === "unknown"
            ? t("details.coolanStateUnknown")
            : undefined;
    openLinks(
      `coolan:${ticket.id}`,
      t("details.coolanTooltipTitle", { name: ticket.name }),
      ticket.coolanLinks,
      anchor,
      ticket.coolanLinks.length === 0 ? t("details.coolanNoneAvailable") : undefined,
      stateLine,
    );
  }

  function handleOpenComponent(
    ticket: RmaTicket,
    component: import("./types").CoolanComponent,
    anchor: { x: number; y: number },
  ) {
    // Tooltip header ties the component back to the ticket so the
    // engineer never loses context when they have several Coolan
    // tooltips open at once. Status pill mirrors the in-table colours.
    const tone: "ok" | "warn" | "bad" | "muted" =
      component.effective_state === "ACTIVE" ? "ok"
      : component.effective_state === "DEGRADED"
        || component.effective_state === "WARNING"
        || component.effective_state === "ANOMALOUS" ? "warn"
      : component.effective_state === "REMOVED"
        || component.effective_state === "MISSING"
        || component.effective_state === "FAILED"
        || component.effective_state === "CRITICAL" ? "bad"
      : "muted";
    // Header line gives the engineer two anchors: the case number
    // (so the tooltip never gets confused between several open
    // components) and the rack-slot path (so they can find the unit
    // without flipping back to the sheet header).
    const slot = formatAssetPath(
      ticket.assetLocationPath, ticket.assetName,
      { includeSitePrefix: true },
    );
    const headerLine = slot
      ? `${t("details.componentTooltipFor", { ticketId: ticket.name })}\n${slot}`
      : t("details.componentTooltipFor", { ticketId: ticket.name });
    openKv(
      `component:${ticket.id}:${component.asset_type}:${component.display_name}`,
      `${component.asset_type} · ${component.display_name}`,
      component.attributes ?? [],
      anchor,
      {
        headerLine,
        statusText: component.effective_state,
        statusTone: tone,
        emptyText: t("details.componentNoAttributes"),
      },
    );
  }

  return (
    <div className="min-h-screen p-6 max-w-[1400px] mx-auto">
      <UpdateBanner />
      <Header
        onRefresh={handleRefresh}
        selectedLocations={selectedLocations}
        onToggleLocation={toggleLocation}
        locationCounts={active?.locationCounts}
        sites={active?.sites}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {authExpired && <AuthBanner onRetry={handleRefresh} />}
      {error && (
        <div className="glass p-4 mb-6 border border-red-500/50 text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {active ? (
          <>
            <DonutCard
              buckets={active.buckets}
              onSegmentClick={handleSegmentClick}
              returnToServiceToday={active.returnToServiceToday}
            />
            <LegendCard
              buckets={active.buckets}
              returnToServiceToday={active.returnToServiceToday}
              myRtsOpen={active.myRtsOpen}
              myRtsClosedTotal={active.myRtsClosedTotal}
            />
          </>
        ) : (
          <div className="glass p-6 col-span-2 text-center opacity-60">
            {t("common.loadingData")}
          </div>
        )}
      </div>

      <AnimatePresence>
        {selectedStatus && (
          <DetailsTable
            status={selectedStatus}
            statusColor={
              active?.buckets.find((b) => b.status === selectedStatus)?.color
            }
            tickets={selectedTickets}
            onClose={() => {
              setSelectedStatus(null);
              setSelectedTickets([]);
            }}
            onOpenText={openText}
            onOpenCoolan={handleOpenCoolan}
            onOpenTicket={handleOpenTicket}
          />
        )}
      </AnimatePresence>

      <ActivityLog
        events={events}
        filter={filter}
        onFilterChange={setFilter}
        onOpenText={openText}
        // The lookup just answers "is this case still in an active
        // bucket and therefore openable?". Returning a stub ticket is
        // enough for the panel to render the row as clickable; the
        // real RmaTicket comes from handleOpenFromActivity on click.
        onLookupTicket={(caseSfId) => {
          const fromSelected = selectedTickets.find((tk) => tk.id === caseSfId);
          if (fromSelected) return fromSelected;
          const ev = events.find((e) => e.ticketSfId === caseSfId);
          if (!ev || !ev.caseStatus) return undefined;
          if (!active?.buckets.some((b) => b.status === ev.caseStatus)) {
            return undefined;
          }
          return { id: caseSfId, status: ev.caseStatus } as RmaTicket;
        }}
        onOpenTicket={(ticket) => {
          handleOpenFromActivity(ticket.id, ticket.status);
        }}
        me={me}
        includeBots={includeBots}
        onToggleIncludeBots={() => setIncludeBots((v) => !v)}
      />

      {tooltips.map((t, i) => (
        <TextTooltip
          key={t.id}
          tooltip={t}
          onClose={closeTooltip}
          onFocus={focusTooltip}
          zIndex={2100 + i}
        />
      ))}

      {loading && (
        <div
          role="status"
          aria-live="polite"
          className="solid-panel fixed bottom-6 right-6 px-4 py-2 text-sm flex items-center gap-2"
          style={{ zIndex: 2000 }}
        >
          <span className="inline-block animate-spin">⟳</span>
          <span>{t("common.loading")}</span>
        </div>
      )}

      {/* Currently maximized case sheet — at most one at a time.
          Wrapped in Suspense so the lazy chunk fetch shows a small
          loading line instead of a blank screen on first open. */}
      {caseSheets.sheets
        .filter((s) => !s.minimized)
        .slice(-1)
        .map((s) => (
          <Suspense
            key={s.id}
            fallback={
              <div
                className="solid-panel fixed bottom-6 right-6 px-4 py-2 text-sm flex items-center gap-2"
                style={{ zIndex: 2000 }}
              >
                <span className="inline-block animate-spin">⟳</span>
                <span>{t("common.loading")}</span>
              </div>
            }
          >
          <CaseDetailSheet
            key={s.id}
            ticket={s.ticket}
            status={s.status}
            statusColor={s.statusColor}
            heightVh={s.heightVh}
            tabsPinned={caseSheets.tabsPinned}
            onClose={() => caseSheets.close(s.id)}
            onMinimize={() => caseSheets.minimize(s.id)}
            onResize={(vh) => caseSheets.setHeight(s.id, vh)}
            onToggleTabsPinned={caseSheets.toggleTabsPinned}
            onOpenCoolan={handleOpenCoolan}
            onOpenComponent={handleOpenComponent}
            onStatusChanged={(newStatus) => {
              // Prefer the live bucket colour (in case a future override
              // diverges from the static map), fall back to the local
              // helper so terminal statuses like Closed / RTS still get
              // the right colour even when they're not active.
              const bucket = active?.buckets.find(
                (b) => b.status === newStatus,
              );
              caseSheets.updateStatus(
                s.id, newStatus,
                bucket?.color ?? colorForStatus(newStatus),
              );
              // Push the change straight to the donut + activity log
              // instead of waiting up to 15s for the next poll —
              // most "I just edited this case" feedback is jarring
              // when the dashboard sits stale on the side.
              void loadAllSilent();
            }}
          />
          </Suspense>
        ))}

      <CaseTabsBar
        sheets={caseSheets.sheets}
        pinned={caseSheets.tabsPinned}
        onRestore={caseSheets.restore}
        onClose={caseSheets.close}
      />

      <RegionSettingsModal
        open={settingsOpen}
        reportIds={reportIds}
        onSave={handleSaveReports}
        onClose={() => {
          // Don't allow closing without at least one report id on first
          // run — the dashboard would have nothing to fetch.
          if (reportIds.length > 0) setSettingsOpen(false);
        }}
      />

      <PatchplanExplorer />
    </div>
  );
}
