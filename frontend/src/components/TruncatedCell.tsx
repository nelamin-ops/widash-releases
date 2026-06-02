import type { CSSProperties } from "react";

interface TruncatedCellProps {
  /** Stable id used as the tooltip key. Should be unique per cell. */
  id: string;
  /** Tooltip header line, e.g. "Asset · 90528893". */
  title: string;
  /** Cell content. Null/empty values render as `empty` and become non-clickable. */
  text: string | null | undefined;
  empty?: string;
  className?: string;
  style?: CSSProperties;
  onOpen: (
    id: string,
    title: string,
    text: string,
    anchor: { x: number; y: number },
  ) => void;
}

/**
 * Truncates with ellipsis. Clicking opens the standard text tooltip with
 * the full content — same behaviour as the comment / subject cells, so
 * truncation is never a dead-end for readers.
 */
export function TruncatedCell({
  id, title, text, empty = "—", className = "", style, onOpen,
}: TruncatedCellProps) {
  const value = (text ?? "").trim();
  if (!value) {
    return <span className={`opacity-50 ${className}`} style={style}>{empty}</span>;
  }
  return (
    <button
      type="button"
      onClick={(ev) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        onOpen(id, title, value, { x: r.left, y: r.bottom + 4 });
      }}
      title={value}
      className={`text-left w-full truncate hover:underline cursor-pointer ${className}`}
      style={style}
    >
      {value}
    </button>
  );
}
