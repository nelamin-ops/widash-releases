import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  fetchCoolanSnapshot,
  fetchTempsHistory,
  fetchTempsOverview,
  fetchTempsRack,
  type CoolanSnapshotResponse,
  type TempsDevice,
  type TempsHistoryResponse,
  type TempsOverviewResponse,
  type TempsRack,
  type TempsRackResponse,
  type TempsSeries,
} from "../api";
import { useLanguage } from "../hooks/useLanguage";

interface TempsExplorerProps {
  /** Site codes the active report covers, e.g. ["FRA1","FRA2","FRA3"]. */
  sites: string[];
}

const TIMEFRAMES = ["30m", "1h", "6h", "24h", "7d", "30d"] as const;
const AGGS = ["max", "avg", "min"] as const;

type Timeframe = (typeof TIMEFRAMES)[number];
type Agg = (typeof AGGS)[number];

interface DetailContext {
  rack: string;       // fullValue
  device: TempsDevice;
}

/** Pick the "tightest" colour at the right end of the green/yellow/red
 *  scale for a temperature reading. We don't reuse statusColors because
 *  the meaning is different (heat vs. workflow status), but we mirror
 *  the same Tailwind palette so the dashboard stays visually coherent. */
function tempBadgeClass(tempC: number | null): string {
  if (tempC == null) return "surface-2";
  // Thresholds mirror mom.dmz / backend _temp_color: green up to 27°,
  // yellow at 28°, then progressively redder from 29° on.
  if (tempC < 28) return "bg-emerald-500/25 text-emerald-700 dark:text-emerald-200";
  if (tempC < 29) return "bg-yellow-500/30 text-yellow-800 dark:text-yellow-100";
  if (tempC < 30) return "bg-amber-500/30 text-amber-800 dark:text-amber-100";
  if (tempC < 32) return "bg-orange-500/30 text-orange-800 dark:text-orange-100";
  return "bg-rose-500/30 text-rose-800 dark:text-rose-100";
}

