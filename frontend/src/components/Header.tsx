import { useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { useLanguage } from "../hooks/useLanguage";
import { useFontSize } from "../hooks/useFontSize";
import { IconButton, IconMoon, IconRefresh, IconSun } from "./IconButton";
import { LanguageToggle } from "./LanguageToggle";
import { CoolanStatusPill } from "./CoolanStatusPill";
import { MomStatusPill } from "./MomStatusPill";
import { WriteModePill } from "./WriteModePill";

// Default site list — used until the backend tells us which sites the
// active report covers. Frontend overlays the live ``sites`` field
// from /api/rma/active so the same UI works for any region.
export const ALL_LOCATIONS = ["FRA1", "FRA2", "FRA3"] as const;
export type LocationFilter = string;

interface HeaderProps {
  onRefresh: () => void | Promise<void>;
  selectedLocations: Set<string>;
  onToggleLocation: (loc: LocationFilter) => void;
  locationCounts?: Record<string, number>;
  /** Site codes covered by the active report (FRA1/FRA2/FRA3 by default,
   *  CDG1-3 once a Paris report is configured, etc.). */
  sites?: readonly string[];
  /** Click on the gear icon — opens the settings modal. */
  onOpenSettings?: () => void;
}

export function Header({
  onRefresh, selectedLocations, onToggleLocation, locationCounts,
  sites, onOpenSettings,
}: HeaderProps) {
  const visibleSites: readonly string[] =
    sites && sites.length > 0 ? sites : ALL_LOCATIONS;
  const { theme, toggle } = useTheme();
  const { t, lang, setLang } = useLanguage();
  const { size: fontSize, cycle: cycleFont } = useFontSize();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  return (
    <header className="glass flex items-center justify-between px-6 py-4 mb-6">
      <div className="flex items-center">
        <img
          src="/logo.svg"
          alt="WiDash"
          style={{
            height: 48,
            width: "auto",
            filter: "drop-shadow(0 0 4px #7EC8E3) drop-shadow(0 0 2px #7EC8E3)",
          }}
        />
      </div>

      <div
        role="group"
        aria-label={t("header.locationFilter")}
        className="flex items-start gap-2"
      >
        {onOpenSettings && (
          <IconButton
            aria-label={t("header.settings")}
            title={t("header.settings")}
            onClick={onOpenSettings}
          >
            <svg
              viewBox="0 0 24 24" width="16" height="16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden focusable="false"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </IconButton>
        )}
        {visibleSites.map((loc) => {
          const active = selectedLocations.has(loc);
          const count = locationCounts?.[loc] ?? 0;
          return (
            <div key={loc} className="flex flex-col items-center gap-1">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onToggleLocation(loc)}
                title={t(active ? "header.locationHide" : "header.locationShow", { loc })}
                className={`pill transition-colors ${
                  active
                    ? "bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35"
                    : "surface-1 surface-1-hover opacity-60"
                }`}
              >
                {loc}
              </button>
              <span
                className="text-[11px] tabular-nums text-muted leading-none"
                aria-label={t("header.locationCount", { count, loc })}
              >
                {count}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <WriteModePill />
        <CoolanStatusPill />
        <MomStatusPill />
        <LanguageToggle
          lang={lang}
          setLang={setLang}
          ariaLabel={t("header.languageMenu")}
        />
        <IconButton
          aria-label={t(theme === "dark" ? "header.themeLight" : "header.themeDark")}
          title={t(theme === "dark" ? "header.themeLight" : "header.themeDark")}
          onClick={toggle}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </IconButton>
        <IconButton
          aria-label={t("header.fontSize", { size: fontSize })}
          title={t("header.fontSize", { size: fontSize })}
          onClick={cycleFont}
        >
          <span
            aria-hidden
            className="font-semibold leading-none"
            style={{
              fontSize: fontSize === "S" ? "0.85rem"
                : fontSize === "M" ? "0.95rem" : "1.05rem",
            }}
          >
            A{fontSize === "L" ? "+" : fontSize === "M" ? "·" : ""}
          </span>
        </IconButton>
        <IconButton
          aria-label={t("header.refresh")}
          title={t("header.refresh")}
          onClick={handleRefresh}
          spinning={refreshing}
        >
          <IconRefresh />
        </IconButton>
      </div>
    </header>
  );
}
