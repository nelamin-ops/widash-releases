import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";

export interface CoolanTooltipLink {
  title: string;
  url: string;
}

interface BaseTooltip {
  id: string;
  title: string;
  x: number;
  y: number;
}
export interface TextOpenTooltip extends BaseTooltip {
  kind: "text";
  text: string;
}
export interface LinksOpenTooltip extends BaseTooltip {
  kind: "links";
  links: CoolanTooltipLink[];
  emptyText?: string;
  headerLine?: string;
}
export interface KvOpenTooltip extends BaseTooltip {
  kind: "kv";
  /** Optional banner / context line above the key-value table. */
  headerLine?: string;
  /** Status pill text + colour shown next to the headerLine (e.g.
   *  "CRITICAL" in red). */
  statusText?: string;
  statusTone?: "ok" | "warn" | "bad" | "muted";
  rows: Array<{ key: string; value: string }>;
  emptyText?: string;
}
export type OpenTooltip =
  | TextOpenTooltip
  | LinksOpenTooltip
  | KvOpenTooltip;

interface TextTooltipProps {
  tooltip: OpenTooltip;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  zIndex: number;
}

interface PersistedGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_PREFIX = "widash.tooltipGeo:";
const MIN_W = 240;
const MIN_H = 140;
const DEFAULT_W = 420;

function loadGeometry(id: string): PersistedGeometry | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGeometry;
    if (
      typeof parsed.x !== "number" || typeof parsed.y !== "number" ||
      typeof parsed.w !== "number" || typeof parsed.h !== "number"
    ) return null;
    return parsed;
  } catch { return null; }
}

/** Force the tooltip back into the viewport — caps the size to the
 *  available space and clamps the corner so at least the header is
 *  reachable. Called whenever we hand a geometry to the component
 *  (load, mount, window resize) so the user can never lose a tooltip
 *  off-screen. */
function clampToViewport(g: PersistedGeometry): PersistedGeometry {
  const pad = 8;
  // Header height — must remain on screen so the user can grab + close.
  const HEADER_VISIBLE = 32;
  const w = Math.min(g.w, window.innerWidth - 2 * pad);
  const h = g.h > 0 ? Math.min(g.h, window.innerHeight - 2 * pad) : 0;
  const maxX = window.innerWidth - pad - Math.min(w, 80);
  const maxY = window.innerHeight - pad - HEADER_VISIBLE;
  const x = Math.max(pad, Math.min(g.x, maxX));
  const y = Math.max(pad, Math.min(g.y, maxY));
  return { x, y, w, h };
}

function saveGeometry(id: string, g: PersistedGeometry): void {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(g)); }
  catch { /* ignore */ }
}

