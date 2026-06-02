/**
 * Format the asset location path the way it shows up on tab pills and
 * sheet headers: drop the leading "Frankfurt -" / "Paris -" etc.
 * (the site code that follows is unambiguous on its own), squash the
 * ``-``-spacers, and append ``-HU<n>`` from the asset hostname when
 * available — so an engineer sees the exact U position they need to
 * walk to without having to open the asset section.
 *
 * ``includeSitePrefix`` controls whether to keep the site code itself
 * (``FRA3-14.1-…``); the case sheet header uses this, the minimised
 * tab pill drops the site to save horizontal space.
 */
export function formatAssetPath(
  assetLocationPath: string | null | undefined,
  assetName?: string | null,
  options: { includeSitePrefix?: boolean } = { includeSitePrefix: true },
): string {
  if (!assetLocationPath) return "";
  // "Frankfurt - FRA3 - 14.1 - 124 - E35" -> ["Frankfurt", "FRA3", ...]
  let parts = assetLocationPath
    .split("-")
    .map((s) => s.trim())
    .filter(Boolean);
  // Drop the city/region prefix — it's always followed by the site
  // code (FRA3, CDG2, …) which carries the same information.
  if (parts.length > 1) parts = parts.slice(1);
  if (!options.includeSitePrefix && parts.length > 1) parts = parts.slice(1);

  let out = parts.join("-");
  const u = extractUPosition(assetName);
  if (u != null) out += `-HU${u}`;
  return out;
}

/**
 * Pull the U position out of the asset hostname when present. Asset
 * names look like ``611219 / CZ201109GD / b04u44-124-fra`` — the
 * ``u44`` after the rack code (b04) is the U slot.
 */
export function extractUPosition(assetName?: string | null): number | null {
  if (!assetName) return null;
  const parts = assetName.split("/").map((s) => s.trim());
  const host = parts[parts.length - 1] || "";
  const m = host.match(/^[a-z]+\d+u(\d+)/i);
  return m ? Number(m[1]) : null;
}