export function TempsExplorer({ sites }: TempsExplorerProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [site, setSite] = useState<string>("");
  const [overview, setOverview] = useState<TempsOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);

  // Drilldown state — when a rack is selected we show its devices below
  // (not in a separate route, so the user can flip back without losing
  // the overview scroll position).
  const [activeRack, setActiveRack] = useState<TempsRack | null>(null);
  const [rackDevices, setRackDevices] = useState<TempsRackResponse | null>(null);
  const [rackLoading, setRackLoading] = useState(false);
  const [rackErr, setRackErr] = useState<string | null>(null);

  // Detail chart for one device.
  const [detail, setDetail] = useState<DetailContext | null>(null);

  // Default the dropdown to the first available site whenever the props
  // change (e.g. user switches their active report).
  useEffect(() => {
    if (sites.length === 0) {
      setSite("");
      return;
    }
    if (!sites.includes(site)) setSite(sites[0]);
  }, [sites, site]);

  // External open trigger — the chat sidebar dispatches
  // `widash:open-temps` when the user clicks a rack/room link in an
  // assistant reply. Site / rack / room are pre-selected; the overview
  // fetch effect above takes over from there.
  useEffect(() => {
    function onOpenTemps(ev: Event) {
      const ce = ev as CustomEvent<{
        site?: string; rack?: string;
      }>;
      const detail = ce.detail ?? {};
      const wantSite = (detail.site || "").trim();
      const wantRack = (detail.rack || "").trim();
      if (wantSite && sites.includes(wantSite)) setSite(wantSite);
      // Clear any open detail-chart so we land on the overview/rack view.
      setDetail(null);
      if (wantRack) {
        // We don't know the rack's fullValue without an overview; stash
        // a label-only stub and let the overview-arrival effect upgrade
        // it once the data lands.
        setActiveRack({ fullValue: wantRack, label: wantRack } as TempsRack);
      } else {
        setActiveRack(null);
      }
      setOpen(true);
    }
    window.addEventListener("widash:open-temps", onOpenTemps as EventListener);
    return () => window.removeEventListener("widash:open-temps", onOpenTemps as EventListener);
  }, [sites]);

  // When the overview arrives after an external trigger, upgrade the
  // rack stub to the real TempsRack (with the correct fullValue) so
  // the rack-devices fetch can run.
  useEffect(() => {
    if (!overview || !activeRack) return;
    if (activeRack.fullValue !== activeRack.label) return;  // already real
    const target = activeRack.label.toLowerCase();
    for (const room of overview.rooms ?? []) {
      const hit = (room.racks ?? []).find(
        (r) => r.label.toLowerCase() === target
          || r.fullValue.toLowerCase().endsWith(`- ${target}`)
          || r.fullValue.toLowerCase().endsWith(target),
      );
      if (hit) { setActiveRack(hit); return; }
    }
  }, [overview, activeRack]);

  // Fetch overview when the overlay opens or the site changes.
  useEffect(() => {
    if (!open || !site) return;
    let cancelled = false;
    setOverviewLoading(true);
    setOverviewErr(null);
    fetchTempsOverview(site)
      .then((res) => { if (!cancelled) setOverview(res); })
      .catch((e) => {
        if (!cancelled) setOverviewErr(e?.error ?? "fetch_failed");
      })
      .finally(() => { if (!cancelled) setOverviewLoading(false); });
    return () => { cancelled = true; };
  }, [open, site]);

  // Live-poll the overview every 30s while the overlay is open — matches
  // the backend cache TTL so we hit Argus at most twice per minute. Errors
  // are swallowed so a single failed poll doesn't replace good data with
  // an error state.
  useEffect(() => {
    if (!open || !site) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetchTempsOverview(site);
        if (!stop) setOverview(res);
      } catch { /* keep previous data */ }
    };
    const id = window.setInterval(tick, 30_000);
    return () => { stop = true; window.clearInterval(id); };
  }, [open, site]);

  // Fetch rack devices on demand.
  useEffect(() => {
    if (!open || !site || !activeRack) {
      setRackDevices(null);
      return;
    }
    let cancelled = false;
    setRackLoading(true);
    setRackErr(null);
    fetchTempsRack(site, activeRack.fullValue)
      .then((res) => { if (!cancelled) setRackDevices(res); })
      .catch((e) => {
        if (!cancelled) setRackErr(e?.error ?? "fetch_failed");
      })
      .finally(() => { if (!cancelled) setRackLoading(false); });
    return () => { cancelled = true; };
  }, [open, site, activeRack]);

  // Live-poll the open rack so device temperatures update without a
  // manual refresh while the engineer's watching.
  useEffect(() => {
    if (!open || !site || !activeRack) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetchTempsRack(site, activeRack.fullValue);
        if (!stop) setRackDevices(res);
      } catch { /* keep previous data */ }
    };
    const id = window.setInterval(tick, 30_000);
    return () => { stop = true; window.clearInterval(id); };
  }, [open, site, activeRack]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("temps.fabTitle")}
        aria-label={t("temps.fabTitle")}
        className="fixed bottom-24 right-24 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-2xl transition-transform hover:scale-105 active:scale-95"
        style={{
          zIndex: 1900,
          background: "linear-gradient(135deg, #FB7185, #F97316)",
          color: "white",
        }}
      >
        🌡
      </button>

      {open && createPortal(
        <Overlay
          site={site}
          sites={sites}
          onSiteChange={setSite}
          overview={overview}
          overviewLoading={overviewLoading}
          overviewErr={overviewErr}
          activeRack={activeRack}
          onRackOpen={setActiveRack}
          rackDevices={rackDevices}
          rackLoading={rackLoading}
          rackErr={rackErr}
          onDeviceOpen={(d) =>
            activeRack && setDetail({ rack: activeRack.fullValue, device: d })
          }
          onClose={() => setOpen(false)}
        />,
        document.body,
      )}

      {detail && site && createPortal(
        detail.device.source === "coolan" ? (
          <CoolanSnapshotPanel
            device={detail.device}
            rackLabel={detail.rack}
            onClose={() => setDetail(null)}
          />
        ) : (
          <DetailChart
            site={site}
            device={detail.device}
            rackLabel={detail.rack}
            onClose={() => setDetail(null)}
          />
        ),
        document.body,
      )}
    </>
  );
}

