import {
  createContext, createElement, useCallback, useContext, useEffect,
  useMemo, useState, type ReactNode,
} from "react";

export type FontSize = "S" | "M" | "L";

const STORAGE_KEY = "widash.fontSize";
// Tailwind reads rem-based scales off the document root, so changing
// the html font-size globally rescales every text size in lockstep.
const SIZE_PX: Record<FontSize, number> = { S: 18, M: 20, L: 22 };
const ORDER: FontSize[] = ["S", "M", "L"];

interface FontSizeContextValue {
  size: FontSize;
  cycle: () => void;
  set: (s: FontSize) => void;
}

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

function loadInitial(): FontSize {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "S" || v === "M" || v === "L") return v;
  } catch { /* ignore */ }
  return "S";
}

export function FontSizeProvider({ children }: { children: ReactNode }) {
  const [size, setSize] = useState<FontSize>(() => loadInitial());

  useEffect(() => {
    document.documentElement.style.fontSize = `${SIZE_PX[size]}px`;
    try { localStorage.setItem(STORAGE_KEY, size); } catch { /* ignore */ }
  }, [size]);

  const cycle = useCallback(() => {
    setSize((prev) => ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length]);
  }, []);

  const value = useMemo(() => ({ size, cycle, set: setSize }), [size, cycle]);
  return createElement(FontSizeContext.Provider, { value }, children);
}

export function useFontSize(): FontSizeContextValue {
  const ctx = useContext(FontSizeContext);
  if (ctx) return ctx;
  // Fallback for components rendered outside the provider (tests).
  return { size: "S", cycle: () => {}, set: () => {} };
}
