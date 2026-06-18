import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { IconButton } from "./IconButton";
import { useLanguage } from "../hooks/useLanguage";
import { streamChat, type ChatMessage } from "../api";

const ALLOWED_MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;
type Model = (typeof ALLOWED_MODELS)[number];

const SIDEBAR_WIDTH = 420;
const STORAGE_KEY = "widash.chat.model";

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

/** Floating chat sidebar — pill bottom-right opens an overlay panel.
 *  Read-only assistant. No data persists across reloads. */
export function ChatSidebar() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<Model>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY) as Model | null;
      if (v && ALLOWED_MODELS.includes(v)) return v;
    } catch { /* ignore */ }
    return "claude-sonnet-4-6";
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, model); } catch { /* ignore */ }
  }, [model]);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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

  function handleClear() {
    if (busy) abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    setDraft("");

    const userMsg: RenderedMessage = { role: "user", content: text };
    const assistantMsg: RenderedMessage = {
      role: "assistant", content: "", streaming: true, tools: [],
    };
    const baseHistory: ChatMessage[] = [
      ...messages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: text },
    ];
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      for await (const ev of streamChat(
        { messages: baseHistory, model },
        ctrl.signal,
      )) {
        if (ev.kind === "delta") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last, content: last.content + ev.text,
              };
            }
            return next;
          });
        } else if (ev.kind === "tool") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                tools: [
                  ...(last.tools ?? []),
                  { name: ev.name, status: ev.status, ts: Date.now() },
                ],
              };
            }
            return next;
          });
        } else if (ev.kind === "done") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });
        } else if (ev.kind === "error") {
          setError(ev.message || "error");
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && !last.content) {
              // Drop the empty assistant placeholder; the error is shown
              // in the banner instead of an empty bubble.
              next.pop();
            } else if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message ?? "stream_failed");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <>
      {/* Floating launcher pill — bottom-right, hidden while sidebar open. */}
      {!open && (
        <button
          type="button"
          aria-label={t("chat.open")}
          title={t("chat.open")}
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-44 solid-panel surface-1-hover px-4 py-3 text-sm flex items-center gap-2 cursor-pointer"
          style={{ zIndex: 1900 }}
        >
          <ChatGlyph />
          <span className="font-medium">{t("chat.launcherLabel")}</span>
        </button>
      )}

      <AnimatePresence>
        {open && (
          <>
            {/* Dim the dashboard slightly so focus moves to the sidebar. */}
            <motion.div
              key="chat-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 bg-black/20 dark:bg-black/40"
              style={{ zIndex: 1950 }}
            />
            <motion.aside
              key="chat-panel"
              initial={{ x: SIDEBAR_WIDTH }}
              animate={{ x: 0 }}
              exit={{ x: SIDEBAR_WIDTH }}
              transition={{ type: "tween", duration: 0.22 }}
              className="solid-panel fixed top-0 right-0 h-screen flex flex-col"
              style={{ width: SIDEBAR_WIDTH, zIndex: 2000 }}
              role="dialog"
              aria-label={t("chat.title")}
            >
              {/* Header */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 divider-b">
                <div className="flex items-center gap-2 min-w-0">
                  <ChatGlyph />
                  <h2 className="text-sm font-medium truncate">
                    {t("chat.title")}
                  </h2>
                </div>
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
                    aria-label={t("common.close")}
                    title={t("common.close")}
                    onClick={() => setOpen(false)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"
                      fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden focusable="false">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </IconButton>
                </div>
              </div>

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
                  <MessageBubble key={i} message={m} t={t} />
                ))}
                {error && (
                  <div className="px-3 py-2 rounded text-xs border border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10">
                    {error}
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
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs opacity-50">
                    {t("chat.enterHint")}
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
                      onClick={handleSend}
                      disabled={!draft.trim()}
                      className="px-3 py-1 text-xs rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {t("chat.send")}
                    </button>
                  )}
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function MessageBubble({
  message, t,
}: { message: RenderedMessage; t: (k: any) => string }) {
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
          "px-3 py-2 rounded-lg max-w-[90%] whitespace-pre-wrap break-words " +
          (isUser
            ? "bg-sky-600 text-white"
            : "surface-1 text-current")
        }
      >
        {message.content || (message.streaming ? "…" : "")}
      </div>
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
