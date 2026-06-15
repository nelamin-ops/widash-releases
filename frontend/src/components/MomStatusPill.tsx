import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../hooks/useLanguage";

interface MomStatus {
  connected: boolean;
  savedAt: string | null;
  note: string;
  lastError: string | null;
}

async function fetchStatus(): Promise<MomStatus> {
  const r = await fetch("/api/mom/status");
  return r.json();
}

async function postAuth(payload: { cookie: string; note?: string }): Promise<MomStatus> {
  const r = await fetch("/api/mom/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function clearAuth(): Promise<void> {
  await fetch("/api/mom/auth", { method: "DELETE" });
}

export function MomStatusPill() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<MomStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function refresh() {
    const s = await fetchStatus();
    setStatus(s);
  }

  async function handleSave() {
    if (!cookie.trim()) return;
    setBusy(true);
    try {
      const s = await postAuth({ cookie: cookie.trim() });
      setStatus(s);
      if (s.connected) {
        setOpen(false);
        setCookie("");
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
            ? t("mom.connected")
            : (status?.lastError ?? t("mom.disconnected"))
        }
        className="pill surface-1 surface-1-hover flex items-center gap-1.5 text-xs"
      >
        <span aria-hidden style={{ color: dotColor }}>🌡</span>
        <span aria-hidden
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        <span>{connected ? "MOM" : t("mom.connect")}</span>
      </button>

      {open && createPortal(
        <div
          role="dialog"
          aria-label={t("mom.modalTitle")}
          className="fixed inset-0 flex items-start justify-center pt-20 px-4"
          style={{ zIndex: 2500, background: "rgba(0,0,0,0.45)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="solid-panel p-5 w-full max-w-xl">
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-medium">{t("mom.modalTitle")}</h2>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
                className="pill surface-1-hover"
              >✕</button>
            </div>

            <p className="text-xs opacity-80 mb-3">{t("mom.intro")}</p>
            <ol className="text-xs opacity-80 list-decimal pl-5 space-y-1 mb-3">
              <li>{t("mom.stepOpen")}</li>
              <li>{t("mom.stepDevtools")}</li>
              <li>{t("mom.stepPaste")}</li>
            </ol>

            <label className="block text-xs uppercase tracking-wide opacity-60 mb-1">
              {t("mom.cookieLabel")}
            </label>
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              rows={4}
              placeholder="ring-session=…; sfdc_lv2=…; …"
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
                {t("mom.clear")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !cookie.trim()}
                className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-30"
              >
                {busy ? t("common.loading") : t("mom.save")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
