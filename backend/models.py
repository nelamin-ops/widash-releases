from datetime import datetime, timezone
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator, computed_field

Status = str
Priority = Literal["Sev0", "Sev1", "Sev2", "Sev3", "Sev4", "Sev5"]
Location = str
ActivityType = Literal["status_change", "comment"]

GUS_URL_TEMPLATE = (
    "https://gus.lightning.force.com/lightning/r/Case/{id}/view"
)
WORK_ITEM_URL_TEMPLATE = (
    "https://gus.lightning.force.com/lightning/r/ADM_Work__c/{id}/view"
)


class PrioBreakdown(BaseModel):
    Sev0: int = 0
    Sev1: int = 0
    Sev2: int = 0
    Sev3: int = 0
    Sev4: int = 0
    Sev5: int = 0

    def total(self) -> int:
        return (
            self.Sev0 + self.Sev1 + self.Sev2
            + self.Sev3 + self.Sev4 + self.Sev5
        )


class StatusBucket(BaseModel):
    status: str
    count: int
    color: str
    prioBreakdown: PrioBreakdown
    totalRuntimeSeconds: int


class CoolanLink(BaseModel):
    title: str   # "Components", "Machine", "Logs"
    url: str


class RmaTicket(BaseModel):
    id: str
    name: str
    location: str
    priority: Priority
    status: str
    componentType: str
    createdDate: datetime
    assignee: str
    # Asset / location detail (lifted from the report cells where available
    # and enriched from Tech_Asset__c when we look up the asset type).
    assetName: str = ""
    assetLocationPath: str = ""
    assetType: str = ""
    description: str = ""
    coolanLinks: list[CoolanLink] = Field(default_factory=list)
    # 'missing' / 'active' / 'unknown' — set only for Drained cases.
    # 'unknown' (= grey pill) is the safe default until we wire up the
    # Coolan API. The UI distinguishes:
    #   missing → the host is really off the floor   (green pill)
    #   active  → still serving load                  (red pill)
    #   unknown → no Coolan signal available          (grey pill)
    coolanReportingState: Optional[str] = None
    # ISO timestamp of the last Status field change from CaseHistory.
    # None when the history hasn't been loaded yet or no change exists.
    statusChangedAt: Optional[datetime] = None

    @computed_field
    @property
    def gusUrl(self) -> str:
        return GUS_URL_TEMPLATE.format(id=self.id)


class ActivityEvent(BaseModel):
    id: str
    ticketId: str
    ticketSfId: str
    type: ActivityType
    timestamp: datetime
    actor: str
    fromStatus: Optional[str] = None
    toStatus: Optional[str] = None
    commentText: Optional[str] = Field(default=None, max_length=200)
    location: str
    # Current Case.Status. Used by the UI to decide whether the seen-toggle
    # ("eye" icon) is meaningful — only cases still in actionable states
    # get the marker, everything else (closed, RTS, etc.) hides it.
    caseStatus: Optional[str] = None
    # True when the comment body mentions us (@nelamin) or our team
    # (@DCEng-FRA3). Used to highlight rows that demand a personal reply.
    mentionsMe: bool = False

    @field_validator("commentText", mode="before")
    @classmethod
    def truncate_comment(cls, v):
        if isinstance(v, str) and len(v) > 200:
            return v[:200]
        return v


class MyRtsTicket(BaseModel):
    id: str
    name: str
    location: str
    subject: str
    setAt: datetime

    @computed_field
    @property
    def gusUrl(self) -> str:
        return GUS_URL_TEMPLATE.format(id=self.id)


class RmaActiveResponse(BaseModel):
    total: int
    buckets: list[StatusBucket]
    returnToServiceToday: int = 0
    myRtsOpen: list[MyRtsTicket] = Field(default_factory=list)
    myRtsClosedTotal: int = 0
    # Counts of all active rows per location, ignoring the current filter so
    # the header pills can show totals for FRA1/FRA2/FRA3 even when the
    # selection is narrowed.
    locationCounts: dict[str, int] = Field(default_factory=dict)
    # Distinct site codes covered by the active report (FRA1/FRA2/FRA3
    # for the Frankfurt report, CDG1-3 for Paris, etc.). Frontend uses
    # this for the header location pills so the same UI works in any
    # region without a code change.
    sites: list[str] = Field(default_factory=list)
    fetchedAt: datetime


