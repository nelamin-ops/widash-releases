/**
 * Status → colour mapping mirrored from backend/gus_client.py STATUS_COLORS.
 *
 * The backend already attaches `color` to each StatusBucket in the active
 * RMA payload, so the donut + legend + details table all use that. This
 * helper exists for the case where a status is NOT in the active bucket
 * list — typically after a write moves a ticket to e.g. "Closed" or
 * "Return to Service" — so the case sheet + minimised tab can still
 * pick the right accent without round-tripping through the backend.
 */
export const STATUS_COLORS: Record<string, string> = {
  "New": "#94A3B8",
  "Pending Triage": "#A3E635",
  "Pending Drain": "#F59E0B",
  "Drain Scheduled": "#38BDF8",
  "Drained": "#22D3EE",
  "Remediating": "#818CF8",
  "Waiting for Internal Party": "#C084FC",
  "Waiting for External Party": "#F472B6",
  "Return to Service": "#34D399",
  "HW Repaired": "#2DD4BF",
  "Closed": "#6B7280",
  "Closed - Duplicate": "#4B5563",
  "Escalated": "#F87171",
};

const FALLBACK = "#9CA3AF";

export function colorForStatus(status: string | undefined | null): string {
  if (!status) return FALLBACK;
  return STATUS_COLORS[status] ?? FALLBACK;
}
