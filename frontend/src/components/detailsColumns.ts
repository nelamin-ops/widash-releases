import type { RmaTicket } from "../types";

export type DetailsColumnId =
  | "priority" | "name" | "location" | "componentType"
  | "assetName" | "assetLocationPath" | "assetType" | "description"
  | "createdDate" | "statusChangedAt" | "assignee" | "coolan" | "gus";

export interface DetailsColumnDef {
  id: DetailsColumnId;
  i18nKey:
    | "details.colPriority" | "details.colTicketId" | "details.colLocation"
    | "details.colType" | "details.colAssetName" | "details.colAssetLocation"
    | "details.colAssetType" | "details.colDescription"
    | "details.colCreated" | "details.colStatusChanged" | "details.colAssignee"
    | "details.colCoolan" | "details.colGus";
  width: number;
  sortable: boolean;
  alignRight?: boolean;
  // Sort accessor — falsy if `sortable` is false.
  accessor?: (t: RmaTicket) => unknown;
}

const SEV_RANK: Record<string, number> = {
  Sev0: 0, Sev1: 1, Sev2: 2, Sev3: 3, Sev4: 4, Sev5: 5,
};

// Source of truth for the details table layout. Order here is the default;
// users can reorder + hide via the column manager and the result is stored
// in localStorage.
export const DETAILS_COLUMNS: DetailsColumnDef[] = [
  { id: "priority", i18nKey: "details.colPriority", width: 70, sortable: true,
    accessor: (t) => SEV_RANK[t.priority] ?? 99 },
  { id: "name", i18nKey: "details.colTicketId", width: 110, sortable: true,
    accessor: (t) => t.name },
  { id: "location", i18nKey: "details.colLocation", width: 70, sortable: true,
    accessor: (t) => t.location },
  { id: "componentType", i18nKey: "details.colType", width: 140, sortable: true,
    accessor: (t) => t.componentType },
  { id: "assetName", i18nKey: "details.colAssetName", width: 220, sortable: true,
    accessor: (t) => t.assetName },
  { id: "assetLocationPath", i18nKey: "details.colAssetLocation", width: 220, sortable: true,
    accessor: (t) => t.assetLocationPath },
  { id: "assetType", i18nKey: "details.colAssetType", width: 280, sortable: true,
    accessor: (t) => t.assetType },
  { id: "description", i18nKey: "details.colDescription", width: 200, sortable: false },
  { id: "createdDate", i18nKey: "details.colCreated", width: 90, sortable: true,
    accessor: (t) => new Date(t.createdDate).getTime() },
  { id: "statusChangedAt", i18nKey: "details.colStatusChanged", width: 110, sortable: true,
    accessor: (t) => new Date(t.statusChangedAt || t.createdDate).getTime() },
  { id: "assignee", i18nKey: "details.colAssignee", width: 160, sortable: true,
    accessor: (t) => t.assignee },
  { id: "coolan", i18nKey: "details.colCoolan", width: 60, sortable: false, alignRight: true },
  { id: "gus", i18nKey: "details.colGus", width: 60, sortable: false, alignRight: true },
];

export const DETAILS_COLUMN_INDEX: Record<DetailsColumnId, DetailsColumnDef> =
  Object.fromEntries(DETAILS_COLUMNS.map((c) => [c.id, c])) as Record<
    DetailsColumnId, DetailsColumnDef
  >;

export const DEFAULT_COLUMN_ORDER: DetailsColumnId[] = DETAILS_COLUMNS.map(
  (c) => c.id,
);