class RmaDetailResponse(BaseModel):
    status: str
    tickets: list[RmaTicket]


class WorkItem(BaseModel):
    """A GUS project-management work item (ADM_Work__c) — the SF
    engineers' own task tracking, separate from RMA cases. Surfaced
    read-only so the whole Frankfurt (or CDG, …) team can see who is
    blocked on what. ``name`` is the human work id ("W-23121591");
    ``id`` is the Salesforce 18-char record id used for the deep link."""
    id: str
    name: str
    subject: str
    status: str
    type: str = ""
    team: str = ""
    assignee: str = ""
    priority: str = ""
    # ISO timestamp of the last modification — drives the default sort.
    lastModified: Optional[datetime] = None
    # Bare case number this work item is linked to (via ADM_Work__c.Case__c),
    # empty when the work item carries no case link. FRA items almost never
    # set this today; kept so the UI can offer "open linked case" when it is.
    caseNumber: str = ""
    caseId: str = ""

    @computed_field
    @property
    def gusUrl(self) -> str:
        return WORK_ITEM_URL_TEMPLATE.format(id=self.id)


class DetailsSegment(BaseModel):
    """One inline run of work-item rich-text (Details field or a feed
    post/comment). ``href`` is set (and validated http/https server-side)
    when the run is a link; ``imageId`` carries a whitelisted Salesforce
    ContentDocument id (069…) for an embedded image, which the frontend
    loads through the backend image proxy. Either way the frontend builds
    real React nodes — it never trusts raw backend HTML."""
    text: str
    href: str = ""
    bold: bool = False
    imageId: str = ""


class DetailsBlock(BaseModel):
    """A block of a work item's Details rich-text, parsed server-side from
    HTML into a structured shape the frontend renders as real React nodes
    (never raw HTML). ``kind`` selects which payload is populated:

      - ``p`` / ``h``  → ``segments`` (a paragraph or heading)
      - ``ul`` / ``ol`` → ``items`` (each list item is a run of segments)
      - ``table``       → ``rows`` (rows → cells → segments)

    GUS work items routinely carry big asset tables here (40+ rows), so
    preserving table structure is the whole point — flattening them to
    text was the bug."""
    kind: str
    segments: list["DetailsSegment"] = Field(default_factory=list)
    items: list[list["DetailsSegment"]] = Field(default_factory=list)
    rows: list[list[list["DetailsSegment"]]] = Field(default_factory=list)


class WorkItemHistoryEvent(BaseModel):
    """One tracked field change on a work item (from ADM_Work__History).
    Drives the status-verlauf timeline in the sheet — we surface the
    Status__c changes (and a few other meaningful fields) so the team
    can see how a story moved through the board, by whom and when."""
    field: str          # human field label, e.g. "Status", "Assignee"
    oldValue: str = ""
    newValue: str = ""
    by: str = ""        # CreatedBy.Name of whoever made the change
    at: Optional[datetime] = None


