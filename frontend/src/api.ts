import type {
  ActivityFilter,
  ActivityResponse,
  ApiError,
  CaseDetailResponse,
  CoolanComponentsResponse,
  RmaActiveResponse,
  RmaDetailResponse,
} from "./types";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err: ApiError = await res.json().catch(() => ({
      error: "unknown",
    }));
    throw err;
  }
  return res.json() as Promise<T>;
}

// Legacy single-id key — read once for migration so users who set
// up a single region keep working after upgrading to the multi-report
// settings.
const LEGACY_REPORT_ID_KEY = "widash.reportId";
const REPORT_IDS_KEY = "widash.reportIds";

export function getActiveReportIds(): string[] {
  try {
    const raw = localStorage.getItem(REPORT_IDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
      }
    }
    const legacy = localStorage.getItem(LEGACY_REPORT_ID_KEY);
    return legacy ? [legacy] : [];
  } catch { return []; }
}

export function setActiveReportIds(ids: string[]): void {
  try {
    const cleaned = ids.filter((x) => typeof x === "string" && x.length > 0);
    if (cleaned.length > 0) {
      localStorage.setItem(REPORT_IDS_KEY, JSON.stringify(cleaned));
    } else {
      localStorage.removeItem(REPORT_IDS_KEY);
    }
    // Also clear the legacy single-id key so the two never disagree.
    localStorage.removeItem(LEGACY_REPORT_ID_KEY);
  } catch { /* ignore */ }
}

// Backwards-compat shims for callers still on the single-id API.
export function getActiveReportId(): string {
  return getActiveReportIds()[0] || "";
}
export function setActiveReportId(id: string): void {
  setActiveReportIds(id ? [id] : []);
}

/** Fetch wrapper that auto-attaches X-Report-Id when one or more are
 *  set in localStorage. Backend parses the header as a comma-separated
 *  list and merges the responses across regions. */
function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const ids = getActiveReportIds();
  if (ids.length === 0) return fetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set("X-Report-Id", ids.join(","));
  return fetch(input, { ...init, headers });
}

function locationsParam(locations?: Set<string>): string {
  if (!locations || locations.size === 0) return "";
  return `&locations=${[...locations].join(",")}`;
}

function locationsQuery(locations?: Set<string>): string {
  if (!locations || locations.size === 0) return "";
  return `?locations=${[...locations].join(",")}`;
}

export function fetchActive(locations?: Set<string>): Promise<RmaActiveResponse> {
  return apiFetch(`/api/rma/active${locationsQuery(locations)}`)
    .then(handle<RmaActiveResponse>);
}

export function fetchDetails(
  status: string, locations?: Set<string>,
): Promise<RmaDetailResponse> {
  return apiFetch(
    `/api/rma/active/${encodeURIComponent(status)}${locationsQuery(locations)}`
  ).then(handle<RmaDetailResponse>);
}

export function fetchActivity(
  type: ActivityFilter,
  limit: number,
  locations?: Set<string>,
  includeBots: boolean = false,
): Promise<ActivityResponse> {
  const bots = includeBots ? "&includeBots=true" : "";
  return apiFetch(
    `/api/activity?type=${type}&limit=${limit}${locationsParam(locations)}${bots}`,
  ).then(handle<ActivityResponse>);
}

export function refresh(): Promise<{ status: string }> {
  return apiFetch("/api/refresh", { method: "POST" }).then(handle<{ status: string }>);
}

export function fetchCaseDetail(caseId: string): Promise<CaseDetailResponse> {
  return apiFetch(`/api/case/${encodeURIComponent(caseId)}`)
    .then(handle<CaseDetailResponse>);
}

export interface CaseLookupResult {
  caseSfId: string;
  caseNumber: string;
  status: string;
  reportId: string;
}

/** Resolve a hostname / serial number / case number to a Case in
 *  Salesforce. Used by the chat sidebar to make assistant-cited
 *  identifiers clickable. Returns null on 404 — caller decides what
 *  to do (typically a toast / open the asset's GUS page externally). */
export async function lookupCaseByIdentifier(
  kind: "hostname" | "serial" | "case_number", value: string,
): Promise<CaseLookupResult | null> {
  const r = await apiFetch(
    `/api/lookup/case_by_identifier?kind=${encodeURIComponent(kind)}`
    + `&value=${encodeURIComponent(value)}`,
  );
  if (r.status === 404) return null;
  return handle<CaseLookupResult>(r);
}

export interface WriteChange {
  apiName: string;
  value: string | number | boolean | null;
}

async function patch(url: string, changes: WriteChange[]) {
  const r = await apiFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
  return handle<{ status: string }>(r);
}

export function patchCase(caseId: string, changes: WriteChange[]) {
  return patch(`/api/case/${encodeURIComponent(caseId)}`, changes);
}

