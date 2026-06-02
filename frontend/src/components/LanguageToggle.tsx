import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Language } from "../hooks/useLanguage";

interface LanguageToggleProps {
  lang: Language;
  setLang: (l: Language) => void;
  ariaLabel: string;
}

const OPTIONS: { code: Language; flag: string; label: string }[] = [
  { code: "en", flag: "🇬🇧", label: "English" },
  { code: "de", flag: "🇩🇪", label: "Deutsch" },
];

export function LanguageToggle({ lang, setLang, ariaLabel }: LanguageToggleProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 6,
      right: window.innerWidth - r.right,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (
        !triggerRef.current?.contains(tgt) &&
        !menuRef.current?.contains(tgt)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.code === lang) ?? OPTIONS[0];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-soft surface-1 surface-1-hover transition-colors text-base leading-none"
      >
        <span aria-hidden>{current.flag}</span>
      </button>

      {open && pos && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 1500 }}
          className="solid-panel py-1 min-w-[160px] text-sm overflow-hidden"
        >
          {OPTIONS.map((opt) => {
            const active = opt.code === lang;
            return (
              <li key={opt.code} className="px-1">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setLang(opt.code);
                    setOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-2xl surface-1-hover transition-colors ${
                    active ? "font-medium" : ""
                  }`}
                >
                  <span aria-hidden className="text-base leading-none">
                    {opt.flag}
                  </span>
                  <span className="flex-1">{opt.label}</span>
                  {active && <span aria-hidden className="opacity-60">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
