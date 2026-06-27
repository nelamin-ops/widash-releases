import { useMemo, useState } from "react";
import { useLanguage, localeFor } from "../hooks/useLanguage";
import type { ChatterSource, FeedEntry } from "./sheetChatter";
import { MentionInput, type MentionInputValue } from "./MentionInput";

interface ChatterPanelProps {
  entries: FeedEntry[];
  loading?: boolean;
  /** Called when the user submits a top-level post or a reply.
   *  No write goes out yet — the parent App pipes this into a confirm
   *  dialog and only sends with explicit user authorization. */
  onSubmit: (
    body: string,
    source: ChatterSource,
    parentId?: string,
    mentions?: string[],
  ) => void;
  /** Called when the user edits one of their own existing entries.
   *  Parent persists to SF + replaces the entry locally. */
  onEdit?: (entry: FeedEntry, newBody: string) => Promise<void> | void;
}

const SOURCES: { id: ChatterSource; labelKey: string }[] = [
  { id: "chatter", labelKey: "chatter.tabChatter" },
  { id: "caseComments", labelKey: "chatter.tabCaseComments" },
  { id: "email", labelKey: "chatter.tabEmail" },
];

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2)
    .join("").toUpperCase() || "?";
}

function formatTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function Avatar({ entry }: { entry: FeedEntry }) {
  // SF photo URLs are relative when proxied; absolute when served by the
  // org. Either way the browser will load them with the user's session.
  const src = entry.authorPhotoUrl;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className="w-7 h-7 rounded-full object-cover surface-2 shrink-0 mt-0.5"
        onError={(e) => {
          // Fall back to initials by hiding the broken image — sibling
          // span (rendered next) takes over via the `peer-error` group.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center w-7 h-7 rounded-full surface-2 text-[10px] font-medium shrink-0 mt-0.5"
    >
      {initials(entry.author)}
    </span>
  );
}

export function ChatterPanel({
  entries, loading, onSubmit, onEdit,
}: ChatterPanelProps) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [source, setSource] = useState<ChatterSource>("chatter");
  const [draft, setDraft] = useState<MentionInputValue>({ body: "", mentions: [] });
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<MentionInputValue>({ body: "", mentions: [] });
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<MentionInputValue>({ body: "", mentions: [] });
  const [editBusy, setEditBusy] = useState(false);

  // Filter entries by selected source, sort newest first.
  const filtered = useMemo(
    () => entries
      .filter((e) => e.source === source)
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at)),
    [entries, source],
  );

  // Build a parent → replies map so the panel can render replies
  // indented under their original post (mirrors how GUS Chatter shows
  // a thread). Replies whose parent isn't in the visible list (e.g.
  // older than our LIMIT 50 fetch) stay top-level so they still show
  // up. Reply chronology runs oldest-first inside the thread because
  // that's how a conversation reads.
  const { topLevel, repliesByParent } = useMemo(() => {
    const ids = new Set(filtered.map((e) => e.id));
    const replies: Record<string, FeedEntry[]> = {};
    const top: FeedEntry[] = [];
    for (const e of filtered) {
      const isReplyWithKnownParent =
        e.kind === "comment" && e.parentId && ids.has(e.parentId);
      if (isReplyWithKnownParent) {
        const list = replies[e.parentId!] || [];
        list.push(e);
        replies[e.parentId!] = list;
      } else {
        top.push(e);
      }
    }
    for (const k of Object.keys(replies)) {
      replies[k].sort((a, b) => a.at.localeCompare(b.at));
    }
    return { topLevel: top, repliesByParent: replies };
  }, [filtered]);

  function submitTopLevel() {
    const body = draft.body.trim();
    if (!body) return;
    const mentions = draft.mentions.map((m) => m.userId);
    onSubmit(body, source, undefined, mentions);
    setDraft({ body: "", mentions: [] });
  }

  function submitReply(entry: FeedEntry) {
    const body = replyDraft.body.trim();
    if (!body) return;
    // Mirror GUS: replying to an existing reply attaches the new
    // reply to the SAME parent post (Chatter threads are only one
    // level deep; you can't nest replies). For a top-level post the
    // entry's id IS the parent.
    const parentPostId = entry.kind === "comment" && entry.parentId
      ? entry.parentId
      : entry.id;
    const mentions = replyDraft.mentions.map((m) => m.userId);
    onSubmit(body, source, parentPostId, mentions);
    setReplyDraft({ body: "", mentions: [] });
    setReplyTo(null);
  }

  function renderEntryBody(e: FeedEntry) {
    const isTrackedChange = e.kind === "trackedChange";
    // Only own Chatter posts/comments are editable; CaseComment +
    // Email are not (Salesforce restrictions / read-only source).
    const canEdit = !!onEdit && e.isMine && e.source === "chatter"
      && (e.kind === "post" || e.kind === "comment");
    const isEditing = editing === e.id;
    return (
      <div className="flex items-start gap-2">
        <Avatar entry={e} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-sm">{e.author}</span>
            <span className="opacity-50 text-[10px]">
              {formatTime(e.at, locale)}
            </span>
          </div>
          {isTrackedChange ? (
            <div className="text-xs mt-1">
              <span className="opacity-60">{e.fieldLabel}:</span>{" "}
              <span className="pill surface-1 text-[10px]">{e.fromValue}</span>
              <span className="mx-1 opacity-50">→</span>
              <span className="pill surface-2 text-[10px]">{e.toValue}</span>
            </div>
          ) : isEditing ? (
            <div className="mt-1">
              <MentionInput
                value={editDraft}
                onChange={setEditDraft}
                rows={3}
                autoFocus
                disabled={editBusy}
                className="w-full text-sm p-2 rounded-md surface-1"
                compact
              />
              <div className="flex justify-end gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => { setEditing(null); setEditDraft({ body: "", mentions: [] }); }}
                  disabled={editBusy}
                  className="pill surface-1 surface-1-hover text-[11px] disabled:opacity-30"
                >
                  {t("chatter.cancelReply")}
                </button>
                <button
                  type="button"
                  onClick={() => submitEdit(e)}
                  disabled={editBusy || !editDraft.body.trim() || editDraft.body.trim() === e.body.trim()}
                  className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30 text-[11px]"
                >
                  {editBusy ? t("common.loading") : t("chatter.save")}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm whitespace-pre-wrap break-words leading-snug mt-0.5">
              {e.body}
            </p>
          )}
          {!isEditing && source !== "email" && !isTrackedChange && (
            <div className="flex items-center gap-3 mt-1">
              <button
                type="button"
                onClick={() => {
                  setReplyTo(replyTo === e.id ? null : e.id);
                  setReplyDraft({ body: "", mentions: [] });
                }}
                className="text-[11px] opacity-60 hover:opacity-100"
              >
                {replyTo === e.id ? t("chatter.cancelReply") : t("chatter.reply")}
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(e.id);
                    setEditDraft({ body: e.body, mentions: [] });
                    setReplyTo(null);
                  }}
                  className="text-[11px] opacity-60 hover:opacity-100"
                >
                  {t("chatter.edit")}
                </button>
              )}
            </div>
          )}

          {replyTo === e.id && (
            <div className="mt-2">
              <MentionInput
                value={replyDraft}
                onChange={setReplyDraft}
                rows={2}
                autoFocus
                placeholder={t("chatter.replyPlaceholder")}
                className="w-full text-xs p-2 rounded-md surface-1"
                compact
              />
              <div className="flex justify-end mt-1">
                <button
                  type="button"
                  onClick={() => submitReply(e)}
                  disabled={!replyDraft.body.trim()}
                  className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30 text-[11px]"
                >
                  {t("chatter.post")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  async function submitEdit(entry: FeedEntry) {
    const body = editDraft.body.trim();
    if (!body || !onEdit) return;
    setEditBusy(true);
    try {
      await onEdit(entry, body);
      setEditing(null);
      setEditDraft({ body: "", mentions: [] });
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <aside
      className="flex flex-col h-full w-full min-w-0 border-l border-soft"
      style={{ overscrollBehavior: "contain" }}
    >
      {/* Source switch */}
      <div className="flex border-b border-soft shrink-0">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSource(s.id)}
            className={`flex-1 px-3 py-2 text-xs uppercase tracking-wide transition-colors ${
              source === s.id
                ? "surface-2 font-medium"
                : "opacity-60 surface-1-hover"
            }`}
          >
            {t(s.labelKey as never)}
          </button>
        ))}
      </div>

      {/* Top-level compose — hidden for read-only sources (email). */}
      {source !== "email" && (
        <div className="px-3 py-3 border-b border-soft shrink-0">
          <MentionInput
            value={draft}
            onChange={setDraft}
            rows={2}
            placeholder={t("chatter.placeholder")}
            className="w-full text-sm p-2 rounded-md surface-1"
          />
          <div className="flex justify-end mt-1.5">
            <button
              type="button"
              onClick={submitTopLevel}
              disabled={!draft.body.trim()}
              className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30 text-xs"
            >
              {t("chatter.post")}
            </button>
          </div>
        </div>
      )}

      {/* Feed (newest first) */}
      <ul
        className="flex-1 overflow-y-auto px-3 py-2 space-y-3"
        style={{ overscrollBehavior: "contain" }}
      >
        {loading && (
          <li className="text-xs opacity-50 italic py-4 text-center">
            {t("common.loading")}
          </li>
        )}
        {!loading && filtered.length === 0 && (
          <li className="text-xs opacity-50 italic py-4 text-center">
            {t("chatter.empty")}
          </li>
        )}
        {topLevel.map((e) => {
          const replies = repliesByParent[e.id] || [];
          return (
            <li key={e.id} className="text-sm">
              {renderEntryBody(e)}
              {replies.length > 0 && (
                <ul
                  className="mt-2 ml-9 pl-3 border-l border-soft space-y-3"
                  aria-label={t("chatter.replies")}
                >
                  {replies.map((r) => (
                    <li key={r.id} className="text-sm">
                      {renderEntryBody(r)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