export function patchAsset(assetId: string, changes: WriteChange[]) {
  return patch(`/api/asset/${encodeURIComponent(assetId)}`, changes);
}

export interface CommentBody {
  source: "chatter" | "caseComments";
  body: string;
  parentFeedItemId?: string;
  /** SF user IDs to @-mention. Only honoured server-side for
   *  top-level chatter posts (replies and case-comments ignore it). */
  mentions?: string[];
}

export interface UserSearchHit {
  id: string;
  name: string;
  username: string;
  photoUrl: string;
}

export async function userSearch(q: string): Promise<UserSearchHit[]> {
  const r = await apiFetch(
    `/api/sf/user-search?q=${encodeURIComponent(q)}`,
  );
  const data = await handle<{ users: UserSearchHit[] }>(r);
  return data.users;
}

export async function postCaseComment(caseId: string, payload: CommentBody) {
  const r = await apiFetch(
    `/api/case/${encodeURIComponent(caseId)}/comment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return handle<{ status: string }>(r);
}

export async function patchChatterEntry(
  caseId: string,
  entryId: string,
  kind: "post" | "comment",
  body: string,
) {
  const r = await apiFetch(
    `/api/case/${encodeURIComponent(caseId)}/comment/${encodeURIComponent(entryId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, body }),
    },
  );
  return handle<{ status: string }>(r);
}

export interface MeResponse {
  id: string;
  username: string;
  name: string;
}

export function fetchMe(): Promise<MeResponse> {
  return apiFetch("/api/me").then(handle<MeResponse>);
}

export interface RegionDetectResponse {
  userId: string;
  sitePrefix: string | null;
  suggestedReportId: string | null;
  knownRegions: string[];
  siteCounts: Record<string, number>;
  sampleSize: number;
}

export function detectRegion(): Promise<RegionDetectResponse> {
  return apiFetch("/api/region/detect").then(handle<RegionDetectResponse>);
}

export interface RegionEntry {
  prefix: string;
  reportId: string;
}

export interface RegionsResponse {
  regions: RegionEntry[];
}

export function fetchRegions(): Promise<RegionsResponse> {
  return apiFetch("/api/regions").then(handle<RegionsResponse>);
}

export interface CaseFeedEntry {
  id: string;
  kind: "post" | "comment" | "trackedChange";
  source: "chatter" | "caseComments" | "email";
  parentId?: string;
  author: string;
  authorUsername?: string;
  authorPhotoUrl?: string;
  /** True when CreatedById matches the current SF session user. The
   *  backend resolves this once per request so the FE can gate the
   *  "edit own post" affordance without re-querying. */
  isMine?: boolean;
  at: string;
  body: string;
  incoming?: boolean;
  fromValue?: string;
  toValue?: string;
  fieldLabel?: string;
}

export interface CaseFeedResponse {
  caseId: string;
  entries: CaseFeedEntry[];
}

export interface LookupResult {
  id: string;
  name: string;
}

export interface LookupSearchOptions {
  /** SM_General_Picklist__c partition: Category / Subcategory / Resolution. */
  listType?: string | null;
  /** SM_General_Picklist__c parent-id filter (cascading subcategory). */
  parentId?: string | null;
  /** SM_General_Picklist__c Object_RecordType_Filter__c value (e.g. "RMA"). */
  recordTypeFilter?: string | null;
}

export function searchLookup(
  sobject: string, q: string, limit = 12,
  options: LookupSearchOptions = {},
): Promise<{ sobject: string; results: LookupResult[] }> {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(limit));
  if (options.listType) params.set("listType", options.listType);
  if (options.parentId) params.set("parentId", options.parentId);
  if (options.recordTypeFilter) {
    params.set("recordTypeFilter", options.recordTypeFilter);
  }
  return apiFetch(
    `/api/lookup/${encodeURIComponent(sobject)}?${params.toString()}`,
  ).then(handle<{ sobject: string; results: LookupResult[] }>);
}

export function fetchCaseFeed(
  caseId: string, limit = 50,
): Promise<CaseFeedResponse> {
  return apiFetch(
    `/api/case/${encodeURIComponent(caseId)}/feed?limit=${limit}`,
  ).then(handle<CaseFeedResponse>);
}

export interface PatchplanCableEnd {
  device: string;
  port: string;
  make: string;
  room: string;
  rack: string;
  uLoc: string;
  tile: string;
}

export interface PatchplanCableHop {
  label: string;
  panel: string;
  port: string;
}

export interface PatchplanCable {
  cableId: string;
  tab: string;
  cabled: string;
  cableType: string;
  length: string;
  comment: string;
  sideA: PatchplanCableEnd;
  sideB: PatchplanCableEnd;
  hops: PatchplanCableHop[];
}