export function TextTooltip({ tooltip, onClose, onFocus, zIndex }: TextTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { t } = useLanguage();

  // Position + size state. Saved geometry is clamped to the current
  // viewport on load — a tooltip persisted off-screen (different monitor
  // size, window resize) snaps back automatically.
  const [geom, setGeom] = useState<PersistedGeometry>(() => {
    const saved = loadGeometry(tooltip.id);
    if (saved) {
      const clamped = clampToViewport(saved);
      // If the clamp moved the tooltip, overwrite the stale stored value
      // immediately so it doesn't keep re-opening off-screen.
      if (clamped.x !== saved.x || clamped.y !== saved.y) {
        saveGeometry(tooltip.id, clamped);
      }
      return clamped;
    }
    const w = Math.min(DEFAULT_W, window.innerWidth - 24);
    return clampToViewport({ x: tooltip.x, y: tooltip.y, w, h: 0 });
  });

  // Re-clamp on browser-window resize so a previously valid position
  // can't drift off-screen when the user shrinks the window.
  useEffect(() => {
    const onResize = () => setGeom((g) => clampToViewport(g));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keep the persisted geometry in sync without spamming localStorage on
  // every drag pixel — a small debounce avoids the writes piling up.
  useEffect(() => {
    if (geom.h === 0) return; // auto-sized, nothing to remember yet
    const id = setTimeout(() => saveGeometry(tooltip.id, geom), 200);
    return () => clearTimeout(id);
  }, [geom, tooltip.id]);

  // After the first render we know the real size — clamp based on the
  // actual bounding rect. This runs for both fresh and saved geometries
  // so a tooltip saved at y=-50 (e.g. from a smaller monitor) snaps
  // back into the viewport immediately rather than being stuck off-screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let dx = 0, dy = 0;
    if (rect.right > window.innerWidth - pad) dx = window.innerWidth - pad - rect.right;
    if (rect.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - rect.bottom;
    if (rect.left + dx < pad) dx = pad - rect.left;
    if (rect.top + dy < pad) dy = pad - rect.top;
    if (dx || dy) {
      setGeom((g) => ({ ...g, x: g.x + dx, y: g.y + dy }));
    }
  }, [tooltip.id]);

  // Drag-to-move: pointer events on the header. We track from the
  // pointer-down position instead of tooltip top-left so the tooltip
  // doesn't jump to the cursor on first move.
  const dragStart = useRef<
    { startX: number; startY: number; geomX: number; geomY: number } | null
  >(null);
  function onHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    onFocus(tooltip.id);
    if ((e.target as HTMLElement).closest("button")) return;
    dragStart.current = {
      startX: e.clientX, startY: e.clientY,
      geomX: geom.x, geomY: geom.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onHeaderPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = dragStart.current;
    if (!s) return;
    setGeom((g) => ({
      ...g,
      x: s.geomX + (e.clientX - s.startX),
      y: s.geomY + (e.clientY - s.startY),
    }));
  }
  function onHeaderPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragStart.current = null;
    // Snap back into the viewport on release if the user dragged
    // off-screen — keeps the close button reachable.
    setGeom((g) => clampToViewport(g));
  }

  // Resize-from-bottom-right corner. We track height even when the
  // tooltip was previously auto-sized, so the first drag captures the
  // current natural height as the starting value.
  const resizeStart = useRef<
    { startX: number; startY: number; w: number; h: number } | null
  >(null);
  function onResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    onFocus(tooltip.id);
    const el = ref.current;
    const currentH = geom.h || (el ? el.getBoundingClientRect().height : MIN_H);
    resizeStart.current = {
      startX: e.clientX, startY: e.clientY,
      w: geom.w, h: currentH,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeStart.current;
    if (!s) return;
    setGeom((g) => ({
      ...g,
      w: Math.max(MIN_W, s.w + (e.clientX - s.startX)),
      h: Math.max(MIN_H, s.h + (e.clientY - s.startY)),
    }));
  }
  function onResizePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeStart.current = null;
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={tooltip.title}
      onMouseDown={() => onFocus(tooltip.id)}
      style={{
        position: "fixed",
        left: geom.x,
        top: geom.y,
        zIndex,
        width: geom.w,
        height: geom.h > 0 ? geom.h : undefined,
        display: "flex",
        flexDirection: "column",
      }}
      className="solid-panel"
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        style={{ touchAction: "none", cursor: "move" }}
        className="flex items-start justify-between gap-3 px-4 pt-3 pb-2 select-none"
      >
        <div className="text-xs uppercase tracking-wide opacity-60">
          {tooltip.title}
        </div>
        <button
          aria-label={t("common.tooltipClose")}
          onClick={() => onClose(tooltip.id)}
          className="pill surface-1-hover -mt-1 -mr-1"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {tooltip.kind === "links" ? (
          <>
            {tooltip.headerLine && (
              <div className="text-sm opacity-80 mb-2 leading-snug">
                {tooltip.headerLine}
              </div>
            )}
            {tooltip.links.length === 0 ? (
              <div className="text-sm opacity-60 italic">
                {tooltip.emptyText ?? "—"}
              </div>
            ) : (
              <ul className="text-sm space-y-1">
                {tooltip.links.map((l) => (
                  <li key={l.url}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline text-sky-700 dark:text-sky-300 break-all"
                    >
                      {l.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : tooltip.kind === "kv" ? (
          <>
            {(tooltip.headerLine || tooltip.statusText) && (
              <div className="flex items-baseline justify-between gap-3 mb-2">
                {tooltip.headerLine && (
                  <div className="text-sm opacity-80 leading-snug flex-1 min-w-0 whitespace-pre-line">
                    {tooltip.headerLine}
                  </div>
                )}
                {tooltip.statusText && (
                  <span
                    className={`pill text-[10px] uppercase tracking-wide ${
                      tooltip.statusTone === "ok"
                        ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200"
                        : tooltip.statusTone === "warn"
                          ? "bg-amber-500/25 text-amber-700 dark:text-amber-200"
                          : tooltip.statusTone === "bad"
                            ? "bg-rose-500/25 text-rose-700 dark:text-rose-200"
                            : "surface-2"
                    }`}
                  >
                    {tooltip.statusText}
                  </span>
                )}
              </div>
            )}
            {tooltip.rows.length === 0 ? (
              <div className="text-sm opacity-60 italic">
                {tooltip.emptyText ?? "—"}
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {tooltip.rows.map((r, i) => (
                    <tr key={`${r.key}-${i}`} className="align-top">
                      <th className="text-left font-medium opacity-70 pr-3 py-1 whitespace-nowrap">
                        {r.key}
                      </th>
                      <td className="py-1 break-words font-mono text-xs">
                        {r.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <div className="text-sm whitespace-pre-wrap break-words">
            {tooltip.text}
          </div>
        )}
      </div>

      {/* Resize grip — bottom-right corner. Pointer events here are
          captured on grab so the cursor doesn't escape the grip when
          the tooltip moves under it. */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        aria-hidden
        title={t("common.tooltipResize")}
        style={{
          position: "absolute",
          right: 0, bottom: 0,
          width: 16, height: 16,
          cursor: "nwse-resize",
          touchAction: "none",
          opacity: 0.5,
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <path
            d="M3 13 L13 3 M7 13 L13 7 M11 13 L13 11"
            stroke="currentColor" strokeWidth="1.5" fill="none"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
