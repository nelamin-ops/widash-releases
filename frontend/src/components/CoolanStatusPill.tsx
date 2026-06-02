import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../hooks/useLanguage";

interface CoolanStatus {
  connected: boolean;
  savedAt: string | null;
  note: string;
  lastError: string | null;
}

async function fetchStatus(): Promise<CoolanStatus> {
  const r = await fetch("/api/coolan/status");
  return r.json();
}

async function postAuth(payload: { token?: string; cookie?: string; note?: string }): Promise<CoolanStatus> {
  const r = await fetch("/api/coolan/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function clearAuth(): Promise<void> {
  await fetch("/api/coolan/auth", { method: "DELETE" });
}

interface AutoResponse {
  connected?: boolean;
  needsInteraction?: boolean;
  message?: string;
  lastError?: string | null;
}

async function postAuto(headless: boolean): Promise<AutoResponse> {
  const r = await fetch(`/api/coolan/auto?headless=${headless}`, {
    method: "POST",
  });
  return r.json();
}

export function CoolanStatusPill() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<CoolanStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoMessage, setAutoMessage] = useState<string | null>(null);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function refresh() {
    const s = await fetchStatus();
    setStatus(s);
  }

  async function handleSave() {
    if (!token.trim() && !cookie.trim()) return;
    setBusy(true);
    try {
      const s = await postAuth({ token: token.trim(), cookie: cookie.trim() });
      setStatus(s);
      if (s.connected) {
        setOpen(false);
        setToken("");
        setCookie("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleAuto(headless: boolean) {
    setBusy(true);
    setAutoMessage(null);
    try {
      const r = await postAuto(headless);
      if (r.connected) {
        setStatus({
          connected: true,
          savedAt: null, note: "", lastError: null,
        });
        setOpen(false);
        setNeedsInteraction(false);
      } else {
        setNeedsInteraction(!!r.needsInteraction);
        setAutoMessage(r.message ?? "Auto-connect failed");
        // Pull a fresh status so the modal reflects whatever was saved.
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    try {
      await clearAuth();
      await refresh();
      setToken("");
      setCookie("");
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.connected;
  const dotColor = connected ? "#34D399" : "#F87171";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          connected
            ? t("coolan.connected")
            : (status?.lastError ?? t("coolan.disconnected"))
        }
        className="pill surface-1 surface-1-hover flex items-center gap-1.5 text-xs"
      >
        <span aria-hidden style={{ color: dotColor }}>❄</span>
        <span aria-hidden
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        <span>{connected ? "Coolan" : t("coolan.connect")}</span>
      </button>

      {open && createPortal(
        <div
          role="dialog"
          aria-label={t("coolan.modalTitle")}
          className="fixed inset-0 flex items-start justify-center pt-20 px-4"
          style={{ zIndex: 2500, background: "rgba(0,0,0,0.45)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="solid-panel p-5 w-full max-w-xl">
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-medium">{t("coolan.modalTitle")}</h2>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
                className="pill surface-1-hover"
              >✕</button>
            </div>

            <div className="mb-4 p-3 rounded-md surface-1">
              <h3 className="text-sm font-medium mb-1">
                {t("coolan.autoTitle")}
              </h3>
              <p className="text-xs opacity-70 mb-3">
                {needsInteraction
                  ? t("coolan.autoNeedsInteraction")
                  : t("coolan.autoIntro")}
              </p>
              <div className="flex gap-2 flex-wrap">
                {!needsInteraction && (
                  <button
                    type="button"
                    onClick={() => handleAuto(true)}
                    disabled={busy}
                    className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-50"
                  >
                    {busy ? t("common.loading") : t("coolan.autoTryHeadless")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleAuto(false)}
                  disabled={busy}
                  className={`pill text-sm ${
                    needsInteraction
                      ? "bg-amber-500/25 text-amber-800 dark:text-amber-100 hover:bg-amber-500/35"
                      : "surface-1 surface-1-hover"
                  } disabled:opacity-50`}
                >
                  {busy ? t("common.loading") : t("coolan.autoOpenBrowser")}
                </button>
              </div>
              {autoMessage && (
                <div className="text-xs mt-2 opacity-80 break-all">
                  {autoMessage}
                </div>
              )}
            </div>

            <details className="mb-3 text-sm opacity-80">
              <summary className="cursor-pointer">
                {t("coolan.manualToggle")}
              </summary>
              <p className="text-xs opacity-80 mt-2">{t("coolan.intro")}</p>
              <ol className="text-xs opacity-80 list-decimal pl-5 space-y-1 mt-2">
                <li>{t("coolan.stepOpen")}</li>
                <li>{t("coolan.stepDevtools")}</li>
                <li>{t("coolan.stepPaste")}</li>
              </ol>
            </details>

            <label className="block text-xs uppercase tracking-wide opacity-60 mb-1">
              {t("coolan.tokenLabel")}
            </label>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={2}
              placeholder="Bearer eyJ…"
              className="w-full text-xs font-mono p-2 rounded-md surface-1 mb-3"
              style={{ resize: "vertical" }}
            />

            <label className="block text-xs uppercase tracking-wide opacity-60 mb-1">
              {t("coolan.cookieLabel")}
            </label>
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              rows={2}
              placeholder="optional, e.g. session=…"
              className="w-full text-xs font-mono p-2 rounded-md surface-1 mb-3"
              style={{ resize: "vertical" }}
            />

            {status && !status.connected && status.lastError && (
              <div className="text-xs text-red-700 dark:text-red-300 mb-3 break-all">
                {status.lastError}
              </div>
            )}

            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={handleClear}
                disabled={busy || !status?.savedAt}
                className="pill surface-1 surface-1-hover text-xs disabled:opacity-30"
              >
                {t("coolan.clear")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || (!token.trim() && !cookie.trim())}
                className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30"
              >
                {busy ? t("common.loading") : t("coolan.save")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
