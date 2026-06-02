/**
 * Chatter / CaseComment feed types and mock data for the case sheet.
 *
 * The sheet shows a single right-hand column with a source-switch:
 * 'Chatter' (FeedItem + FeedComment + TrackedChange) and
 * 'Case Comments' (the older textbox-style comment thread). Both
 * sources live in the same column so all conversation stays in one
 * place visually.
 */
export type ChatterSource = "chatter" | "caseComments" | "email";
export type FeedKind = "post" | "comment" | "trackedChange";

export interface FeedEntry {
  id: string;
  kind: FeedKind;
  source: ChatterSource;
  /** Author display name (e.g. "Bradley Walters"). */
  author: string;
  /** Sender username for the avatar fallback. */
  authorUsername?: string;
  /** Profile photo URL from Salesforce User.SmallPhotoUrl. */
  authorPhotoUrl?: string;
  /** True for entries authored by the current SF session user. */
  isMine?: boolean;
  /** ISO timestamp. */
  at: string;
  /** Plain-text body (HTML stripped). */
  body: string;
  /**
   * Optional parent for thread display. Top-level posts have no parentId;
   * FeedComments under a post or TrackedChange carry the post's id.
   */
  parentId?: string;
  /** TrackedChange-only fields. */
  fromValue?: string;
  toValue?: string;
  fieldLabel?: string;
}

export function buildMockChatter(_caseNumber: string): FeedEntry[] {
  return [
    {
      id: "p1", kind: "post", source: "chatter",
      author: "Bradley Walters", authorUsername: "bwalters@gus.com",
      at: "2026-05-19T18:12:13Z",
      body: "@Najih El Amin Thank you. Disk has been assigned to the cluster node successfully.",
    },
    {
      id: "tc1", kind: "trackedChange", source: "chatter",
      author: "Najih El Amin", authorUsername: "nelamin@gus.com",
      at: "2026-05-19T16:04:59Z",
      body: "",
      fieldLabel: "Status",
      fromValue: "Drained", toValue: "Return to Service",
    },
    {
      id: "p2", kind: "post", source: "chatter",
      author: "Najih El Amin", authorUsername: "nelamin@gus.com",
      at: "2026-05-15T13:35:42Z",
      body: "Hi @Bradley Walters — we have not yet received anything from our logistics department. It will arrive on Monday.",
    },
    {
      id: "p3", kind: "post", source: "chatter",
      author: "Bradley Walters", authorUsername: "bwalters@gus.com",
      at: "2026-05-15T12:55:56Z",
      body: "@DCEng-FRA3 Hi team, just checking up on this ticket. Looks like the part was delivered on May 12th. Thanks.",
    },
    {
      id: "c1", kind: "comment", source: "caseComments",
      author: "rackbot-api-bot", authorUsername: "rackbot-api-bot@gus.com",
      at: "2026-04-28T11:42:20Z",
      body: "RMA case status changed to Pending Drain via #ARE_slack_Drain Automation",
    },
    {
      id: "c2", kind: "comment", source: "caseComments",
      author: "SEQ Service", authorUsername: "seq_svc@gus.com",
      at: "2026-04-28T10:55:23Z",
      body: "Recently closed RMA case that was created by SEQ with the same case-subcategory exists for this host (87100123). Please verify before continuing.",
    },
  ];
}
