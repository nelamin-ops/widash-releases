import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconButton } from "./IconButton";
import { useLanguage } from "../hooks/useLanguage";
import { streamChat, type ChatMessage } from "../api";

// Allow-list for in-app links the assistant can emit. Each regex is
// the injection defence: when the regex matches, we let the click
// reach the dispatch helper. Anything else falls through to an
// external link with rel="noopener noreferrer" (and only if it's
// http/https — javascript:, data:, file: are stripped).
const CASE_HREF_RE = /^widash:\/\/case\/([0-9]{6,12})$/;
// Rack/room: site is 2-4 letters + 1-3 digits (FRA3, IAD12); rack
// label is a short alphanumeric/dot/dash token; room is digits +
// optional dot (14.1, 14, 14.10).
const RACK_HREF_RE = /^widash:\/\/rack\/([A-Z]{2,4}[0-9]{1,3})\/([A-Za-z0-9.\-]{1,20})$/i;
const ROOM_HREF_RE = /^widash:\/\/room\/([A-Z]{2,4}[0-9]{1,3})\/([0-9]{1,3}(?:\.[0-9]{1,3})?)$/i;
// Hostname: fully-qualified or short, letters/digits/dot/dash; tight
// upper bound so the URL bar / event detail can't be abused as a
// scratch buffer.
const HOSTNAME_HREF_RE = /^widash:\/\/hostname\/([A-Za-z0-9][A-Za-z0-9.\-]{1,79})$/;
// Serial / asset tag: same regex the backend uses.
const SERIAL_HREF_RE = /^widash:\/\/serial\/([A-Za-z0-9][A-Za-z0-9\-]{3,31})$/;

export interface ChatLinkHandlers {
  onOpenCaseNumber?: (caseNumber: string) => void;
  onOpenRack?: (site: string, rack: string) => void;
  onOpenRoom?: (site: string, room: string) => void;
  onOpenIdentifier?: (kind: "hostname" | "serial", value: string) => void;
}

type WidashLink =
  | { kind: "case"; caseNumber: string }
  | { kind: "rack"; site: string; rack: string }
  | { kind: "room"; site: string; room: string }
  | { kind: "hostname"; value: string }
  | { kind: "serial"; value: string };

function parseWidashLink(url: string): WidashLink | null {
  let m = url.match(CASE_HREF_RE);
  if (m) return { kind: "case", caseNumber: m[1] };
  m = url.match(RACK_HREF_RE);
  if (m) return { kind: "rack", site: m[1].toUpperCase(), rack: m[2] };
  m = url.match(ROOM_HREF_RE);
  if (m) return { kind: "room", site: m[1].toUpperCase(), room: m[2] };
  m = url.match(HOSTNAME_HREF_RE);
  if (m) return { kind: "hostname", value: m[1] };
  m = url.match(SERIAL_HREF_RE);
  if (m) return { kind: "serial", value: m[1] };
  return null;
}

const ALLOWED_MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;
type Model = (typeof ALLOWED_MODELS)[number];
const DEFAULT_MODEL: Model = "claude-sonnet-4-6";

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.85;  // never let the sidebar cover the whole screen
const STORAGE_KEY = "widash.chat.model";
const WIDTH_STORAGE_KEY = "widash.chat.width";
const CONVERSATIONS_STORAGE_KEY = "widash.chat.conversations";
const ACTIVE_ID_STORAGE_KEY = "widash.chat.activeId";
// Bound on how many past conversations we keep. Old ones at the
// bottom of the list get evicted FIFO so the localStorage payload
// doesn't grow without limit (every entry can be tens of KB).
const MAX_CONVERSATIONS = 30;
// Day-by-day token usage tally, persisted locally. Counts only the
// chats the user runs in WiDash — DevBar already shows the global
// figure across every Claude integration, so this gives the user a
// scoped "what did THIS app cost me today / this month" reading.
// Map shape: { "YYYY-MM-DD": {input, output}, … }.
const USAGE_STORAGE_KEY = "widash.chat.usageByDay";
// Don't keep tallies beyond a year — we only ever display today and
// the current month, anything older is dead weight.
const USAGE_RETENTION_DAYS = 400;

