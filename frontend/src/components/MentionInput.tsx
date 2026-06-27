import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { userSearch, type UserSearchHit } from "../api";

export interface MentionRef {
  userId: string;
  displayName: string;
}

export interface MentionInputValue {
  body: string;                 // plain-text body, includes "@DisplayName "
  mentions: MentionRef[];       // SF user IDs, order matches occurrence
}

interface Props {
  value: MentionInputValue;
  onChange: (v: MentionInputValue) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** When true, the textarea takes a slightly more compact / inline
   *  style (used in reply/edit inline contexts). */
  compact?: boolean;
  /** className passthrough so callers can match existing layout. */
  className?: string;
}

/** Mention input — text + append-only mentions.
 *
 *  - Type `@` (after whitespace or at start of line) → search dropdown
 *    opens, your subsequent keystrokes become the query.
 *  - Spaces are part of the query (so `@Max Mustermann` disambiguates
 *    multiple Maxes). The dropdown stays open until Newline, Escape,
 *    a click outside, or an explicit pick.
 *  - Pick one → "@DisplayName " is inserted at the cursor, the user
 *    is recorded in `mentions`.
 *  - Editing the body keeps existing mentions intact AS LONG AS
 *    the "@DisplayName" substring is still present. If you delete it
 *    from the body, the mention is dropped from `mentions` on the
 *    next change.
 */
