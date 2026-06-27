import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconButton } from "./IconButton";
import { useLanguage, localeFor } from "../hooks/useLanguage";
import { streamChat, type ChatMessage, patchCase, patchAsset, postCaseComment, patchChatterEntry, type ProposalPayload } from "../api";
import { ProposalCard } from "./ProposalCard";
import { EditConfirmModal } from "./EditConfirmModal";
import { ChatterConfirmModal } from "./ChatterConfirmModal";
import { useWriteMode } from "../hooks/useWriteMode";

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, "")}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Small "HH:MM · DD.MM.YYYY" stamp using the browser locale. */
function formatStamp(at: number, locale: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const date = d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${time} · ${date}`;
}

interface ToolEvent {
  name: string;
  status: "started" | "finished";
  ts: number;
}

export type ProposalLineState = "pending" | "applied" | "discarded" | "failed";

interface ProposalLine {
  proposal: ProposalPayload;
  state: ProposalLineState;
  errorMessage?: string | null;
}

export type ProposalGroupState =
  "pending" | "confirming" | "applied" | "discarded" | "failed";

interface ProposalGroup {
  groupId: string;             // p_<6-hex> (FE-generated)
  toolName: "propose_case_patch" | "propose_chatter_post" | "propose_chatter_edit";
  state: ProposalGroupState;
  lines: ProposalLine[];
  errorMessage?: string | null;
}

interface RenderedMessage extends ChatMessage {
  /** Tool calls Claude made *before* this assistant message — shown as
   *  small ghost lines so the user sees what data was fetched. */
  tools?: ToolEvent[];
  /** True while Claude is still streaming this message. */
  streaming?: boolean;
  /** Proposals attached to this assistant message. */
  proposalGroups?: ProposalGroup[];
  /** Completion stamp for assistant messages: wall-clock the reply
   *  finished, how long it took, and the turn's token total. Rendered
   *  as a small footer under the bubble. */
  meta?: { at: number; durationMs: number; tokens: number };
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

function newGroupId(): string {
  // 6 hex chars, prefix g_ so it's distinguishable from the server-
  // generated p_<...> proposalIds in logs.
  const rnd = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `g_${rnd}`;
}

function toolFromProposalKind(k2: ProposalPayload["kind2"]): ProposalGroup["toolName"] {
  if (k2 === "case_patch_proposal") return "propose_case_patch";
  if (k2 === "chatter_post_proposal") return "propose_chatter_post";
  return "propose_chatter_edit";
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
      // hard-reloads while a reply is in flight). Also discard any
      // pending/confirming proposals — proposalIds are only tab-lifetime
      // valid, a stale pending card could execute against outdated data.
      .map((c) => ({
        ...c,
        messages: c.messages.map((m) => {
          const msg = m as RenderedMessage & { proposals?: unknown };
          delete msg.proposals;
          return {
            ...msg,
            streaming: false,
            proposalGroups: msg.proposalGroups?.map((g) =>
              g.state === "pending" || g.state === "confirming"
                ? {
                    ...g,
                    state: "discarded" as const,
                    lines: g.lines.map((l) => ({ ...l, state: "discarded" as const })),
                  }
                : g,
            ),
          };
        }),
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
 *  Reads freely; writes only via confirm-gated proposals. Conversations
 *  are persisted to localStorage
 *  so closing the panel (or reloading the tab) doesn't lose them.
 *  Multiple conversations can coexist; the history list at the top
 *  of the panel lets the user switch back and forth, start a new
 *  one, or delete an old one. */
export function ChatSidebar(props: ChatSidebarProps = {}) {
  const linkHandlers: ChatLinkHandlers = props;
  const { t, lang } = useLanguage();
  const writeMode = useWriteMode();
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
  // Live "working" indicator for the in-flight turn: what Claude is
  // doing right now + running token total + when the turn started. Null
  // when idle. Kept out of the persisted message so it never lands in
  // localStorage. startedAt drives the seconds counter in WorkingLine.
  const [work, setWork] = useState<{
    phase: "thinking" | "tool" | "writing";
    tool?: string;
    input: number;
    output: number;
    startedAt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Last user message we tried to send — surfaced via a Retry button
  // in the error banner so a transient gateway failure or stale
  // history doesn't make the user retype their question.
  const [lastUserText, setLastUserText] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageByDay>(() => loadUsage());
  useEffect(() => { saveUsage(usage); }, [usage]);

  // Proposal confirmation state
  const [activeConfirmGroupId, setActiveConfirmGroupId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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
    const turnStartedAt = Date.now();
    setWork({ phase: "thinking", input: 0, output: 0, startedAt: turnStartedAt });

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

    // kept across all proposal events of THIS streamChat run
    const currentTurnGroups = new Map<string, string>();   // toolName → groupId

    // The gateway only reports output_tokens once, at the end of each
    // round — so we can't show a live count from the wire. Instead we
    // estimate output from streamed characters (~4 chars/token) as text
    // arrives, and let the real `usage` numbers override when they land.
    let streamedChars = 0;
    let realInput = 0;

    try {
      for await (const ev of streamChat(
        { messages: baseHistory, model: modelUsed },
        ctrl.signal,
      )) {
        if (ev.kind === "delta") {
          mutateTail((m) => ({ ...m, content: m.content + ev.text }));
          streamedChars += ev.text.length;
          // First text after a tool round means Claude is composing again.
          setWork((w) =>
            w
              ? { ...w, phase: "writing", tool: undefined,
                  output: Math.max(w.output, Math.ceil(streamedChars / 4)) }
              : w,
          );
        } else if (ev.kind === "tool") {
          mutateTail((m) => ({
            ...m,
            tools: [
              ...(m.tools ?? []),
              { name: ev.name, status: ev.status, ts: Date.now() },
            ],
          }));
          setWork((w) =>
            w
              ? ev.status === "started"
                ? { ...w, phase: "tool", tool: ev.name }
                : { ...w, phase: "thinking", tool: undefined }
              : w,
          );
        } else if (ev.kind === "usage") {
          realInput = ev.input;
          setWork((w) =>
            w ? { ...w, input: ev.input, output: Math.max(w.output, ev.output) } : w,
          );
        } else if (ev.kind === "proposal") {
          // Map is the source of truth for "which group within THIS
          // streamChat run holds proposals of this tool-name". Look up /
          // allocate the group-id synchronously here; the setState
          // reducer below uses React's guarantee that `prev` is the
          // latest state (so it correctly sees a group created by a
          // previous event of the same turn — even if React hasn't
          // committed a render between events).
          const toolName = toolFromProposalKind(ev.proposal.kind2);
          let groupId = currentTurnGroups.get(toolName);
          if (!groupId) {
            groupId = newGroupId();
            currentTurnGroups.set(toolName, groupId);
          }
          const targetGroupId = groupId;
          mutateTail((m) => {
            const groups = m.proposalGroups ?? [];
            const exists = groups.some((g) => g.groupId === targetGroupId);
            const next = exists
              ? groups.map((g) =>
                  g.groupId === targetGroupId
                    ? { ...g, lines: [...g.lines, { proposal: ev.proposal, state: "pending" as const }] }
                    : g,
                )
              : [
                  ...groups,
                  {
                    groupId: targetGroupId,
                    toolName,
                    state: "pending" as const,
                    lines: [{ proposal: ev.proposal, state: "pending" as const }],
                  },
                ];
            return { ...m, proposalGroups: next };
          });
        } else if (ev.kind === "done") {
          // Prefer the real end-of-turn usage; fall back to the
          // estimate accumulated during the stream.
          const tokens = ev.usage
            ? ev.usage.input + ev.usage.output
            : realInput + Math.ceil(streamedChars / 4);
          mutateTail((m) => ({
            ...m,
            streaming: false,
            meta: { at: Date.now(), durationMs: Date.now() - turnStartedAt, tokens },
          }));
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
      setWork(null);
      abortRef.current = null;
    }
  }

  // Proposal helpers
  // Patch a whole group across all conversations.
  function updateGroup(groupId: string, patch: Partial<ProposalGroup>) {
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          proposalGroups: m.proposalGroups?.map((g) =>
            g.groupId === groupId ? { ...g, ...patch } : g,
          ),
        })),
      })),
    );
  }

  // Patch one line within a group.
  function updateLine(
    groupId: string,
    lineIndex: number,
    patch: Partial<ProposalLine>,
  ) {
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          proposalGroups: m.proposalGroups?.map((g) =>
            g.groupId === groupId
              ? {
                  ...g,
                  lines: g.lines.map((l, i) =>
                    i === lineIndex ? { ...l, ...patch } : l,
                  ),
                }
              : g,
          ),
        })),
      })),
    );
  }

  function appendSystemNote(text: string) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        return {
          ...c,
          messages: [...c.messages, {
            role: "user", content: text,
          }],
          updatedAt: Date.now(),
        };
      }),
    );
  }

  function confirmGroup(g: ProposalGroup) {
    if (activeConfirmGroupId) return;          // single-confirm lock
    setActiveConfirmGroupId(g.groupId);
    setConfirmError(null);
    updateGroup(g.groupId, { state: "confirming" });
  }

  function discardGroup(g: ProposalGroup) {
    updateGroup(g.groupId, {
      state: "discarded",
      lines: g.lines.map((l) => ({ ...l, state: "discarded" })),
    });
    appendSystemNote(
      `[Systeminfo: Batch-Vorschlag ${g.groupId} (${g.lines.length} Cases) wurde verworfen.]`,
    );
  }

  async function executeGroup(g: ProposalGroup) {
    // Dry-run path
    if (!writeMode.enabled) {
      updateGroup(g.groupId, {
        state: "applied",
        lines: g.lines.map((l) => ({ ...l, state: "applied" })),
      });
      appendSystemNote(
        `[Systeminfo: Batch-Vorschlag ${g.groupId} (Dry-Run, Write-Mode AUS, ${g.lines.length} Cases) simuliert.]`,
      );
      setActiveConfirmGroupId(null);
      return;
    }

    setConfirmBusy(true);
    setConfirmError(null);

    // Filter out lines already applied (Retry-Run scenario): only run pending/failed.
    const indexesToRun = g.lines
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.state === "pending" || x.l.state === "failed")
      .map((x) => x.i);

    let okCount = 0;
    let failCount = 0;
    const failDetails: string[] = [];

    for (const i of indexesToRun) {
      const p = g.lines[i].proposal;
      try {
        if (p.kind2 === "case_patch_proposal") {
          const caseChanges = p.changes
            .filter((c) => c.sobject === "case")
            .map((c) => ({ apiName: c.apiName, value: c.newValue as any }));
          const assetChanges = p.changes
            .filter((c) => c.sobject === "asset")
            .map((c) => ({ apiName: c.apiName, value: c.newValue as any }));
          if (caseChanges.length > 0) await patchCase(p.caseId, caseChanges);
          if (assetChanges.length > 0 && p.assetId) {
            await patchAsset(p.assetId, assetChanges);
          }
        } else if (p.kind2 === "chatter_post_proposal") {
          await postCaseComment(p.caseId, {
            source: p.source, body: p.body,
            parentFeedItemId: p.parentId ?? undefined,
            mentions: p.mentions?.map((m) => m.userId),
          });
        } else if (p.kind2 === "chatter_edit_proposal") {
          await patchChatterEntry(p.caseId, p.entryId, p.entryKind, p.newBody);
        }
        updateLine(g.groupId, i, { state: "applied", errorMessage: null });
        okCount++;
      } catch (e: any) {
        const msg = e?.message ?? "unknown_error";
        updateLine(g.groupId, i, { state: "failed", errorMessage: msg });
        failCount++;
        const caseLabel =
          p.kind2 === "chatter_edit_proposal"
            ? (p.caseNumber ?? p.entryId)
            : (p as any).caseNumber ?? "?";
        failDetails.push(`Case ${caseLabel} → ${msg}`);
      }
    }

    // Cumulative counts across all runs (including previously-applied
    // lines from an earlier partial-success run). Without this, a
    // retry that fixes the last 2 of 5 cases would post "2 ausgeführt"
    // and obscure the previous 3 in the conversation log.
    const previouslyApplied = g.lines.filter(
      (l, idx) => l.state === "applied" && !indexesToRun.includes(idx),
    ).length;
    const totalApplied = previouslyApplied + okCount;
    const totalCases = g.lines.length;

    // Compute aggregate state.
    const newState: ProposalGroupState = failCount === 0 ? "applied" : "failed";
    updateGroup(g.groupId, { state: newState });
    setConfirmBusy(false);
    if (failCount === 0) {
      setActiveConfirmGroupId(null);
      appendSystemNote(
        `[Systeminfo: Batch-Vorschlag ${g.groupId} — ${totalApplied}/${totalCases} ausgeführt.]`,
      );
    } else {
      // Modal stays open so the user sees the failed rows.
      setConfirmError(`${failCount}/${okCount + failCount} fehlgeschlagen`);
      appendSystemNote(
        `[Systeminfo: Batch-Vorschlag ${g.groupId} — ${totalApplied}/${totalCases} ausgeführt, ${failCount} fehlgeschlagen. ${failDetails.join("; ")}]`,
      );
    }
  }

  function cancelConfirm(g: ProposalGroup) {
    // Restore to "pending" only if none of the lines are applied/failed.
    // If a previous run partially applied, drop back to "failed" or
    // "applied" matching the line states.
    const anyFailed = g.lines.some((l) => l.state === "failed");
    const allApplied = g.lines.every((l) => l.state === "applied" || l.state === "discarded");
    const restoredState: ProposalGroupState = anyFailed
      ? "failed"
      : allApplied
      ? "applied"
      : "pending";
    updateGroup(g.groupId, { state: restoredState });
    setActiveConfirmGroupId(null);
    setConfirmError(null);
  }

  const activeGroup: ProposalGroup | null = (() => {
    if (!activeConfirmGroupId) return null;
    for (const c of conversations) {
      for (const m of c.messages) {
        const hit = (m.proposalGroups ?? []).find((g) => g.groupId === activeConfirmGroupId);
        if (hit) return hit;
      }
    }
    return null;
  })();

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
                  conversation. Capability + logging caveat so they
                  know what they're working with. */}
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
                    locale={localeFor(lang)}
                    linkHandlers={linkHandlers}
                    blocked={!!activeConfirmGroupId}
                    onConfirmGroup={confirmGroup}
                    onDiscardGroup={discardGroup}
                  />
                ))}
                {work && <WorkingLine work={work} t={t} />}
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

              {/* Proposal confirmation modals */}
              {activeGroup?.toolName === "propose_case_patch" && (() => {
                // Flatten all lines × all changes into one FieldChange[] for the modal.
                const allChanges = activeGroup.lines.flatMap((line) => {
                  const p = line.proposal as Extract<ProposalPayload, { kind2: "case_patch_proposal" }>;
                  return p.changes.map((c) => ({
                    apiName: c.apiName,
                    label: c.label,
                    type: (c.type ?? "string") as any,
                    oldValue: c.oldValue as any,
                    oldDisplay: c.oldDisplay,
                    newValue: c.newValue as any,
                    newDisplay: c.newDisplay,
                    sobject: c.sobject,
                    caseNumber: p.caseNumber,
                  }));
                });
                // The modal accepts a `changes` array; pass the first proposal's
                // caseNumber as the modal's `caseNumber` prop (header text).
                const first = activeGroup.lines[0].proposal as Extract<ProposalPayload, { kind2: "case_patch_proposal" }>;
                return (
                  <EditConfirmModal
                    caseNumber={t("chat.proposal.modalSubtitleCasesFirst", {
                      count: activeGroup.lines.length,
                      first: first.caseNumber,
                    })}
                    changes={allChanges}
                    onCancel={() => cancelConfirm(activeGroup!)}
                    onEdit={() => cancelConfirm(activeGroup!)}
                    onConfirm={() => executeGroup(activeGroup!)}
                    busy={confirmBusy}
                    error={confirmError}
                  />
                );
              })()}

              {activeGroup?.toolName === "propose_chatter_post" && (() => {
                const first = activeGroup.lines[0].proposal as Extract<ProposalPayload, { kind2: "chatter_post_proposal" }>;
                const entries = activeGroup.lines.map((line) => {
                  const p = line.proposal as Extract<ProposalPayload, { kind2: "chatter_post_proposal" }>;
                  return { caseNumber: p.caseNumber, body: p.body, mentions: p.mentions };
                });
                return (
                  <ChatterConfirmModal
                    caseNumber={t("chat.proposal.modalSubtitleCases", {
                      count: activeGroup.lines.length,
                    })}
                    mode={{ kind: "post-batch", source: first.source, entries }}
                    onCancel={() => cancelConfirm(activeGroup!)}
                    onConfirm={() => executeGroup(activeGroup!)}
                    busy={confirmBusy}
                    error={confirmError}
                  />
                );
              })()}

              {activeGroup?.toolName === "propose_chatter_edit" && (() => {
                const entries = activeGroup.lines.map((line) => {
                  const p = line.proposal as Extract<ProposalPayload, { kind2: "chatter_edit_proposal" }>;
                  return {
                    caseNumber: p.caseNumber ?? p.entryId.slice(0, 8),
                    oldBody: p.oldBody,
                    newBody: p.newBody,
                  };
                });
                return (
                  <ChatterConfirmModal
                    caseNumber={t("chat.proposal.modalSubtitleEdits", {
                      count: activeGroup.lines.length,
                    })}
                    mode={{ kind: "edit-batch", entries }}
                    onCancel={() => cancelConfirm(activeGroup!)}
                    onConfirm={() => executeGroup(activeGroup!)}
                    busy={confirmBusy}
                    error={confirmError}
                  />
                );
              })()}

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

// Cycling glyphs for the working spinner — same spirit as the
// Claude Code star. Plain unicode, no asset / lib needed.
const WORK_GLYPHS = ["✶", "✷", "✸", "✹", "✺", "✦", "✧", "✩"];

/** Live "working" indicator shown below the message log while a turn
 *  streams. Cycling star + rainbow-swept state text + seconds + running
 *  token total. All three timers are local to this component so they
 *  don't re-render the whole sidebar. */
function WorkingLine({
  work, t,
}: {
  work: { phase: "thinking" | "tool" | "writing"; tool?: string; input: number; output: number; startedAt: number };
  t: (k: any, vars?: Record<string, string | number>) => string;
}) {
  const [glyph, setGlyph] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const g = setInterval(() => setGlyph((i) => (i + 1) % WORK_GLYPHS.length), 110);
    const s = setInterval(() => setElapsed(Math.floor((Date.now() - work.startedAt) / 1000)), 250);
    return () => { clearInterval(g); clearInterval(s); };
  }, [work.startedAt]);

  const label =
    work.phase === "tool"
      ? t("chat.workTool", { tool: prettyToolName(work.tool ?? "") })
      : work.phase === "writing"
        ? t("chat.workWriting")
        : t("chat.workThinking");

  const tokens = work.input + work.output;

  return (
    <div className="flex items-center gap-2 text-xs opacity-80" aria-live="polite">
      <span className="text-sky-400 w-3 text-center" aria-hidden>{WORK_GLYPHS[glyph]}</span>
      <span
        className="font-medium bg-clip-text text-transparent bg-[length:200%_auto] animate-rainbow-sweep"
        style={{
          backgroundImage:
            "linear-gradient(90deg,#ff0080,#ffae00,#00ff80,#00d4ff,#8000ff,#ff0080)",
        }}
      >
        {label}…
      </span>
      <span className="opacity-50 tabular-nums">
        {elapsed}s
        {tokens > 0 && <> · {t("chat.workTokens", { tokens: formatTokens(tokens) })}</>}
      </span>
    </div>
  );
}

function MessageBubble({
  message, t, locale, linkHandlers, blocked, onConfirmGroup, onDiscardGroup,
}: {
  message: RenderedMessage;
  t: (k: any, vars?: Record<string, string | number>) => string;
  locale: string;
  linkHandlers: ChatLinkHandlers;
  blocked: boolean;
  onConfirmGroup: (g: ProposalGroup) => void;
  onDiscardGroup: (g: ProposalGroup) => void;
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
      {/* Empty streaming assistant bubble is suppressed — the
          WorkingLine below the log is the live indicator instead. */}
      {(isUser || message.content) && (
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
          ) : (
            <AssistantMarkdown
              content={message.content}
              linkHandlers={linkHandlers}
            />
          )}
        </div>
      )}
      {/* Completion stamp: duration · tokens · time/date. Assistant
          messages only, once the turn has finished. */}
      {message.meta && (
        <div className="text-[10px] opacity-40 mt-0.5 tabular-nums">
          {formatDuration(message.meta.durationMs)}
          {" · "}{t("chat.workTokens", { tokens: formatTokens(message.meta.tokens) })}
          {" · "}{formatStamp(message.meta.at, locale)}
        </div>
      )}
      {(message.proposalGroups ?? []).map((g) => (
        <ProposalCard
          key={g.groupId}
          group={g}
          blocked={blocked && g.state === "pending"}
          onConfirm={() => onConfirmGroup(g)}
          onDiscard={() => onDiscardGroup(g)}
        />
      ))}
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
    case "propose_case_patch": return "propose_case_patch";
    case "propose_chatter_post": return "propose_chatter_post";
    case "propose_chatter_edit": return "propose_chatter_edit";
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