type DayKey = string;  // "YYYY-MM-DD"
/** Per-day tally, broken out by model so we can multiply by the
 *  right rate to get a dollar figure. Old single-bucket entries
 *  from before this split are migrated into the Sonnet slot on
 *  load, because Sonnet is (and always was) the default model. */
interface UsageBucket { input: number; output: number }
interface DayUsage {
  byModel: Record<Model, UsageBucket>;
}
type UsageByDay = Record<DayKey, DayUsage>;

// Anthropic public Claude pricing (USD per 1,000,000 tokens). Source:
// claude.com/pricing — Sonnet 4.6 / Opus 4.7 standard rates as of
// 2026-06. The SF Express LLM Gateway is a transparent passthrough,
// so cost attribution lines up 1:1. If Anthropic changes pricing,
// update these constants in the same commit.
const PRICING: Record<Model, { inPerM: number; outPerM: number }> = {
  "claude-sonnet-4-6": { inPerM: 3.00, outPerM: 15.00 },
  "claude-opus-4-7":   { inPerM: 15.00, outPerM: 75.00 },
};

function emptyDay(): DayUsage {
  return {
    byModel: {
      "claude-sonnet-4-6": { input: 0, output: 0 },
      "claude-opus-4-7":   { input: 0, output: 0 },
    },
  };
}

function costFor(b: UsageBucket, m: Model): number {
  const p = PRICING[m];
  return (b.input * p.inPerM + b.output * p.outPerM) / 1_000_000;
}

function dayCost(d: DayUsage): number {
  let sum = 0;
  for (const m of ALLOWED_MODELS) sum += costFor(d.byModel[m], m);
  return sum;
}

function dayTokens(d: DayUsage): number {
  let sum = 0;
  for (const m of ALLOWED_MODELS) sum += d.byModel[m].input + d.byModel[m].output;
  return sum;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "$0.00";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}

function todayKey(d: Date = new Date()): DayKey {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadUsage(): UsageByDay {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS);
    const cutoffKey = todayKey(cutoff);
    const out: UsageByDay = {};
    for (const [k, v] of Object.entries(data)) {
      if (k < cutoffKey) continue;
      const day = emptyDay();
      // v2 shape: { byModel: { "claude-…": {input, output}, … } }
      const byModel = (v as any)?.byModel;
      if (byModel && typeof byModel === "object") {
        for (const m of ALLOWED_MODELS) {
          const b = byModel[m];
          if (b && typeof b.input === "number" && typeof b.output === "number") {
            day.byModel[m] = { input: b.input, output: b.output };
          }
        }
        out[k] = day;
        continue;
      }
      // v1 shape: { input, output } at the day root. Migrate into
      // Sonnet's slot — it was the only default model when v1 ran.
      const flat = v as UsageBucket;
      if (typeof flat?.input === "number" && typeof flat?.output === "number") {
        day.byModel[DEFAULT_MODEL] = { input: flat.input, output: flat.output };
        out[k] = day;
      }
    }
    return out;
  } catch { return {}; }
}

function saveUsage(usage: UsageByDay) {
  try { localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage)); }
  catch { /* quota — accept the loss */ }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

interface ToolEvent {
  name: string;
  status: "started" | "finished";
  ts: number;
}

interface RenderedMessage extends ChatMessage {
  /** Tool calls Claude made *before* this assistant message — shown as
   *  small ghost lines so the user sees what data was fetched. */
  tools?: ToolEvent[];
  /** True while Claude is still streaming this message. */
  streaming?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  messages: RenderedMessage[];
  /** Wall-clock ms of the last message — used to sort the history
   *  list so recently-used conversations float to the top. */
  updatedAt: number;
}

