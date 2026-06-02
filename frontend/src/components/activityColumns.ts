import type { ActivityEvent } from "../types";

/**
 * Column definitions for the Activity Log.
 *
 * Time and Event are NOT user-toggleable — those are the row's actual
 * payload. Everything else can be hidden/reordered via the gear button.
 */
export type ActivityColumnId =
  | "timestamp"
  | "ticketId"
  | "location"
  | "event"
  | "actor"
  | "gus";

export interface ActivityColumnDef {
  id: ActivityColumnId;
  i18nKey:
    | "activity.colTime" | "activity.colTicket"
    | "activity.colLocation" | "activity.colEvent" | "activity.colActor"
    | "activity.colGus";
  width: number;
  sortable: boolean;
  alignRight?: boolean;
  /** Always-on columns that the user cannot hide. */
  pinned?: boolean;
  accessor?: (e: ActivityEvent) => unknown;
}

const eventText = (e: ActivityEvent) =>
  e.type === "status_change"
    ? `${e.fromStatus ?? ""} → ${e.toStatus ?? ""}`
    : (e.commentText ?? "");

export const ACTIVITY_COLUMNS: ActivityColumnDef[] = [
  {
    id: "timestamp", i18nKey: "activity.colTime", width: 160, sortable: true,
    pinned: true,
    accessor: (e) => new Date(e.timestamp).getTime(),
  },
  {
    id: "ticketId", i18nKey: "activity.colTicket", width: 110, sortable: true,
    accessor: (e) => e.ticketId,
  },
  {
    id: "location", i18nKey: "activity.colLocation", width: 70, sortable: true,
    accessor: (e) => e.location,
  },
  {
    id: "event", i18nKey: "activity.colEvent", width: 380, sortable: true,
    pinned: true,
    accessor: (e) => eventText(e),
  },
  {
    id: "actor", i18nKey: "activity.colActor", width: 200, sortable: true,
    accessor: (e) => e.actor,
  },
  {
    id: "gus", i18nKey: "activity.colGus", width: 56, sortable: false,
    alignRight: true,
  },
];

export const ACTIVITY_COLUMN_INDEX: Record<ActivityColumnId, ActivityColumnDef> =
  Object.fromEntries(ACTIVITY_COLUMNS.map((c) => [c.id, c])) as Record<
    ActivityColumnId, ActivityColumnDef
  >;

export const ACTIVITY_DEFAULT_ORDER: ActivityColumnId[] =
  ACTIVITY_COLUMNS.map((c) => c.id);
