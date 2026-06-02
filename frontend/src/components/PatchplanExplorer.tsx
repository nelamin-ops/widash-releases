import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchPatchplanCables, fetchPatchplanTree,
  type PatchplanCable, type PatchplanTreeResponse,
  type PatchplanTreeRoom, type PatchplanTreeRack,
} from "../api";

/**
 * Floating bubble + full-screen explorer for the master patchplan.
 *
 * Always-visible bubble bottom-right. Click → modal overlay with a
 * search box and a rooms → racks → devices → cables drill-down. State
 * (current path, search text) persists between opens so the engineer
 * can flip back and forth without losing place.
 */

type Path =
  | { level: "rooms" }
  | { level: "racks"; room: string }
  | { level: "devices"; room: string; rack: string }
  | { level: "device"; room: string; rack: string; device: string };

interface ExplorerState {
  open: boolean;
  /** Stack of paths — current is `stack[stack.length - 1]`. Push on
   *  drilldown, pop on Back. Lets us also map browser-history pops
   *  cleanly so swipe-back goes one level up instead of leaving the
   *  page. */
  stack: Path[];
  search: string;
  showAll: boolean;
}

const HISTORY_MARKER = "patchplan-explorer";


export function PatchplanExplorer() {
  const [state, setState] = useState<ExplorerState>({
    open: false,
    stack: [{ level: "rooms" }],
    search: "",
    showAll: false,
  });
  const [tree, setTree] = useState<PatchplanTreeResponse | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  async function loadTree(showAll: boolean) {
    setTreeLoading(true);
    try {
      const t = await fetchPatchplanTree(showAll);
      setTree(t);
    } catch {
      /* keep stale */
    } finally {
      setTreeLoading(false);
    }
  }
  useEffect(() => {
    if (state.open && tree === null) void loadTree(state.showAll);
  }, [state.open, tree, state.showAll]);

  // Swipe-back / browser-back integration: each drilldown pushes a
  // history entry tagged with HISTORY_MARKER. Popstate either pops the
  // stack (going one level up) or closes the modal when we're at the
  // root. This keeps trackpad-swipe-back from leaving the dashboard.
  useEffect(() => {
    function onPop(e: PopStateEvent) {
      const wasOurs =
        (e.state && (e.state as { _ph?: string })._ph === HISTORY_MARKER);
      // Whatever direction the user popped to, decide based on our
      // current stack: more than one entry → step up; otherwise close.
      setState((s) => {
        if (!s.open) return s;
        if (s.stack.length > 1) {
          return { ...s, stack: s.stack.slice(0, -1) };
        }
        return { ...s, open: false };
      });
      if (!wasOurs) {
        // The browser already popped past our entries — let it.
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ESC closes the modal but keeps state intact.
  useEffect(() => {
    if (!state.open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setState((s) => ({ ...s, open: false }));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.open]);

  function pushPath(p: Path) {
    setState((s) => ({ ...s, stack: [...s.stack, p] }));
    try { history.pushState({ _ph: HISTORY_MARKER }, ""); } catch {/* ignore */}
  }
  function popPath() {
    setState((s) => ({
      ...s,
      stack: s.stack.length > 1 ? s.stack.slice(0, -1) : s.stack,
    }));
    try { history.back(); } catch {/* ignore */}
  }
  function jumpTo(idx: number) {
    setState((s) => ({ ...s, stack: s.stack.slice(0, idx + 1) }));
    // Fire enough back() calls to land at that history depth.
    const popsNeeded = state.stack.length - idx - 1;
    for (let i = 0; i < popsNeeded; i++) {
      try { history.back(); } catch {/* ignore */}
    }
  }
  function toggleShowAll() {
    setState((s) => ({ ...s, showAll: !s.showAll }));
    setTree(null); // force reload with new flag
  }

  const open = state.open;
  const path = state.stack[state.stack.length - 1];

  return (
    <>
      <button
        type="button"
        onClick={() => setState((s) => ({ ...s, open: !s.open }))}
        title="Master patchplan"
        aria-label="Open master patchplan"
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-2xl transition-transform hover:scale-105 active:scale-95"
        style={{
          zIndex: 1900,
          background: "linear-gradient(135deg, #818CF8, #6366F1)",
          color: "white",
        }}
      >
        🔌
      </button>
      {open && (
        <ExplorerOverlay
          state={state}
          path={path}
          tree={tree}
          treeLoading={treeLoading}
          onReload={() => loadTree(state.showAll)}
          onPush={pushPath}
          onPop={popPath}
          onJumpTo={jumpTo}
          onToggleShowAll={toggleShowAll}
          onSearchChange={(v) => setState((s) => ({ ...s, search: v }))}
          onClose={() => setState((s) => ({ ...s, open: false }))}
        />
      )}
    </>
  );
}

function ExplorerOverlay({
  state, path, tree, treeLoading,
  onReload, onPush, onPop, onJumpTo, onToggleShowAll,
  onSearchChange, onClose,
}: {
  state: ExplorerState;
  path: Path;
  tree: PatchplanTreeResponse | null;
  treeLoading: boolean;
  onReload: () => Promise<void> | void;
  onPush: (p: Path) => void;
  onPop: () => void;
  onJumpTo: (idx: number) => void;
  onToggleShowAll: () => void;
  onSearchChange: (v: string) => void;
  onClose: () => void;
}) {
  const canBack = state.stack.length > 1;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Master patchplan"
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: 2500, background: "rgba(0,0,0,0.65)" }}
    >
      <div
        className="solid-panel m-6 flex-1 flex flex-col overflow-hidden"
        style={{ minHeight: 0 }}
      >
        <header className="flex items-center gap-3 flex-wrap px-5 py-3 border-b border-soft">
          <button
            type="button"
            onClick={onPop}
            disabled={!canBack}
            aria-label="Back"
            title="Back"
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ←
          </button>
          <h2 className="text-lg font-semibold">Master patchplan</h2>
          {tree && (
            <span className="text-sm opacity-70">
              <strong>{tree.totalCables}</strong> cables ·{" "}
              <strong>{tree.totalHosts}</strong> hosts ·{" "}
              <strong>{tree.rooms.length}</strong> rooms
              {tree.hiddenRoomsCount > 0 && (
                <span className="opacity-60">
                  {" "}({tree.hiddenRoomsCount} hidden)
                </span>
              )}
            </span>
          )}
          <input
            type="search"
            value={state.search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search rooms / racks / devices…"
            aria-label="Search"
            className="surface-1 surface-1-hover rounded-md px-3 py-1.5 text-sm w-72 ml-auto"
          />
          <button
            type="button"
            onClick={onToggleShowAll}
            aria-pressed={state.showAll}
            title="Show all rooms (including ones with very few cables — usually data quality leftovers)"
            className={`pill text-sm ${
              state.showAll
                ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
                : "surface-1 surface-1-hover"
            }`}
          >
            {state.showAll ? "All rooms" : "Show all"}
          </button>
          <button
            type="button"
            onClick={() => { void onReload(); }}
            disabled={treeLoading}
            className="pill text-sm surface-1 surface-1-hover disabled:opacity-50"
            title="Re-read patchplan CSVs"
          >
            {treeLoading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="pill surface-1-hover w-9 h-9 flex items-center justify-center"
          >✕</button>
        </header>

        <Breadcrumb path={path} onJumpTo={onJumpTo} />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!tree && treeLoading && (
            <p className="text-sm opacity-60 italic">Loading patchplan…</p>
          )}
          {tree && (
            <ExplorerBody
              tree={tree}
              path={path}
              search={state.search}
              onPush={onPush}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Breadcrumb({
  path, onJumpTo,
}: {
  path: Path;
  onJumpTo: (idx: number) => void;
}) {
  const labels: string[] = ["Rooms"];
  if (path.level === "racks" || path.level === "devices" || path.level === "device") {
    labels.push(`Room ${path.room}`);
  }
  if (path.level === "devices" || path.level === "device") {
    labels.push(`Rack ${path.rack}`);
  }
  if (path.level === "device") {
    labels.push(path.device);
  }
  return (
    <nav className="flex items-center gap-2 px-5 py-2 text-sm border-b border-soft flex-wrap">
      {labels.map((label, i) => {
        const last = i === labels.length - 1;
        return (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="opacity-40">›</span>}
            {last ? (
              <span className="font-mono"><strong>{label}</strong></span>
            ) : (
              <button
                type="button"
                onClick={() => onJumpTo(i)}
                className="font-mono opacity-70 hover:opacity-100 hover:underline"
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function ExplorerBody({
  tree, path, search, onPush,
}: {
  tree: PatchplanTreeResponse;
  path: Path;
  search: string;
  onPush: (p: Path) => void;
}) {
  const q = search.trim().toLowerCase();

  if (path.level === "rooms") {
    const rooms = q
      ? tree.rooms.filter((r) => roomMatches(r, q))
      : tree.rooms;
    return <RoomsGrid rooms={rooms} onPush={onPush} highlight={q} />;
  }
  if (path.level === "racks") {
    const room = tree.rooms.find((r) => r.name === path.room);
    if (!room) return <NotFound label={`Room ${path.room}`} />;
    const racks = q
      ? room.racks.filter((rk) => rackMatches(rk, q))
      : room.racks;
    return <RacksGrid room={room} racks={racks} onPush={onPush} highlight={q} />;
  }
  if (path.level === "devices") {
    const room = tree.rooms.find((r) => r.name === path.room);
    const rack = room?.racks.find((rk) => rk.name === path.rack);
    if (!rack) return <NotFound label={`Rack ${path.rack}`} />;
    const devices = q
      ? rack.devices.filter((d) => d.name.toLowerCase().includes(q))
      : rack.devices;
    return (
      <DevicesGrid
        room={path.room} rack={rack} devices={devices}
        onPush={onPush} highlight={q}
      />
    );
  }
  if (path.level === "device") {
    return <DeviceCables device={path.device} />;
  }
  return null;
}

function roomMatches(r: PatchplanTreeRoom, q: string): boolean {
  if (r.name.toLowerCase().includes(q)) return true;
  return r.racks.some((rk) => rackMatches(rk, q));
}
function rackMatches(rk: PatchplanTreeRack, q: string): boolean {
  if (rk.name.toLowerCase().includes(q)) return true;
  return rk.devices.some((d) => d.name.toLowerCase().includes(q));
}

function NotFound({ label }: { label: string }) {
  return (
    <p className="text-sm opacity-60 italic">{label} — not found.</p>
  );
}

function Card({
  title, subtitle, badge, onClick,
}: {
  title: string;
  subtitle: string;
  badge: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="surface-1 surface-1-hover rounded-lg p-4 text-left transition-all flex flex-col gap-1"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-base font-semibold truncate" title={title}>
          {title}
        </span>
        <span className="pill surface-2 text-xs whitespace-nowrap">{badge}</span>
      </div>
      <span className="text-sm opacity-60 truncate" title={subtitle}>
        {subtitle}
      </span>
    </button>
  );
}

function RoomsGrid({
  rooms, onPush, highlight,
}: {
  rooms: PatchplanTreeRoom[];
  onPush: (p: Path) => void;
  highlight: string;
}) {
  if (rooms.length === 0) {
    return <Empty highlight={highlight} />;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {rooms.map((r) => (
        <Card
          key={r.name}
          title={`Room ${r.name}`}
          subtitle={`${r.racks.length} racks`}
          badge={`${r.cables} cables`}
          onClick={() => onPush({ level: "racks", room: r.name })}
        />
      ))}
    </div>
  );
}

function RacksGrid({
  room, racks, onPush, highlight,
}: {
  room: PatchplanTreeRoom;
  racks: PatchplanTreeRack[];
  onPush: (p: Path) => void;
  highlight: string;
}) {
  if (racks.length === 0) {
    return <Empty highlight={highlight} />;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {racks.map((rk) => (
        <Card
          key={rk.name}
          title={rk.name}
          subtitle={`${rk.devices.length} devices`}
          badge={`${rk.cables} cables`}
          onClick={() =>
            onPush({ level: "devices", room: room.name, rack: rk.name })
          }
        />
      ))}
    </div>
  );
}

function DevicesGrid({
  room, rack, devices, onPush, highlight,
}: {
  room: string;
  rack: PatchplanTreeRack;
  devices: PatchplanTreeRack["devices"];
  onPush: (p: Path) => void;
  highlight: string;
}) {
  if (devices.length === 0) {
    return <Empty highlight={highlight} />;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {devices.map((d) => (
        <Card
          key={d.name}
          title={d.name}
          subtitle={`${rack.name} · room ${room}`}
          badge={`${d.cables} cables`}
          onClick={() =>
            onPush({ level: "device", room, rack: rack.name, device: d.name })
          }
        />
      ))}
    </div>
  );
}

function Empty({ highlight }: { highlight: string }) {
  return (
    <p className="text-sm opacity-60 italic">
      {highlight ? `Nothing matches “${highlight}”.` : "Nothing here."}
    </p>
  );
}

function DeviceCables({ device }: { device: string }) {
  const [cables, setCables] = useState<PatchplanCable[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPatchplanCables({ hostname: device })
      .then((res) => { if (!cancelled) setCables(res.cables); })
      .catch(() => { if (!cancelled) setCables([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [device]);

  const list = cables ?? [];

  return (
    <div>
      {loading && list.length === 0 && (
        <p className="text-sm opacity-60 italic">Loading cables…</p>
      )}
      {!loading && list.length === 0 && (
        <p className="text-sm opacity-60 italic">
          No cables in the patchplan for this device.
        </p>
      )}
      {list.length > 0 && (
        <div className="overflow-x-auto">
          <table
            className="w-full text-sm border-separate"
            style={{ borderSpacing: 0 }}
          >
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
              {list.map((c) => (
                <CableRow key={c.cableId + ":" + c.tab} cable={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CableRow({ cable: c }: { cable: PatchplanCable }) {
  const v = (c.cabled || "").toLowerCase();
  const tone = v === "x" ? "ok" : v === "p" ? "warn" : "muted";
  const text = v === "x" ? "active" : v === "n" ? "planned"
    : v === "p" ? "partial" : c.cabled || "—";
  function endNode(end: PatchplanCable["sideA"]) {
    return (
      <span className="font-mono">
        {end.device ? <strong>{end.device}</strong> : <span className="opacity-40">—</span>}
        {end.port && (
          <>
            <span className="opacity-50">:</span>
            <span>{end.port}</span>
          </>
        )}
      </span>
    );
  }
  function locNode(end: PatchplanCable["sideA"]) {
    const loc = [end.room, end.rack, end.uLoc].filter(Boolean).join("-");
    return loc ? (
      <span className="font-mono opacity-80" title={loc}>{loc}</span>
    ) : <span className="opacity-30">—</span>;
  }
  function hopsNode() {
    if (c.hops.length === 0) return <span className="opacity-50">→</span>;
    return (
      <span className="font-mono opacity-90">
        {c.hops.map((h, i) => (
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
    <tr className="divider-t align-top">
      <td className="py-2 pr-3 font-mono whitespace-nowrap">{c.cableId}</td>
      <td className="py-2 pr-3">
        <span
          className={`pill text-xs uppercase tracking-wide whitespace-nowrap ${
            tone === "ok"
              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
              : tone === "warn"
                ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
                : "surface-1 opacity-70"
          }`}
        >
          {text}
        </span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {c.cableType || <span className="opacity-30">—</span>}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {c.length || <span className="opacity-30">—</span>}
      </td>
      <td className="py-2 pr-3">{endNode(c.sideA)}</td>
      <td className="py-2 pr-3">{locNode(c.sideA)}</td>
      <td className="py-2 pr-3">{hopsNode()}</td>
      <td className="py-2 pr-3">{endNode(c.sideB)}</td>
      <td className="py-2 pr-3">{locNode(c.sideB)}</td>
      <td className="py-2 pr-3 opacity-60 whitespace-nowrap" title={c.tab}>
        {c.tab}
      </td>
    </tr>
  );
}

// Avoid noisy lint on unused export — useMemo isn't used yet but keeps
// future filter caching simple to add later.
void useMemo;