function newConversationId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function titleFromText(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  if (!s) return "Neue Unterhaltung";
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    // Drop entries that don't structurally match Conversation — a
    // corrupted localStorage shouldn't crash the sidebar on mount.
    return data
      .filter((c): c is Conversation =>
        c && typeof c.id === "string"
        && typeof c.title === "string"
        && Array.isArray(c.messages)
        && typeof c.updatedAt === "number"
      )
      // Strip any stale "streaming: true" flags from a conversation
      // that was persisted mid-stream (rare but possible if the user
      // hard-reloads while a reply is in flight).
      .map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({ ...m, streaming: false })),
      }));
  } catch { return []; }
}

function loadInitialActiveId(conversations: Conversation[]): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_ID_STORAGE_KEY);
    if (v && conversations.some((c) => c.id === v)) return v;
  } catch { /* ignore */ }
  return conversations[0]?.id ?? null;
}

interface ChatSidebarProps extends ChatLinkHandlers {}

/** Floating chat sidebar — pill bottom-right opens an overlay panel.
 *  Read-only assistant. Conversations are persisted to localStorage
 *  so closing the panel (or reloading the tab) doesn't lose them.
 *  Multiple conversations can coexist; the history list at the top
 *  of the panel lets the user switch back and forth, start a new
 *  one, or delete an old one. */