// ----------------------------------------------------------------------------

interface OverlayProps {
  site: string;
  sites: string[];
  onSiteChange: (s: string) => void;
  overview: TempsOverviewResponse | null;
  overviewLoading: boolean;
  overviewErr: string | null;
  activeRack: TempsRack | null;
  onRackOpen: (r: TempsRack | null) => void;
  rackDevices: TempsRackResponse | null;
  rackLoading: boolean;
  rackErr: string | null;
  onDeviceOpen: (d: TempsDevice) => void;
  onClose: () => void;
}

function Overlay(props: OverlayProps) {
  const { t } = useLanguage();
  const {
    site, sites, onSiteChange, overview, overviewLoading, overviewErr,
    activeRack, onRackOpen, rackDevices, rackLoading, rackErr,
    onDeviceOpen, onClose,
  } = props;

  return (
    <div
      role="dialog"
      aria-label={t("temps.modalTitle")}
      className="fixed inset-0 flex items-stretch justify-center px-4 pt-10 pb-10"
      style={{ zIndex: 2400, background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="solid-panel flex flex-col w-full max-w-6xl">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-black/10 dark:border-white/10">
          <div className="flex items-center gap-3">
            <span className="text-xl">🌡</span>
            <h2 className="text-base font-medium">{t("temps.modalTitle")}</h2>
            {sites.length > 1 ? (
              <select
                value={site}
                onChange={(e) => onSiteChange(e.target.value)}
                className="pill surface-1 surface-1-hover text-xs"
              >
                {sites.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <span className="pill surface-1 text-xs">{site || "—"}</span>
            )}
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="pill surface-1-hover"
          >✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-6">
          {overviewLoading && !overview && (
            <div className="opacity-70 text-sm">{t("common.loading")}</div>
          )}
          {overviewErr === "mom_auth_expired" && (
            <div className="text-sm text-amber-700 dark:text-amber-200">
              {t("temps.authMissing")}
            </div>
          )}
          {overviewErr && overviewErr !== "mom_auth_expired" && (
            <div className="text-sm text-rose-700 dark:text-rose-200">
              {t("temps.fetchFailed")}
            </div>
          )}
          {overview && overview.rooms.length === 0 && !overviewLoading && (
            <div className="opacity-60 text-sm italic">{t("temps.noRooms")}</div>
          )}

          {overview && overview.rooms.map((room) => (
            <RoomBlock
              key={room.name}
              roomName={room.name}
              racks={room.racks}
              activeRack={activeRack}
              rackDevices={rackDevices}
              rackLoading={rackLoading}
              rackErr={rackErr}
              onRackOpen={onRackOpen}
              onDeviceOpen={onDeviceOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

interface RoomBlockProps {
  roomName: string;
  racks: TempsRack[];
  activeRack: TempsRack | null;
  rackDevices: TempsRackResponse | null;
  rackLoading: boolean;
  rackErr: string | null;
  onRackOpen: (r: TempsRack | null) => void;
  onDeviceOpen: (d: TempsDevice) => void;
}

function RoomBlock(props: RoomBlockProps) {
  const { t } = useLanguage();
  const {
    roomName, racks, activeRack, rackDevices, rackLoading, rackErr,
    onRackOpen, onDeviceOpen,
  } = props;

  // Group racks by cage column letter (G / D / A …) so a long room
  // visually mirrors the mom.dmz floor plan.
  const cages = useMemo(() => {
    const out: Record<string, TempsRack[]> = {};
    for (const rack of racks) {
      const key = rack.cage || "?";
      (out[key] ||= []).push(rack);
    }
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b));
  }, [racks]);

  const isActiveRoom = activeRack?.room === roomName;

  return (
    <section className="solid-panel p-4">
      <header className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium tracking-wide">
          {t("temps.roomLabel")} {roomName}
        </h3>
        <span className="text-xs opacity-60">
          {racks.length} {t("temps.racksCount")}
        </span>
      </header>

      <div className="space-y-3">
        {cages.map(([cage, cageRacks]) => (
          <div key={cage}>
            <div className="text-xs uppercase tracking-wide opacity-50 mb-1">
              {cage}
            </div>
            <div className="flex flex-wrap gap-2">
              {cageRacks.map((rack) => {
                const selected = activeRack?.fullValue === rack.fullValue;
                return (
                  <button
                    key={rack.fullValue}
                    type="button"
                    onClick={() =>
                      onRackOpen(selected ? null : rack)
                    }
                    title={rack.fullValue}
                    className={`relative flex flex-col items-center justify-center w-20 h-16 rounded-md text-xs transition-transform hover:scale-105 active:scale-95 ${
                      selected ? "ring-2 ring-sky-500" : ""
                    }`}
                    style={{ background: rack.color || "rgba(120,120,120,0.3)" }}
                  >
                    <span className="text-[11px] font-mono opacity-90">
                      {rack.label}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-black/85">
                      {rack.tempC != null ? `${rack.tempC}°C` : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {isActiveRoom && activeRack && (
        <DeviceList
          rack={activeRack}
          devices={rackDevices?.devices ?? null}
          loading={rackLoading}
          err={rackErr}
          onDeviceOpen={onDeviceOpen}
          onClose={() => onRackOpen(null)}
        />
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------

interface DeviceListProps {
  rack: TempsRack;
  devices: TempsDevice[] | null;
  loading: boolean;
  err: string | null;
  onDeviceOpen: (d: TempsDevice) => void;
  onClose: () => void;
}

function DeviceList(props: DeviceListProps) {
  const { t } = useLanguage();
  const { rack, devices, loading, err, onDeviceOpen, onClose } = props;
  return (
    <div className="mt-4 p-3 surface-1 rounded-md">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium">
          {t("temps.devicesIn")} {rack.label}
        </h4>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="pill surface-1-hover text-xs"
        >✕</button>
      </div>

      {loading && <div className="opacity-70 text-xs">{t("common.loading")}</div>}
      {err === "mom_auth_expired" && (
        <div className="text-xs text-amber-700 dark:text-amber-200">
          {t("temps.authMissing")}
        </div>
      )}
      {err && err !== "mom_auth_expired" && (
        <div className="text-xs text-rose-700 dark:text-rose-200">
          {t("temps.fetchFailed")}
        </div>
      )}
      {devices && devices.length === 0 && !loading && (
        <div className="opacity-60 text-xs italic">{t("temps.noDevices")}</div>
      )}

      {devices && devices.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {devices.map((d) => (
            <li key={d.device}>
              <button
                type="button"
                onClick={() => onDeviceOpen(d)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md surface-2 hover:scale-[1.01] active:scale-95 transition-transform text-left"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <SourceBadge source={d.source} />
                    <span className="text-xs font-mono break-all">{d.label}</span>
                  </div>
                  <div className="text-[10px] opacity-60">
                    {t("temps.posLabel")} {d.pos || "—"}
                  </div>
                </div>
                <DeviceTemp device={d} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeviceTemp({ device }: { device: TempsDevice }) {
  // Coolan rows surface the three probes (Inlet / Exhaust / CPU max)
  // because Coolan has no machine-level aggregate. We still colour the
  // badge by tempC (the worst of the three) so the row matches the
  // green/yellow/red gradient the rack tiles use.
  if (device.source === "coolan") {
    const fmt = (v: number | null | undefined) =>
      v == null ? "—" : `${Math.round(v)}`;
    return (
      <span
        className={`pill text-xs tabular-nums shrink-0 ${tempBadgeClass(device.tempC)}`}
        title="Inlet / Exhaust / CPU max"
      >
        {fmt(device.tempInlet)}/{fmt(device.tempExhaust)}/{fmt(device.tempCpuMax)} °C
      </span>
    );
  }
  return (
    <span
      className={`pill text-xs tabular-nums shrink-0 ${tempBadgeClass(device.tempC)}`}
    >
      {device.tempC != null ? `${device.tempC}°C` : "—"}
    </span>
  );
}

// ----------------------------------------------------------------------------

interface DetailChartProps {
  site: string;
  device: TempsDevice;
  rackLabel: string;
  onClose: () => void;
}

function DetailChart({ site, device, rackLabel, onClose }: DetailChartProps) {
  const { t } = useLanguage();
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [agg, setAgg] = useState<Agg>("max");
  const [data, setData] = useState<TempsHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchTempsHistory({ site, device: device.device, timeframe, agg })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => {
        if (!cancelled) setErr(e?.error ?? "fetch_failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [site, device.device, timeframe, agg]);

  // Live-poll the chart while the modal is open. Cadence depends on
  // the timeframe — short windows (≤6h) refresh every 30s like mom.dmz,
  // longer windows refresh every 2 minutes since the underlying
  // downsampler doesn't produce new points faster than that anyway.
  useEffect(() => {
    const intervalMs = timeframe === "30m" || timeframe === "1h" || timeframe === "6h"
      ? 30_000
      : 120_000;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetchTempsHistory({
          site, device: device.device, timeframe, agg,
        });
        if (!stop) setData(res);
      } catch { /* keep previous data */ }
    };
    const id = window.setInterval(tick, intervalMs);
    return () => { stop = true; window.clearInterval(id); };
  }, [site, device.device, timeframe, agg]);

  return (
    <div
      role="dialog"
      aria-label={t("temps.detailTitle")}
      className="fixed inset-0 flex items-stretch justify-center px-4 pt-16 pb-10"
      style={{ zIndex: 2500, background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="solid-panel flex flex-col w-full max-w-4xl">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-black/10 dark:border-white/10">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide opacity-60 truncate">
              {rackLabel}
            </div>
            <div className="text-sm font-mono break-all">{device.label}</div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="pill surface-1-hover"
          >✕</button>
        </div>

        <div className="px-5 py-3 flex flex-wrap gap-2 items-center border-b border-black/10 dark:border-white/10">
          <span className="text-xs uppercase tracking-wide opacity-60">
            {t("temps.timeframe")}
          </span>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`pill text-xs ${
                timeframe === tf
                  ? "bg-sky-500/30 text-sky-800 dark:text-sky-100"
                  : "surface-1 surface-1-hover"
              }`}
            >{tf}</button>
          ))}
          <span className="text-xs uppercase tracking-wide opacity-60 ml-3">
            {t("temps.aggregation")}
          </span>
          {AGGS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAgg(a)}
              className={`pill text-xs ${
                agg === a
                  ? "bg-sky-500/30 text-sky-800 dark:text-sky-100"
                  : "surface-1 surface-1-hover"
              }`}
            >{a}</button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5">
          {loading && <div className="opacity-70 text-sm">{t("common.loading")}</div>}
          {err === "mom_auth_expired" && (
            <div className="text-sm text-amber-700 dark:text-amber-200">
              {t("temps.authMissing")}
            </div>
          )}
          {err && err !== "mom_auth_expired" && (
            <div className="text-sm text-rose-700 dark:text-rose-200">
              {t("temps.fetchFailed")}
            </div>
          )}
          {data && data.series.length === 0 && !loading && (
            <div className="opacity-60 text-sm italic">{t("temps.noSeries")}</div>
          )}
          {data && data.series.length > 0 && (
            <SeriesGrid series={data.series} />
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

interface SeriesGridProps {
  series: TempsSeries[];
}

function SeriesGrid({ series }: SeriesGridProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {series.map((s) => (
        <SeriesCard key={s.target} series={s} />
      ))}
    </div>
  );
}

interface SeriesCardProps {
  series: TempsSeries;
}

function SeriesCard({ series }: SeriesCardProps) {
  const { datapoints, sensor } = series;
  const stats = useMemo(() => {
    if (datapoints.length === 0) {
      return { min: null, max: null, last: null };
    }
    let min = datapoints[0][0];
    let max = datapoints[0][0];
    for (const [v] of datapoints) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const last = datapoints[datapoints.length - 1][0];
    return { min, max, last };
  }, [datapoints]);

  return (
    <div className="surface-1 p-3 rounded-md">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-medium">{sensor || "—"}</div>
        <div className="text-xs opacity-70 tabular-nums">
          {stats.last != null ? `${stats.last.toFixed(1)}°C` : "—"}
        </div>
      </div>
      <Chart datapoints={datapoints} />
      <div className="flex justify-between text-[11px] opacity-60 mt-1 tabular-nums">
        <span>min {stats.min != null ? stats.min.toFixed(1) : "—"}°C</span>
        <span>max {stats.max != null ? stats.max.toFixed(1) : "—"}°C</span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

interface ChartProps {
  datapoints: [number, number][];
}

/** Inline SVG line chart — no external library so we don't widen the
 *  frontend surface (CLAUDE.md rule: no new deps when primitives suffice).
 *  Hovering over the chart shows a vertical guideline plus a tooltip with
 *  the exact value/timestamp of the nearest datapoint. */
function Chart({ datapoints }: ChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const HEIGHT = 120;
  const PAD_X = 6;
  const PAD_Y = 8;

  const sorted = useMemo(
    () => [...datapoints].sort((a, b) => a[1] - b[1]),
    [datapoints],
  );

  if (sorted.length === 0) {
    return <div ref={ref} style={{ height: HEIGHT }} className="opacity-50 text-xs italic flex items-center justify-center">—</div>;
  }

  const xs = sorted.map(([, t]) => t);
  const ys = sorted.map(([v]) => v);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  // Pad the y-axis so a flat-line series doesn't render as a thin
  // horizontal stroke pinned to the top edge.
  if (yMax - yMin < 2) {
    yMin -= 1;
    yMax += 1;
  }
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(1, yMax - yMin);

  const xToPx = (x: number) =>
    PAD_X + ((x - xMin) / xRange) * (width - 2 * PAD_X);
  const yToPx = (y: number) =>
    PAD_Y + (1 - (y - yMin) / yRange) * (HEIGHT - 2 * PAD_Y);

  const path = sorted
    .map(([v, x], i) => `${i === 0 ? "M" : "L"} ${xToPx(x).toFixed(1)} ${yToPx(v).toFixed(1)}`)
    .join(" ");

  // Filled area under the line.
  const areaPath =
    `${path} L ${xToPx(xMax).toFixed(1)} ${HEIGHT - PAD_Y} ` +
    `L ${xToPx(xMin).toFixed(1)} ${HEIGHT - PAD_Y} Z`;

  function handleMove(e: ReactMouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Binary-search would be neater, but with timeframes capped at a
    // few hundred points a linear scan is fine and easier to read.
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const dx = Math.abs(xToPx(sorted[i][1]) - x);
      if (dx < bestDist) { bestDist = dx; bestIdx = i; }
    }
    setHoverIdx(bestIdx);
  }

  const hoverPoint = hoverIdx != null ? sorted[hoverIdx] : null;
  const hoverPx = hoverPoint
    ? { x: xToPx(hoverPoint[1]), y: yToPx(hoverPoint[0]) }
    : null;

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label="temperature series"
        style={{ display: "block" }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="tempArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(244, 114, 182)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="rgb(244, 114, 182)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#tempArea)" />
        <path
          d={path}
          fill="none"
          stroke="rgb(244, 114, 182)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverPx && (
          <>
            <line
              x1={hoverPx.x} x2={hoverPx.x}
              y1={PAD_Y} y2={HEIGHT - PAD_Y}
              stroke="currentColor" strokeOpacity="0.35"
              strokeWidth="1" strokeDasharray="3 3"
            />
            <circle
              cx={hoverPx.x} cy={hoverPx.y} r="3.5"
              fill="rgb(244, 114, 182)"
              stroke="white" strokeWidth="1.5"
            />
          </>
        )}
      </svg>
      {hoverPoint && hoverPx && (
        <div
          className="solid-panel pointer-events-none absolute px-2 py-1 text-[11px] tabular-nums leading-tight shadow-lg"
          style={{
            // Anchor the tooltip near the hovered point but flip it to
            // the left edge once it would clip the right side. 80px is
            // wider than any "23.4°C · 14:32:05" we'd produce.
            left: Math.min(hoverPx.x + 8, width - 80),
            top: Math.max(hoverPx.y - 36, 0),
            zIndex: 1,
          }}
        >
          <div className="font-medium">{hoverPoint[0].toFixed(1)}°C</div>
          <div className="opacity-70">{formatTimeFull(hoverPoint[1])}</div>
        </div>
      )}
      <div className="flex justify-between text-[10px] opacity-50 mt-0.5 tabular-nums">
        <span>{formatTime(xMin)}</span>
        <span>{formatTime(xMax)}</span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

interface SourceBadgeProps {
  source: TempsDevice["source"];
}

/** Tiny pill that tells the engineer which backend the row came from.
 *  mom.dmz = blue (network switches), Coolan = teal (servers). The
 *  per-row badge matters more than a global legend because the two
 *  sources update at very different cadences (mom: live, Coolan: 1h). */
function SourceBadge({ source }: SourceBadgeProps) {
  const { t } = useLanguage();
  const isMom = source === "mom";
  const cls = isMom
    ? "bg-sky-500/25 text-sky-800 dark:text-sky-100"
    : "bg-teal-500/25 text-teal-800 dark:text-teal-100";
  const label = isMom ? "MOM" : "Coolan";
  const title = isMom ? t("temps.sourceMomTitle") : t("temps.sourceCoolanTitle");
  return (
    <span
      className={`px-1.5 py-0 text-[9px] uppercase tracking-wider rounded-sm leading-tight shrink-0 ${cls}`}
      title={title}
    >
      {label}
    </span>
  );
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTimeFull(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString([], {
    month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ----------------------------------------------------------------------------

interface CoolanSnapshotPanelProps {
  device: TempsDevice;
  rackLabel: string;
  onClose: () => void;
}

/** Detail view for a Coolan-sourced server. Coolan has no historical
 *  time-series for sensor data, so instead of a chart we list every
 *  active TEMPERATURE_PROBE the machine reports plus a link to the
 *  full Coolan machine page. The hourly Coolan refresh cadence means
 *  this view doesn't need to live-poll. */
function CoolanSnapshotPanel({
  device, rackLabel, onClose,
}: CoolanSnapshotPanelProps) {
  const { t } = useLanguage();
  const [data, setData] = useState<CoolanSnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!device.coolanUuid) {
      setErr("missing_uuid");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchCoolanSnapshot(device.coolanUuid)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => {
        if (!cancelled) setErr(e?.error ?? "fetch_failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [device.coolanUuid]);

  return (
    <div
      role="dialog"
      aria-label={t("temps.detailTitle")}
      className="fixed inset-0 flex items-stretch justify-center px-4 pt-16 pb-10"
      style={{ zIndex: 2500, background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="solid-panel flex flex-col w-full max-w-2xl">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-black/10 dark:border-white/10">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide opacity-60 truncate">
              {rackLabel}
            </div>
            <div className="text-sm font-mono break-all flex items-center gap-2">
              <SourceBadge source="coolan" />
              {device.label}
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="pill surface-1-hover"
          >✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
          {loading && <div className="opacity-70 text-sm">{t("common.loading")}</div>}
          {err && (
            <div className="text-sm text-rose-700 dark:text-rose-200">
              {t("temps.fetchFailed")}
            </div>
          )}
          {data && (
            <>
              <div className="text-xs opacity-60">
                {t("temps.coolanNoHistory")}
              </div>

              {data.probes.length === 0 ? (
                <div className="opacity-60 text-sm italic">
                  {t("temps.noProbes")}
                </div>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {data.probes.map((p) => (
                    <li
                      key={p.name}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-md surface-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{p.name}</div>
                        {p.last_report_time && (
                          <div className="text-[10px] opacity-60">
                            {p.last_report_time}
                          </div>
                        )}
                      </div>
                      <span
                        className={`pill text-xs tabular-nums shrink-0 ${tempBadgeClass(p.tempC)}`}
                      >
                        {p.tempC != null ? `${Math.round(p.tempC)}°C` : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="pt-2 border-t border-black/10 dark:border-white/10">
                <a
                  href={data.machine_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-sky-700 dark:text-sky-300 hover:underline"
                >
                  {t("temps.openInCoolan")} ↗
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