export interface PatchplanCablesResponse {
  hostname: string;
  revision: string;
  fetchedAt: number;
  cables: PatchplanCable[];
  totalIndexed: number;
  knownHosts: number;
}

export function fetchPatchplanCables(
  args: { hostname?: string; room?: string; rack?: string; q?: string },
): Promise<PatchplanCablesResponse> {
  const params = new URLSearchParams();
  if (args.hostname) params.set("hostname", args.hostname);
  if (args.room) params.set("room", args.room);
  if (args.rack) params.set("rack", args.rack);
  if (args.q) params.set("q", args.q);
  return apiFetch(
    `/api/patchplan/cables?${params.toString()}`,
  ).then(handle<PatchplanCablesResponse>);
}

export interface PatchplanTreeDevice {
  name: string;
  cables: number;
}
export interface PatchplanTreeRack {
  name: string;
  cables: number;
  devices: PatchplanTreeDevice[];
}
export interface PatchplanTreeRoom {
  name: string;
  cables: number;
  racks: PatchplanTreeRack[];
}
export interface PatchplanTreeResponse {
  rooms: PatchplanTreeRoom[];
  hiddenRoomsCount: number;
  totalCables: number;
  totalHosts: number;
  revision: string;
  fetchedAt: number;
}

export function fetchPatchplanTree(
  showAll = false,
): Promise<PatchplanTreeResponse> {
  const qs = showAll ? "?showAll=true" : "";
  return apiFetch(`/api/patchplan/tree${qs}`).then(handle<PatchplanTreeResponse>);
}

export interface PatchplanRefreshResponse {
  totalIndexed: number;
  knownHosts: number;
  revision: string;
  fetchedAt: number;
}

export function refreshPatchplan(): Promise<PatchplanRefreshResponse> {
  return apiFetch("/api/patchplan/refresh", { method: "POST" })
    .then(handle<PatchplanRefreshResponse>);
}

export function fetchCoolanComponents(
  uuid: string,
): Promise<CoolanComponentsResponse> {
  return apiFetch(`/api/coolan/machine/${encodeURIComponent(uuid)}/components`)
    .then(handle<CoolanComponentsResponse>);
}

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  update_available: boolean;
}

export function fetchUpdateInfo(): Promise<UpdateInfo> {
  return fetch("/api/update-info").then(handle<UpdateInfo>);
}

// --- mom.dmz / Argus temperature monitoring -------------------------------

export interface TempsRack {
  fullValue: string;
  label: string;
  room: string;
  cage: string;
  tempC: number | null;
  color: string;
}

export interface TempsRoom {
  name: string;
  racks: TempsRack[];
}

export interface TempsOverviewResponse {
  site: string;
  rooms: TempsRoom[];
}

export interface TempsDevice {
  device: string;
  label: string;
  pos: string;
  tempC: number | null;
  color: string;
  /** "mom" = network switch via mom.dmz/Argus, "coolan" = server via Coolan. */
  source: "mom" | "coolan";
  /** Coolan-only: individual probe values (Inlet / Exhaust / max(CPU)).
   *  Coolan has no machine-level aggregate — the breakdown is what the
   *  engineer cares about, so we surface all three. */
  tempInlet?: number | null;
  tempExhaust?: number | null;
  tempCpuMax?: number | null;
  /** Coolan-only: machine UUID for the snapshot detail panel. */
  coolanUuid?: string;
}

export interface CoolanTempProbe {
  name: string;
  tempC: number | null;
  last_report_time: string | null;
}

export interface CoolanSnapshotResponse {
  uuid: string;
  hostname: string;
  probes: CoolanTempProbe[];
  last_report_time: string | null;
  machine_url: string;
}

export function fetchCoolanSnapshot(uuid: string): Promise<CoolanSnapshotResponse> {
  return apiFetch(`/api/temps/coolan/snapshot?uuid=${encodeURIComponent(uuid)}`)
    .then(handle<CoolanSnapshotResponse>);
}

export interface TempsRackResponse {
  site: string;
  rack: string;
  devices: TempsDevice[];
}

export interface TempsSeries {
  target: string;
  device: string;
  sensor: string;
  /** Argus returns each point as [value, unix_ts_seconds]. */
  datapoints: [number, number][];
}

export interface TempsHistoryResponse {
  site: string;
  device: string;
  timeframe: string;
  agg: string;
  series: TempsSeries[];
}

export function fetchTempsOverview(site: string): Promise<TempsOverviewResponse> {
  return apiFetch(`/api/temps/overview?site=${encodeURIComponent(site)}`)
    .then(handle<TempsOverviewResponse>);
}

