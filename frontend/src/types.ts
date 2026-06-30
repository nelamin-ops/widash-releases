export type Status = string;
export type Priority = "Sev0" | "Sev1" | "Sev2" | "Sev3" | "Sev4" | "Sev5";
export type Location = string;
export type ActivityType = "status_change" | "comment";
export type ActivityFilter = "all" | "status_change" | "comment";

export interface PrioBreakdown {
  Sev0: number;
  Sev1: number;
  Sev2: number;
  Sev3: number;
  Sev4: number;
  Sev5: number;
}

export interface StatusBucket {
  status: Status;
  count: number;
  color: string;
  prioBreakdown: PrioBreakdown;
  totalRuntimeSeconds: number;
}

export interface CoolanLink {
  title: string;
  url: string;
}

export interface RmaTicket {
  id: string;
  name: string;
  location: Location;
  priority: Priority;
  status: string;
  componentType: string;
  createdDate: string;
  assignee: string;
  assetName: string;
  assetLocationPath: string;
  assetType: string;
  description: string;
  coolanLinks: CoolanLink[];
  coolanReportingState?: CoolanReportingState | null;
  statusChangedAt?: string | null;
  gusUrl: string;
}

export interface MyRtsTicket {
  id: string;
  name: string;
  location: string;
  subject: string;
  setAt: string;
  gusUrl: string;
}

export interface RmaActiveResponse {
  total: number;
  buckets: StatusBucket[];
  returnToServiceToday: number;
  myRtsOpen: MyRtsTicket[];
  myRtsClosedTotal: number;
  locationCounts: Record<string, number>;
  /** Site codes the active report covers (FRA1/2/3 by default,
   *  CDG1-3 once a Paris report is configured). */
  sites?: string[];
  fetchedAt: string;
}

export interface RmaDetailResponse {
  status: string;
  tickets: RmaTicket[];
}

export interface WorkItem {
  id: string;
  name: string;
  subject: string;
  status: string;
  type: string;
  team: string;
  assignee: string;
  priority: string;
  lastModified?: string | null;
  /** Bare case number linked via ADM_Work__c.Case__c — empty for most
   *  FRA items today (they reference the case in the subject text only). */
  caseNumber: string;
  caseId: string;
  gusUrl: string;
}

export interface WorkItemsResponse {
  items: WorkItem[];
  /** Site codes the active report covers — used to label the section. */
  sites: string[];
  fetchedAt: string;
}

export interface WorkItemHistoryEvent {
  field: string;
  oldValue: string;
  newValue: string;
  by: string;
  at?: string | null;
}

export interface DetailsSegment {
  text: string;
  href: string;
  bold: boolean;
  /** Whitelisted Salesforce ContentDocument id (069…) for an embedded
   *  image; loaded via the backend image proxy. Empty for non-images. */
  imageId: string;
}

export interface DetailsBlock {
  kind: "p" | "h" | "ul" | "ol" | "table";
  segments: DetailsSegment[];
  items: DetailsSegment[][];
  rows: DetailsSegment[][][];
}

export interface WorkItemFeedEntry {
  id: string;
  kind: "post" | "comment" | "trackedChange";
  parentId?: string;
  author: string;
  authorPhotoUrl?: string;
  isMine: boolean;
  at: string;
  /** Rich-text body parsed into structured blocks (empty for trackedChange). */
  blocks: DetailsBlock[];
  fieldLabel?: string;
  fromValue?: string;
  toValue?: string;
}

export interface WorkItemFeedResponse {
  workId: string;
  entries: WorkItemFeedEntry[];
}

export interface WorkItemDetail {
  id: string;
  name: string;
  subject: string;
  status: string;
  storyStatus: string;
  type: string;
  priority: string;
  team: string;
  assignee: string;
  productOwner: string;
  qaEngineer: string;
  storyPoints?: number | null;
  ageDays?: number | null;
  daysInProgress?: number | null;
  sprint: string;
  epic: string;
  productTag: string;
  theme: string;
  dueDate?: string | null;
  createdDate?: string | null;
  lastModified?: string | null;
  details: string;
  detailsBlocks: DetailsBlock[];
  caseNumber: string;
  caseId: string;
  history: WorkItemHistoryEvent[];
  gusUrl: string;
}

export interface ActivityEvent {
  id: string;
  ticketId: string;
  ticketSfId: string;
  type: ActivityType;
  timestamp: string;
  actor: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  commentText?: string | null;
  location: Location;
  caseStatus?: string | null;
  mentionsMe?: boolean;
}

export type CoolanReportingState =
  | "active"
  | "delayed"
  | "missing"
  | "unknown";

export type CaseFieldType =
  | "text" | "textarea" | "picklist" | "multipicklist"
  | "bool" | "date" | "datetime" | "currency" | "number" | "lookup";

export interface CaseDetailField {
  apiName: string;
  label: string;
  value: string | number | boolean | null;
  type: CaseFieldType;
  editable: boolean;
  options: string[];
  /** Lookup display name (e.g. "DCEng-FRA3"). Only set when ``type === "lookup"``. */
  displayValue?: string | null;
  /** Deep link to the related record in GUS Lightning. */
  linkUrl?: string | null;
  /** SObjects this lookup can reference (e.g. ``["User"]``). */
  referenceTo?: string[];
  /** For SM_General_Picklist__c lookups: which slice (Category /
   *  Subcategory / Resolution) the dropdown filters down to. */
  lookupListType?: string | null;
  lookupRecordTypeFilter?: string | null;
  /** For cascading lookups (Subcategory depends on Category): the api
   *  name of the parent field whose current value scopes this one. */
  lookupParentField?: string | null;
}

export interface CaseDetailGroup {
  title: string;
  fields: CaseDetailField[];
}

export interface CaseDetailSection {
  kind: "case" | "asset";
  title: string;
  subtitle: string;
  groups: CaseDetailGroup[];
}

export interface CaseDetailResponse {
  caseId: string;
  caseNumber: string;
  assetId?: string | null;
  /** Free-text vendor reference (e.g. "SR# 123, WO# 456"). Set only
   *  when an external vendor is dispatched on the case. */
  vendorCaseNumber?: string | null;
  sections: CaseDetailSection[];
}

export interface CoolanComponentAttribute {
  key: string;
  value: string;
}

export interface CoolanComponent {
  asset_type: string;
  display_name: string;
  reporting_state: string;
  last_report_time: string | null;
  /** Aggregated tool-determined condition (e.g. DEGRADED) — only set
   *  when the component is reporting (reporting_state = ACTIVE). */
  health_condition: string | null;
  /** UI-facing state used for colouring: reporting_state if not ACTIVE,
   *  otherwise health_condition (when bad), otherwise ACTIVE. */
  effective_state: string;
  /** Curated per-asset-type detail list (Vendor / Serial / Capacity /
   *  Slot etc.) for the click-through tooltip. */
  attributes?: CoolanComponentAttribute[];
}

export interface CoolanComponentsResponse {
  machineUuid: string;
  components: CoolanComponent[];
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export interface ApiError {
  error: string;
  message?: string;
}