export function ChatSidebar(props: ChatSidebarProps = {}) {
  const linkHandlers: ChatLinkHandlers = props;
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(
    () => loadConversations(),
  );
  const [activeId, setActiveId] = useState<string | null>(
    () => loadInitialActiveId(loadConversations()),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last user message we tried to send — surfaced via a Retry button
  // in the error banner so a transient gateway failure or stale
  // history doesn't make the user retype their question.
  const [lastUserText, setLastUserText] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageByDay>(() => loadUsage());
  useEffect(() => { saveUsage(usage); }, [usage]);

  // Compute today's + this-month's totals from the daily buckets.
  // Recomputes on every render, which is fine — usage is small (one
  // entry per day, <400 entries) and the math is trivial.
  const today = todayKey();
  const monthPrefix = today.slice(0, 7);  // "YYYY-MM"
  const todayUsage = usage[today];
  const todayTokens = todayUsage ? dayTokens(todayUsage) : 0;
  const todayCostUsd = todayUsage ? dayCost(todayUsage) : 0;
  let monthTokens = 0;
  let monthCostUsd = 0;
  for (const [k, v] of Object.entries(usage)) {
    if (k.startsWith(monthPrefix)) {
      monthTokens += dayTokens(v);
      monthCostUsd += dayCost(v);
    }
  }

  function recordUsage(modelUsed: Model, input: number, output: number) {
    if (!input && !output) return;
    setUsage((prev) => {
      const k = todayKey();
      const cur = prev[k] ?? emptyDay();
      const bucket = cur.byModel[modelUsed];
      return {
        ...prev,
        [k]: {
          byModel: {
            ...cur.byModel,
            [modelUsed]: {
              input: bucket.input + input,
              output: bucket.output + output,
            },
          },
        },
      };
    });
  }
  const [model, setModel] = useState<Model>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY) as Model | null;
      if (v && ALLOWED_MODELS.includes(v)) return v;
    } catch { /* ignore */ }
    return DEFAULT_MODEL;
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, model); } catch { /* ignore */ }
  }, [model]);

  // Persist conversations + activeId on every change. Conversations
  // can be large (tool outputs are inlined into the assistant
  // turns), so we serialise once per state update — cheap enough,
  // and means a hard refresh recovers the latest state.
  useEffect(() => {
    try {
      localStorage.setItem(
        CONVERSATIONS_STORAGE_KEY,
        JSON.stringify(conversations),
      );
    } catch { /* quota exceeded — accept the loss silently */ }
  }, [conversations]);
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(ACTIVE_ID_STORAGE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_ID_STORAGE_KEY);
    } catch { /* ignore */ }
  }, [activeId]);

  const activeConversation = activeId
    ? conversations.find((c) => c.id === activeId) ?? null
    : null;
  const messages: RenderedMessage[] = activeConversation?.messages ?? [];

  // Persisted panel width (pixels). Restored from localStorage on
  // first mount, clamped to current viewport so a previously-saved
  // ultra-wide value on a big monitor doesn't cover everything on a
  // smaller one.
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
      if (Number.isFinite(v) && v >= MIN_WIDTH) return v;
    } catch { /* ignore */ }
    return DEFAULT_WIDTH;
  });
  useEffect(() => {
    try { localStorage.setItem(WIDTH_STORAGE_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);
  // Clamp to viewport — runs on mount and on window resize so a saved
  // 1200px width is reduced if the user docks a smaller window.
  useEffect(() => {
    const clamp = () => {
      const max = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
      setWidth((w) => Math.max(MIN_WIDTH, Math.min(w, max)));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Drag-to-resize: pointer-events on the handle, updates width while
  // moving. Listener attached on window so a fast drag that leaves the
  // handle doesn't strand us in "dragging" state.
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const max = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
      // Sidebar is on the LEFT, so dragging the right-edge handle
      // rightward (positive dx) widens the panel.
      const next = Math.max(MIN_WIDTH, Math.min(startWidth + (ev.clientX - startX), max));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Auto-scroll to the latest message as deltas come in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ESC closes the sidebar (only when not in the middle of typing
  // a multi-line message — Shift+Esc would be unexpected). Also
  // focus the input on open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Cancel any in-flight stream when the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  function handleNewConversation() {
    if (busy) abortRef.current?.abort();
    const id = newConversationId();
    setConversations((prev) => {
      const next: Conversation[] = [
        { id, title: t("chat.newConversation"), messages: [], updatedAt: Date.now() },
        ...prev,
      ];
      return next.slice(0, MAX_CONVERSATIONS);
    });
    setActiveId(id);
    setError(null);
    setDraft("");
    setHistoryOpen(false);
  }

  function handleSelectConversation(id: string) {
    if (busy) abortRef.current?.abort();
    setActiveId(id);
    setError(null);
    setHistoryOpen(false);
  }

  function handleDeleteConversation(id: string) {
    if (busy && id === activeId) abortRef.current?.abort();
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) {
      const remaining = conversations.filter((c) => c.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }

  /** Clear the currently-active conversation. Kept around because
   *  the trash icon is right next to "new" — some users prefer
   *  emptying the running thread over starting a fresh one. */
  function handleClear() {
    if (busy) abortRef.current?.abort();
    if (!activeId) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? { ...c, messages: [], title: t("chat.newConversation"), updatedAt: Date.now() }
          : c,
      ),
    );
    setError(null);
  }

  async function handleRetry() {
    if (busy || !lastUserText) return;
    // Drop the trailing user/assistant pair from the failed attempt
    // so handleSend rebuilds the turn cleanly. The error handler
    // already pops empty assistant placeholders, but a tool-call
    // round may have left a half-finished one — drop both kinds.
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        const msgs = [...c.messages];
        while (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          if (last.role === "assistant") { msgs.pop(); continue; }
          if (last.role === "user" && last.content === lastUserText) {
            msgs.pop();
          }
          break;
        }
        return { ...c, messages: msgs, updatedAt: Date.now() };
      }),
    );
    setError(null);
    await handleSend(lastUserText);
  }

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? draft).trim();
    if (!text || busy) return;
    setError(null);
    setLastUserText(text);
    if (!overrideText) setDraft("");

    // Ensure an active conversation exists — first message in a
    // fresh panel session creates one implicitly.
    let convoId = activeId;
    if (!convoId) {
      convoId = newConversationId();
      setConversations((prev) => [
        { id: convoId!, title: titleFromText(text), messages: [], updatedAt: Date.now() },
        ...prev,
      ].slice(0, MAX_CONVERSATIONS));
      setActiveId(convoId);
    }

    const userMsg: RenderedMessage = { role: "user", content: text };
    const assistantMsg: RenderedMessage = {
      role: "assistant", content: "", streaming: true, tools: [],
    };
    // Strip empty / whitespace-only bubbles before sending. A stale
    // aborted assistant placeholder in the persisted history would
    // otherwise hit the Anthropic API with content=""; the Pydantic
    // schema now tolerates it but the upstream model still rejects.
    const baseHistory: ChatMessage[] = [
      ...messages
        .filter((m) => m.content.trim().length > 0)
        .map(({ role, content }) => ({ role, content })),
      { role: "user", content: text },
    ];

    // Append the new user message and a streaming-placeholder
    // assistant message to the active conversation, and stamp the
    // conversation title from the first user message if it was
    // still the default "Neue Unterhaltung".
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convoId) return c;
        const isFirstTurn = c.messages.length === 0;
        return {
          ...c,
          title: isFirstTurn ? titleFromText(text) : c.title,
          messages: [...c.messages, userMsg, assistantMsg],
          updatedAt: Date.now(),
        };
      }),
    );
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Helper that mutates the streaming assistant message at the
    // tail of the conversation. Resolves the conversation by id
    // (not by closure capture of activeId) so it keeps working
    // even if the user switched tabs mid-stream.
    const mutateTail = (
      fn: (msg: RenderedMessage) => RenderedMessage,
      filter: (msg: RenderedMessage) => boolean = (m) => m.role === "assistant",
    ) => {
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convoId) return c;
          const msgs = [...c.messages];
          const last = msgs[msgs.length - 1];
          if (last && filter(last)) msgs[msgs.length - 1] = fn(last);
          return { ...c, messages: msgs, updatedAt: Date.now() };
        }),
      );
    };

    // Pin the model used for THIS request — the dropdown may flip
    // mid-stream and we want cost attributed to whichever model
    // the gateway actually ran.
    const modelUsed: Model = model;

    try {
      for await (const ev of streamChat(
        { messages: baseHistory, model: modelUsed },
        ctrl.signal,
      )) {
        if (ev.kind === "delta") {
          mutateTail((m) => ({ ...m, content: m.content + ev.text }));
        } else if (ev.kind === "tool") {
          mutateTail((m) => ({
            ...m,
            tools: [
              ...(m.tools ?? []),
              { name: ev.name, status: ev.status, ts: Date.now() },
            ],
          }));
        } else if (ev.kind === "done") {
          mutateTail((m) => ({ ...m, streaming: false }));
          if (ev.usage) recordUsage(modelUsed, ev.usage.input, ev.usage.output);
        } else if (ev.kind === "error") {
          setError(ev.message || "error");
          // Drop the empty assistant placeholder so we don't leave a
          // dangling "…" bubble; otherwise just mark it not-streaming.
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convoId) return c;
              const msgs = [...c.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.role === "assistant" && !last.content) {
                msgs.pop();
              } else if (last && last.role === "assistant") {
                msgs[msgs.length - 1] = { ...last, streaming: false };
              }
              return { ...c, messages: msgs, updatedAt: Date.now() };
            }),
          );
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message ?? "stream_failed");
      }
      mutateTail((m) => ({ ...m, streaming: false }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }


  return (
    <>
      {/* Floating launcher pill — hidden while sidebar open. Sits
       *  bottom-left so it visually previews where the sidebar will
       *  slide in from. Raised above the case-tabs dock so it never
       *  hides behind a minimised case tab. */}
      {!open && (
        <button
          type="button"
          aria-label={t("chat.open")}
          title={t("chat.open")}
          onClick={() => setOpen(true)}
          className="fixed bottom-24 left-6 solid-panel surface-1-hover px-4 py-3 text-sm flex items-center gap-2 cursor-pointer"
          style={{ zIndex: 1900 }}
        >
          <ChatGlyph />
          <span className="font-medium">{t("chat.launcherLabel")}</span>
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.aside
            key="chat-panel"
            initial={{ x: -width }}
            animate={{ x: 0 }}
            exit={{ x: -width }}
            transition={{ type: "tween", duration: 0.22 }}
            // The left edge sits flush against the viewport, so the
            // 24px panel corners there are wasted — and at the right
            // edge they leave a gap behind the panel where the rounded
            // SVG doesn't cover the background. Square off the left,
            // keep the right rounded.
            className="solid-panel fixed top-0 left-0 h-screen flex flex-col !rounded-l-none overflow-hidden"
            style={{ width, zIndex: 2000 }}
            role="dialog"
            aria-label={t("chat.title")}
          >
              {/* Header */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 divider-b">
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  aria-expanded={historyOpen}
                  aria-label={t("chat.history")}
                  title={t("chat.history")}
                  className="flex items-center gap-2 min-w-0 cursor-pointer hover:opacity-80"
                >
                  <ChatGlyph />
                  <h2 className="text-sm font-medium truncate">
                    {activeConversation?.title ?? t("chat.title")}
                  </h2>
                  <svg viewBox="0 0 24 24" width="12" height="12"
                    fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden focusable="false"
                    className={`transition-transform ${historyOpen ? "rotate-180" : ""}`}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <div className="flex items-center gap-1">
                  <select
                    aria-label={t("chat.model")}
                    title={t("chat.model")}
                    value={model}
                    onChange={(e) => setModel(e.target.value as Model)}
                    disabled={busy}
                    className="surface-1 surface-1-hover text-xs px-2 py-1 rounded"
                  >
                    <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                    <option value="claude-opus-4-7">Opus 4.7</option>
                  </select>
                  <IconButton
                    aria-label={t("chat.newConversation")}
                    title={t("chat.newConversation")}
                    onClick={handleNewConversation}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden focusable="false">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </IconButton>
                  <IconButton
                    aria-label={t("chat.clear")}
                    title={t("chat.clear")}
                    onClick={handleClear}
                    disabled={messages.length === 0 && !busy}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden focusable="false">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </IconButton>
                  <IconButton
                    aria-label={t("chat.minimize")}
                    title={t("chat.minimize")}
                    onClick={() => setOpen(false)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden focusable="false">
                      <path d="M5 12h14" />
                    </svg>
                  </IconButton>
                </div>
              </div>

              {/* History dropdown — collapsible list of past
                  conversations, sorted most-recent-first. The active
                  conversation is highlighted, every entry has its
                  own delete (×) button. Hidden by default to keep
                  the panel quiet. */}
              {historyOpen && (
                <div className="divider-b max-h-60 overflow-y-auto">
                  {conversations.length === 0 ? (
                    <div className="px-4 py-3 text-xs opacity-60">
                      {t("chat.historyEmpty")}
                    </div>
                  ) : (
                    [...conversations]
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .map((c) => (
                        <div
                          key={c.id}
                          className={`flex items-center gap-2 px-4 py-2 text-sm group cursor-pointer ${
                            c.id === activeId
                              ? "bg-sky-500/15"
                              : "surface-1-hover"
                          }`}
                          onClick={() => handleSelectConversation(c.id)}
                        >
                          <span className="flex-1 min-w-0 truncate">
                            {c.title || t("chat.newConversation")}
                          </span>
                          <span className="text-xs opacity-50 shrink-0">
                            {c.messages.length}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConversation(c.id);
                            }}
                            aria-label={t("chat.deleteConversation")}
                            title={t("chat.deleteConversation")}
                            className="opacity-40 hover:opacity-100 hover:text-red-500 cursor-pointer p-1"
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12"
                              fill="none" stroke="currentColor" strokeWidth="2"
                              strokeLinecap="round" strokeLinejoin="round"
                              aria-hidden focusable="false">
                              <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          </button>
                        </div>
                      ))
                  )}
                </div>
              )}

              {/* Hint banner — first thing the user sees in an empty
                  conversation. Read-only + logging caveat in two
                  lines so they know what they're working with. */}
              {messages.length === 0 && (
                <div className="px-4 py-3 text-xs opacity-70">
                  {t("chat.intro")}
                </div>
              )}

              {/* Message log */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto px-4 py-2 space-y-3 text-sm"
              >
                {messages.map((m, i) => (
                  <MessageBubble
                    key={i}
                    message={m}
                    t={t}
                    linkHandlers={linkHandlers}
                  />
                ))}
                {error && (
                  <div className="px-3 py-2 rounded text-xs border border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10 flex items-start gap-2">
                    <div className="flex-1 min-w-0 break-words">
                      <div className="font-medium mb-0.5">{t("chat.errorTitle")}</div>
                      <div className="opacity-80">{error}</div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      {lastUserText && !busy && (
                        <button
                          type="button"
                          onClick={handleRetry}
                          className="surface-1 surface-1-hover px-2 py-1 rounded text-xs cursor-pointer"
                          title={t("chat.retryTooltip")}
                        >
                          ↻ {t("chat.retry")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setError(null)}
                        className="surface-1 surface-1-hover px-2 py-1 rounded text-xs cursor-pointer opacity-70"
                        aria-label={t("common.close")}
                        title={t("common.close")}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="px-4 py-3 divider-t">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={t("chat.placeholder")}
                  rows={3}
                  disabled={busy}
                  className="surface-1 w-full px-3 py-2 rounded text-sm resize-none focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                />
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="text-xs opacity-50 truncate">
                    {t("chat.enterHint")}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className="text-xs opacity-60 tabular-nums"
                      title={t("chat.tokenTooltip", {
                        today: todayTokens.toLocaleString(),
                        todayCost: todayCostUsd.toFixed(4),
                        month: monthTokens.toLocaleString(),
                        monthCost: monthCostUsd.toFixed(4),
                      })}
                    >
                      {t("chat.tokenToday")}: {formatTokens(todayTokens)} ({formatCost(todayCostUsd)})
                      {" · "}
                      {t("chat.tokenMonth")}: {formatTokens(monthTokens)} ({formatCost(monthCostUsd)})
                    </span>
                    {busy ? (
                      <button
                        type="button"
                        onClick={() => abortRef.current?.abort()}
                        className="surface-1 surface-1-hover px-3 py-1 text-xs rounded cursor-pointer"
                      >
                        {t("chat.stop")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSend()}
                        disabled={!draft.trim()}
                        className="px-3 py-1 text-xs rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      >
                        {t("chat.send")}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Drag-to-resize handle — pinned to the right edge of
                  the panel. Wider hit area than visible line so it's
                  easy to grab. */}
              <div
                onPointerDown={startResize}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("chat.resize")}
                title={t("chat.resize")}
                className="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize group"
                style={{ touchAction: "none" }}
              >
                <div className="h-full w-px ml-auto bg-white/10 group-hover:bg-sky-500/60 transition-colors" />
              </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

function MessageBubble({
  message, t, linkHandlers,
}: {
  message: RenderedMessage;
  t: (k: any) => string;
  linkHandlers: ChatLinkHandlers;
}) {
  const isUser = message.role === "user";
  const tools = message.tools ?? [];
  // Collapse "started"/"finished" pairs: only show a line when the
  // tool actually finished, with a tiny dot for the in-flight one.
  const finished = tools.filter((tt) => tt.status === "finished");
  const inflight = tools.filter((tt) => tt.status === "started").length
    - finished.length;
  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
    >
      {tools.length > 0 && (
        <div className="text-xs opacity-50 mb-1 space-y-0.5">
          {finished.map((tt, i) => (
            <div key={i}>· {prettyToolName(tt.name)} ✓</div>
          ))}
          {inflight > 0 && (
            <div>· {t("chat.toolRunning")}…</div>
          )}
        </div>
      )}
      <div
        className={
          "px-3 py-2 rounded-lg max-w-[90%] break-words " +
          (isUser
            ? "bg-sky-600 text-white whitespace-pre-wrap"
            : "surface-1 text-current")
        }
      >
        {isUser ? (
          message.content
        ) : message.content ? (
          <AssistantMarkdown
            content={message.content}
            linkHandlers={linkHandlers}
          />
        ) : message.streaming ? (
          "…"
        ) : null}
      </div>
    </div>
  );
}

/** Renders assistant Markdown with WiDash styling. react-markdown
 *  escapes inline HTML by default, so chatter content surfaced through
 *  a tool result can't break out into the DOM. */
function AssistantMarkdown({
  content, linkHandlers,
}: {
  content: string;
  linkHandlers: ChatLinkHandlers;
}) {
  return (
    <div className="markdown-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown's default urlTransform drops anything that's
        // not http / https / mailto / tel, which silently kills our
        // widash:// links — they reach the DOM as bare text. Allow
        // both http(s) and widash; reject everything else (data:,
        // javascript:, file: …) so a prompt-injected link can't
        // smuggle code in.
        urlTransform={(url) => {
          if (typeof url !== "string") return "";
          if (/^https?:\/\//i.test(url)) return url;
          if (/^widash:\/\//i.test(url)) return url;
          return "";
        }}
        components={{
          a({ href, children, ...rest }) {
            const url = typeof href === "string" ? href : "";
            const parsed = parseWidashLink(url);
            if (parsed) {
              const dispatch = () => {
                if (parsed.kind === "case") {
                  linkHandlers.onOpenCaseNumber?.(parsed.caseNumber);
                } else if (parsed.kind === "rack") {
                  linkHandlers.onOpenRack?.(parsed.site, parsed.rack);
                } else if (parsed.kind === "room") {
                  linkHandlers.onOpenRoom?.(parsed.site, parsed.room);
                } else {
                  linkHandlers.onOpenIdentifier?.(parsed.kind, parsed.value);
                }
              };
              return (
                <button
                  type="button"
                  onClick={dispatch}
                  className="underline decoration-dotted underline-offset-2 text-sky-600 dark:text-sky-300 hover:text-sky-500 dark:hover:text-sky-200 cursor-pointer"
                >
                  {children}
                </button>
              );
            }
            const safe = /^https?:\/\//i.test(url) ? url : undefined;
            return (
              <a
                {...rest}
                href={safe}
                target={safe ? "_blank" : undefined}
                rel={safe ? "noopener noreferrer" : undefined}
                className="underline decoration-dotted underline-offset-2 text-sky-600 dark:text-sky-300 hover:text-sky-500 dark:hover:text-sky-200"
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse w-full">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="text-left font-semibold px-2 py-1 border-b divider-b">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-2 py-1 align-top border-b divider-b">
                {children}
              </td>
            );
          },
          code({ inline, children, ...rest }: any) {
            if (inline) {
              return (
                <code
                  {...rest}
                  className="surface-2 rounded px-1 py-0.5 text-[0.85em] font-mono"
                >
                  {children}
                </code>
              );
            }
            return (
              <pre className="surface-2 rounded p-2 my-2 overflow-x-auto text-xs">
                <code className="font-mono">{children}</code>
              </pre>
            );
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>;
          },
          p({ children }) {
            return <p className="my-1 leading-snug">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="text-sm font-semibold mt-2 mb-1">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-sm font-semibold mt-2 mb-1">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-xs font-semibold mt-2 mb-1 uppercase opacity-70">{children}</h3>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-sky-500/40 pl-2 my-1 opacity-80">
                {children}
              </blockquote>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function prettyToolName(name: string): string {
  switch (name) {
    case "list_rmas": return "list_rmas";
    case "list_status_tickets": return "list_status_tickets";
    case "get_case": return "get_case";
    case "recent_activity": return "recent_activity";
    case "temps_overview": return "temps_overview";
    case "temps_rack": return "temps_rack";
    case "coolan_components": return "coolan_components";
    case "patchplan_search": return "patchplan_search";
    default: return name;
  }
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </svg>
  );
}