export function fetchTempsRack(site: string, rack: string): Promise<TempsRackResponse> {
  const params = new URLSearchParams({ site, rack });
  return apiFetch(`/api/temps/rack?${params.toString()}`)
    .then(handle<TempsRackResponse>);
}

export function fetchTempsHistory(args: {
  site: string;
  device: string;
  timeframe: string;
  agg: string;
}): Promise<TempsHistoryResponse> {
  const params = new URLSearchParams(args);
  return apiFetch(`/api/temps/device/history?${params.toString()}`)
    .then(handle<TempsHistoryResponse>);
}

// ----- Chat sidebar (Claude over WiDash) ----------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProposalChange {
  sobject: "case" | "asset";
  apiName: string;
  label: string;
  type: string | null;
  oldValue: unknown;
  oldDisplay: string | null;
  newValue: unknown;
  newDisplay: string | null;
}

export interface CasePatchProposal {
  kind2: "case_patch_proposal";
  proposalId: string;
  caseId: string;
  caseNumber: string;
  assetId: string | null;
  changes: ProposalChange[];
}

export interface ProposalMention {
  userId: string;
  displayName: string;
}

export interface ChatterPostProposal {
  kind2: "chatter_post_proposal";
  proposalId: string;
  caseId: string;
  caseNumber: string;
  source: "chatter" | "caseComments";
  body: string;
  parentId: string | null;
  mentions?: ProposalMention[];
}

export interface ChatterEditProposal {
  kind2: "chatter_edit_proposal";
  proposalId: string;
  caseId: string;
  caseNumber: string | null;
  entryId: string;
  entryKind: "post" | "comment";
  oldBody: string;
  newBody: string;
}

export type ProposalPayload =
  | CasePatchProposal
  | ChatterPostProposal
  | ChatterEditProposal;

export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; status: "started" | "finished" }
  | { kind: "proposal"; proposal: ProposalPayload }
  | { kind: "usage"; input: number; output: number }
  | { kind: "done"; usage?: { input: number; output: number } }
  | { kind: "error"; message: string; code?: string };

/** Stream a chat completion from the backend SSE endpoint. Yields one
 *  event at a time. Caller is expected to render `delta.text` into the
 *  current assistant message and stop on `done`/`error`.
 *
 *  Uses fetch() + a manual SSE parser rather than EventSource because
 *  EventSource is GET-only and we need POST + JSON body. The X-Report-Id
 *  header is attached the same way as the rest of the dashboard. */
export async function* streamChat(
  body: { messages: ChatMessage[]; model: string },
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const ids = getActiveReportIds();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (ids.length > 0) headers["X-Report-Id"] = ids.join(",");
  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail: any = undefined;
    try { detail = await res.json(); } catch { /* ignore */ }
    // Pydantic 422 shape: {detail: [{loc:[...], msg, type}, …]}.
    // Our custom errors: {detail: {error, message}} or {message}.
    // Distinguish the two so the user sees something they can act on
    // rather than a generic "HTTP 422".
    let message: string | null = null;
    if (Array.isArray(detail?.detail)) {
      const first = detail.detail[0];
      const loc = Array.isArray(first?.loc) ? first.loc.join(".") : "";
      message = first?.msg
        ? `Bad request${loc ? ` (${loc})` : ""}: ${first.msg}`
        : `HTTP ${res.status}`;
    } else {
      message =
        (detail?.detail?.message as string) ||
        (detail?.message as string) ||
        `HTTP ${res.status}`;
    }
    yield {
      kind: "error",
      message,
      code: detail?.detail?.error ?? `http_${res.status}`,
    };
    return;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    yield { kind: "error", message: "no_response_body" };
    return;
  }
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length === 0) continue;
        let data: any;
        try { data = JSON.parse(dataLines.join("\n")); }
        catch { continue; }
        if (event === "delta") yield { kind: "delta", text: data.text ?? "" };
        else if (event === "tool")
          yield { kind: "tool", name: data.name, status: data.status };
        else if (event === "proposal") {
          const k2 = (data as { kind?: string })?.kind;
          if (
            k2 === "case_patch_proposal" ||
            k2 === "chatter_post_proposal" ||
            k2 === "chatter_edit_proposal"
          ) {
            // Map server "kind" to our "kind2" so the discriminator
            // doesn't collide with ChatStreamEvent.kind.
            const { kind, ...rest } = data as { kind: string };
            yield {
              kind: "proposal",
              proposal: { kind2: kind, ...rest } as ProposalPayload,
            };
          }
        }
        else if (event === "usage")
          yield { kind: "usage", input: data.input ?? 0, output: data.output ?? 0 };
        else if (event === "done")
          yield { kind: "done", usage: data.usage };
        else if (event === "error")
          yield { kind: "error", message: data.message, code: data.code };
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
