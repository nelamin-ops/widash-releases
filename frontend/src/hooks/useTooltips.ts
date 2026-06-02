import { useCallback, useState } from "react";
import type {
  CoolanTooltipLink, OpenTooltip,
} from "../components/TextTooltip";

interface Anchor { x: number; y: number }

export function useTooltips() {
  const [tooltips, setTooltips] = useState<OpenTooltip[]>([]);

  const _push = useCallback((next: OpenTooltip) => {
    setTooltips((prev) => {
      // Toggle off if already open and clicked again on same anchor.
      if (prev.some((t) => t.id === next.id)) {
        return prev.filter((t) => t.id !== next.id);
      }
      const offset = prev.length * 24;
      const pad = 8;
      // Estimate tooltip height so we can flip above→below or clamp.
      // The real height isn't known yet, but 200px is a safe lower-bound
      // for the initial placement decision.
      const estimatedH = 200;
      const estimatedW = 420;
      let x = next.x + offset;
      let y = next.y + offset;
      // If spawning near the top edge, push down so the tooltip sits
      // below the anchor rather than above/clipped.
      if (y - estimatedH < pad) {
        y = Math.max(pad, next.y + offset);
      }
      // Clamp horizontally so the tooltip doesn't spawn off the right edge.
      x = Math.min(x, window.innerWidth - pad - estimatedW);
      x = Math.max(x, pad);
      // Clamp vertically — tooltip must not start above the viewport.
      y = Math.max(y, pad);
      // If the tooltip would overflow the bottom, push it up.
      if (y + estimatedH > window.innerHeight - pad) {
        y = Math.max(pad, window.innerHeight - pad - estimatedH);
      }
      return [
        ...prev,
        { ...next, x, y } as OpenTooltip,
      ];
    });
  }, []);

  const openText = useCallback(
    (id: string, title: string, text: string, anchor: Anchor) => {
      _push({ kind: "text", id, title, text, x: anchor.x, y: anchor.y });
    },
    [_push],
  );

  const openLinks = useCallback(
    (
      id: string,
      title: string,
      links: CoolanTooltipLink[],
      anchor: Anchor,
      emptyText?: string,
      headerLine?: string,
    ) => {
      _push({
        kind: "links", id, title, links, emptyText, headerLine,
        x: anchor.x, y: anchor.y,
      });
    },
    [_push],
  );

  const openKv = useCallback(
    (
      id: string,
      title: string,
      rows: { key: string; value: string }[],
      anchor: Anchor,
      options: {
        headerLine?: string;
        statusText?: string;
        statusTone?: "ok" | "warn" | "bad" | "muted";
        emptyText?: string;
      } = {},
    ) => {
      _push({
        kind: "kv", id, title, rows,
        headerLine: options.headerLine,
        statusText: options.statusText,
        statusTone: options.statusTone,
        emptyText: options.emptyText,
        x: anchor.x, y: anchor.y,
      });
    },
    [_push],
  );

  const close = useCallback((id: string) => {
    setTooltips((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const focus = useCallback((id: string) => {
    setTooltips((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1 || idx === prev.length - 1) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.push(item);
      return next;
    });
  }, []);

  return { tooltips, openText, openLinks, openKv, close, focus };
}