class WorkItemDetail(BaseModel):
    """Full read-only view of one ADM_Work__c, shown in its own sheet
    tab (the work-item analogue of CaseDetailResponse). Distinct field
    set from a Case — agile/project shape (sprint, epic, due date),
    not asset/Coolan/patchplan."""
    id: str
    name: str
    subject: str = ""
    status: str = ""
    storyStatus: str = ""       # Story_Status__c — Open/Closed rollup
    type: str = ""
    priority: str = ""
    team: str = ""
    assignee: str = ""
    productOwner: str = ""      # Product_Owner__r.Name
    qaEngineer: str = ""        # QA_Engineer__r.Name
    storyPoints: Optional[float] = None  # Story_Points__c (agile estimate)
    ageDays: Optional[float] = None      # Age__c — days since created
    daysInProgress: Optional[float] = None  # Days_In_Progress__c
    sprint: str = ""
    epic: str = ""
    productTag: str = ""
    theme: str = ""             # ADM_Theme_Assignment__c → Theme.Name(s)
    dueDate: Optional[datetime] = None
    createdDate: Optional[datetime] = None
    lastModified: Optional[datetime] = None
    # Details__c is rich HTML. Parsed server-side into structured blocks
    # (paragraphs, headings, lists, tables) of inline segments so the FE
    # can render structure + clickable links without ever touching raw
    # backend HTML. ``details`` is the same content flattened to plain
    # text (kept for chat/search).
    details: str = ""
    detailsBlocks: list[DetailsBlock] = Field(default_factory=list)
    caseNumber: str = ""
    caseId: str = ""
    # Newest-first list of tracked field changes (status verlauf).
    history: list[WorkItemHistoryEvent] = Field(default_factory=list)

    @computed_field
    @property
    def gusUrl(self) -> str:
        return WORK_ITEM_URL_TEMPLATE.format(id=self.id)


class WorkItemsResponse(BaseModel):
    items: list[WorkItem] = Field(default_factory=list)
    # Site codes the active report covers — echoed back so the FE can
    # label the section ("Frankfurt work items") without a second call.
    sites: list[str] = Field(default_factory=list)
    fetchedAt: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class ActivityResponse(BaseModel):
    events: list[ActivityEvent]


class CaseDetailField(BaseModel):
    """One field's live value, with metadata so the UI can render it
    consistently and (later) edit it. Backend builds these from the
    Salesforce describe + record."""
    apiName: str
    label: str
    value: object | None = None  # str | int | float | bool | None
    type: str  # "text" | "textarea" | "picklist" | "multipicklist" | "bool" | "date" | "datetime" | "currency" | "number" | "lookup"
    editable: bool = False
    options: list[str] = Field(default_factory=list)
    # Lookup display: when ``type == "lookup"`` the ``value`` is a Salesforce
    # Id; ``displayValue`` is the related record's friendly name and
    # ``linkUrl`` is a deep link to it in GUS Lightning. Both are ``None``
    # for non-lookup fields.
    displayValue: Optional[str] = None
    linkUrl: Optional[str] = None
    # For lookups: the SObject types this field can reference (e.g.
    # ``["User"]`` or ``["ADM_Scrum_Team__c"]``). The frontend uses this
    # to decide which type-ahead endpoint to call.
    referenceTo: list[str] = Field(default_factory=list)
    # For lookups onto SM_General_Picklist__c: which slice of the table
    # this field draws from (Category / Subcategory / Resolution) and
    # the optional record-type filter. The frontend passes these to the
    # /api/lookup endpoint so the dropdown only shows valid values.
    lookupListType: Optional[str] = None
    lookupRecordTypeFilter: Optional[str] = None
    # For cascading lookups (Subcategory depends on Category): the api
    # name of the parent field whose current value scopes this one.
    lookupParentField: Optional[str] = None


class CaseDetailGroup(BaseModel):
    title: str
    fields: list[CaseDetailField] = Field(default_factory=list)


class CaseDetailSection(BaseModel):
    kind: str   # "case" | "asset"
    title: str
    subtitle: str = ""
    groups: list[CaseDetailGroup] = Field(default_factory=list)


class CaseDetailResponse(BaseModel):
    caseId: str
    caseNumber: str
    assetId: Optional[str] = None
    # When a Vendor is dispatched on the case, GUS surfaces a free-text
    # "Vendor Case Number" (e.g. ``SR# 123, WO# 456``). Surfacing it in
    # the sheet header tells the engineer at a glance that an external
    # tech needs escorting.
    vendorCaseNumber: Optional[str] = None
    sections: list[CaseDetailSection]
