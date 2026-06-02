import { useEffect, useState } from "react";
import { fetchUpdateInfo, type UpdateInfo } from "../api";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 Stunde

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    function check() {
      fetchUpdateInfo()
        .then((data) => { if (data.update_available) setInfo(data); })
        .catch(() => { /* kein Banner bei Netzwerkfehler */ });
    }
    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!info || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 px-4 py-2 text-sm"
      style={{
        background: "var(--amber-banner, #92400e22)",
        borderBottom: "1px solid #F59E0B44",
        color: "var(--text)",
      }}
    >
      <span aria-hidden className="text-amber-500">⬆</span>
      <span className="flex-1">
        <strong>WiDash v{info.latest}</strong> ist verfügbar
        {" "}(du nutzt v{info.current}) —{" "}
        <code className="text-xs opacity-80">./update.sh</code> ausführen um zu aktualisieren.
      </span>
      <a
        href={info.url}
        target="_blank"
        rel="noreferrer"
        className="pill surface-1 surface-1-hover text-xs"
      >
        Release Notes ↗
      </a>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Banner schließen"
        className="pill surface-1-hover text-xs opacity-70"
      >
        ✕
      </button>
    </div>
  );
}
