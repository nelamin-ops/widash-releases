import type { CaseSheet } from "../hooks/useCaseSheets";
import { useLanguage } from "../hooks/useLanguage";
import { formatAssetPath } from "../assetPath";

interface CaseTabsBarProps {
  sheets: CaseSheet[];
  /** Global toggle — when true, the row of minimised tab pills is
   *  parked just above the open sheet instead of at the bottom of the
   *  screen. Lets the user click between cases without losing the one
   *  they're currently reading. */
  pinned: boolean;
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
}

interface TabPillProps {
  sheet: CaseSheet;
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
}

function TabPill({ sheet, onRestore, onClose }: TabPillProps) {
  const { t } = useLanguage();
  const accent = sheet.statusColor ?? "var(--text-muted)";
  const isWorkItem = sheet.kind === "workitem";
  // Drop the city prefix to save space on the minimised pill, append
  // the asset's U-position so the engineer sees the rack slot at a
  // glance (FRA3-14.1-124-E35-HU14). Work items have no asset path.
  const assetPath = isWorkItem
    ? ""
    : formatAssetPath(
        sheet.ticket.assetLocationPath,
        sheet.ticket.assetName,
        { includeSitePrefix: true },
      );

  return (
    <div
      className="solid-panel flex items-center gap-2 pl-3 pr-1 py-2 text-sm shadow-lg shrink-0"
      style={{ borderTop: `2px solid ${accent}` }}
    >
      <button
        type="button"
        onClick={() => onRestore(sheet.id)}
        title={t("sheet.restore")}
        className="flex items-start gap-2 hover:opacity-80 text-left"
      >
        <span
          aria-hidden
          className="inline-block w-2 h-2 rounded-full mt-2"
          style={{ background: accent }}
        />
        <span className="flex flex-col leading-tight gap-0.5">
          <span className="flex items-center gap-2">
            {isWorkItem && (
              <span
                className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded font-semibold"
                style={{ background: `${accent}22`, color: accent }}
              >
                WI
              </span>
            )}
            <span className="font-mono text-sm">{sheet.caseNumber}</span>
            {sheet.status && (
              <span className="opacity-60 text-sm hidden sm:inline">
                {sheet.status}
              </span>
            )}
          </span>
          {assetPath && (
            <span
              className="font-mono text-sm opacity-70 whitespace-nowrap"
              title={sheet.ticket.assetLocationPath}
            >
              {assetPath}
            </span>
          )}
          {sheet.ticket.assetName && (
            <span
              className="font-mono text-xs opacity-80 whitespace-nowrap"
              title={sheet.ticket.assetName}
            >
              {sheet.ticket.assetName
                .split(/\s*\/\s*/)
                .map((part, i, arr) => (
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 && (
                      <span
                        className="font-bold mx-0.5"
                        style={{ color: accent }}
                      >
                        /
                      </span>
                    )}
                  </span>
                ))}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onClose(sheet.id)}
        aria-label={t("sheet.close")}
        title={t("sheet.close")}
        className="pill surface-1-hover w-7 h-7 flex items-center justify-center text-xs self-start"
      >
        ✕
      </button>
    </div>
  );
}

export function CaseTabsBar({
  sheets, pinned, onRestore, onClose,
}: CaseTabsBarProps) {
  const openSheet = sheets.find((s) => !s.minimized);
  const minimised = sheets.filter((s) => s.minimized);
  if (minimised.length === 0) return null;

  // When pinned and a sheet is open, dock the row right above the
  // sheet's top edge. Otherwise sit at the bottom of the viewport.
  const dockedAboveSheet = pinned && !!openSheet;
  const positionStyle: React.CSSProperties = dockedAboveSheet
    ? { bottom: `calc(${openSheet!.heightVh}vh - 1px)`, zIndex: 1810 }
    : { bottom: 0, zIndex: 1700 };

  return (
    <div
      className="fixed left-0 right-0 px-3 pb-3"
      style={positionStyle}
    >
      <div className="flex gap-2 items-end overflow-x-auto">
        {minimised.map((s) => (
          <TabPill
            key={s.id}
            sheet={s}
            onRestore={onRestore}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  );
}
