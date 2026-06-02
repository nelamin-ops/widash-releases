import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  spinning?: boolean;
}

/**
 * 36x36 round icon button. Content is centered with flex so SVGs
 * (or any glyph) sit perfectly on the optical center regardless of
 * font metrics.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { children, spinning, className = "", ...rest }, ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={
          "inline-flex items-center justify-center w-9 h-9 rounded-full " +
          "border border-soft surface-1 text-current " +
          "surface-1-hover transition-colors " +
          (spinning ? "animate-spin " : "") + className
        }
      >
        {children}
      </button>
    );
  },
);

/* --- Icons (24×24 viewBox, rendered at 18px) --------------------------- */

export const IconRefresh = ({ className = "" }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24" width="18" height="18"
    fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden focusable="false" className={className}
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 4v5h-5" />
  </svg>
);

export const IconSun = ({ className = "" }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24" width="18" height="18"
    fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden focusable="false" className={className}
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const IconMoon = ({ className = "" }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24" width="18" height="18"
    fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden focusable="false" className={className}
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