export function MentionInput({
  value, onChange,
  placeholder, rows = 3, disabled, autoFocus, compact, className,
}: Props) {
  const { t } = useLanguage();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  // Dropdown state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchAnchorPos, setSearchAnchorPos] = useState<number | null>(null);  // cursor pos where @ was typed
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Debounced search
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQuery;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const hits = await userSearch(q);
        if (!cancelled) {
          setSearchResults(hits);
          setHighlight(0);
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchOpen, searchQuery]);

  // Render the body for the backdrop layer: each set "@DisplayName" token
  // is wrapped in a blue span, the rest stays plain. Scans left-to-right
  // and always takes the earliest match so multiple mentions don't overlap.
  function renderHighlighted(body: string, mentions: MentionRef[]): React.ReactNode {
    if (!body) return null;
    const tokens = mentions.map((m) => `@${m.displayName}`).filter((tok) => tok.length > 1);
    if (tokens.length === 0) return body;
    const out: React.ReactNode[] = [];
    let i = 0;
    let key = 0;
    while (i < body.length) {
      let bestPos = -1;
      let bestTok = "";
      for (const tok of tokens) {
        const p = body.indexOf(tok, i);
        if (p !== -1 && (bestPos === -1 || p < bestPos)) { bestPos = p; bestTok = tok; }
      }
      if (bestPos === -1) { out.push(body.slice(i)); break; }
      if (bestPos > i) out.push(body.slice(i, bestPos));
      out.push(
        <span key={key++} className="text-sky-600 dark:text-sky-400 font-medium">{bestTok}</span>,
      );
      i = bestPos + bestTok.length;
    }
    return out;
  }

  function reconcileMentions(newBody: string, existing: MentionRef[]): MentionRef[] {
    // Keep only mentions whose @DisplayName substring still appears in the body.
    return existing.filter((m) => newBody.includes(`@${m.displayName}`));
  }

  function onBodyChange(newBody: string) {
    // Detect a fresh `@` at the cursor preceded by whitespace / line start.
    const ta = taRef.current;
    const cursor = ta ? ta.selectionStart : newBody.length;
    const before = newBody.slice(0, cursor);
    const beforeChar = newBody.charAt(cursor - 1);
    const charBeforeAt = before.length >= 2 ? before.charAt(before.length - 2) : "";
    const atIsValidTrigger =
      beforeChar === "@" &&
      (before.length === 1 || /\s/.test(charBeforeAt));
    if (atIsValidTrigger) {
      setSearchOpen(true);
      setSearchAnchorPos(cursor);   // position right AFTER the @
      setSearchQuery("");
    } else if (searchOpen && searchAnchorPos !== null) {
      // We're typing into an open search — update the query from the
      // text between anchor and cursor. Newline closes the search;
      // spaces stay part of the query so "@Max Mustermann" works.
      // Cursor going back BEFORE the anchor also closes.
      if (cursor < searchAnchorPos) {
        setSearchOpen(false);
      } else {
        const queryPart = newBody.slice(searchAnchorPos, cursor);
        if (/\n/.test(queryPart)) {
          setSearchOpen(false);
        } else {
          setSearchQuery(queryPart);
        }
      }
    }
    onChange({
      body: newBody,
      mentions: reconcileMentions(newBody, value.mentions),
    });
  }

  function insertMention(hit: UserSearchHit) {
    const ta = taRef.current;
    if (!ta || searchAnchorPos === null) return;
    // Remove the "@<partial query>" we already typed, replace with "@<DisplayName> ".
    const before = value.body.slice(0, searchAnchorPos - 1);  // strip the @ itself
    const after = value.body.slice(ta.selectionStart);
    const insertion = `@${hit.name} `;
    const newBody = before + insertion + after;
    const newMentions: MentionRef[] = [
      ...value.mentions.filter((m) => m.userId !== hit.id),
      { userId: hit.id, displayName: hit.name },
    ];
    onChange({ body: newBody, mentions: newMentions });
    setSearchOpen(false);
    setSearchQuery("");
    // Restore focus + cursor after insertion (deferred to next tick to
    // let React render the new value first).
    setTimeout(() => {
      if (taRef.current) {
        const pos = before.length + insertion.length;
        taRef.current.focus();
        taRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!searchOpen) return;
    if (e.key === "Escape") {
      setSearchOpen(false);
      e.preventDefault();
      return;
    }
    if (searchResults.length === 0) return;
    if (e.key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, searchResults.length - 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      e.preventDefault();
    } else if (e.key === "Enter") {
      insertMention(searchResults[highlight]);
      e.preventDefault();
    }
  }

  const fieldClass =
    className ??
    (compact
      ? "w-full text-xs p-2 rounded-md surface-1"
      : "w-full text-sm p-2 rounded-md surface-1");

  return (
    <div className="relative">
      {/* Backdrop: mirrors the body text, highlighting set mentions in
          blue. Sits behind the transparent textarea; box model is kept
          identical via the shared fieldClass + pre-wrap/break-words. */}
      <div
        ref={backdropRef}
        aria-hidden
        className={`${fieldClass} absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words`}
      >
        {value.body
          ? renderHighlighted(value.body, value.mentions)
          : <span className="text-faint">{placeholder ?? t("mention.placeholder")}</span>}
      </div>
      <textarea
        ref={taRef}
        value={value.body}
        onChange={(e) => onBodyChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (backdropRef.current) {
            backdropRef.current.scrollTop = e.currentTarget.scrollTop;
            backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        /* placeholder rendered in the backdrop — the textarea text is
           transparent, which would hide a native placeholder too. */
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        className={`${fieldClass} relative`}
        style={{ resize: "vertical", background: "transparent", color: "transparent", caretColor: "var(--text-primary)" }}
      />
      {searchOpen && (
        <div
          className="absolute left-0 right-0 mt-1 rounded-md border border-sky-500/30 shadow-lg z-50 max-h-64 overflow-y-auto backdrop-blur-md bg-slate-100/85 dark:bg-slate-900/85"
          style={{ top: "100%" }}
        >
          {searchLoading && (
            <div className="px-3 py-2 text-xs opacity-60">{t("mention.searching")}</div>
          )}
          {!searchLoading && searchResults.length === 0 && (
            <div className="px-3 py-2 text-xs opacity-60">{t("mention.noResults")}</div>
          )}
          {searchResults.map((hit, i) => (
            <button
              type="button"
              key={hit.id}
              onMouseDown={(e) => { e.preventDefault(); insertMention(hit); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:surface-1 ${i === highlight ? "bg-sky-500/15" : ""}`}
            >
              <img
                src={hit.photoUrl}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-gray-300/50 shrink-0"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
              />
              <span className="min-w-0" style={{ textShadow: "0 0 8px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,1), 0 0 24px rgba(0,0,0,1), 0 0 36px rgba(0,0,0,1), 0 2px 12px rgba(0,0,0,1)" }}>
                <span className="block text-sm truncate">{hit.name}</span>
                <span className="block text-xs opacity-60 truncate">{hit.username}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
