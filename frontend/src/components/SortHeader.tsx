import type { SortDir } from "../hooks/useSort";

interface SortHeaderProps {
  label: string;
  active: boolean;
  dir: SortDir;
  onToggle: () => void;
  align?: "left" | "right";
}

export function SortHeader({ label, active, dir, onToggle, align = "left" }: SortHeaderProps) {
  const arrow = !active ? "↕" : dir === "asc" ? "↑" : "↓";
  return (
    <button
      type="button"
      onClick={onToggle}
      style={active ? { color: "var(--text-primary)" } : undefined}
      className={`flex items-center gap-1 w-full transition-colors hover:opacity-100 ${
        align === "right" ? "justify-end" : "justify-start"
      } ${active ? "opacity-100" : ""}`}
    >
      <span>{label}</span>
      <span className={`text-[10px] ${active ? "opacity-90" : "opacity-40"}`}>
        {arrow}
      </span>
    </button>
  );
}
