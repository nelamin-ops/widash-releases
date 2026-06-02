import { useState } from "react";
import { useLanguage } from "../hooks/useLanguage";

interface AuthBannerProps {
  onRetry: () => void | Promise<void>;
}

const SF_LOGIN_CMD = "sf org login web";

export function AuthBanner({ onRetry }: AuthBannerProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SF_LOGIN_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* user denied clipboard */
    }
  }

  async function retry() {
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  }

  return (
    <div className="solid-panel p-5 mb-6 border-l-4 border-amber-500">
      <div className="flex items-start gap-4">
        <span aria-hidden className="text-2xl mt-0.5">⚠</span>
        <div className="flex-1">
          <h2 className="text-base font-medium mb-1">
            {t("auth.bannerTitle")}
          </h2>
          <p className="text-sm opacity-80 mb-3">
            {t("auth.bannerBody")}
          </p>
          <div className="flex items-center gap-2 mb-3">
            <code className="font-mono text-xs surface-1 px-2 py-1.5 rounded-md flex-1 break-all">
              {SF_LOGIN_CMD}
            </code>
            <button
              type="button"
              onClick={copy}
              className="pill surface-1 surface-1-hover text-xs whitespace-nowrap"
            >
              {copied ? t("auth.copied") : t("auth.copy")}
            </button>
          </div>
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className="pill bg-sky-500/25 text-sky-700 dark:text-sky-100 hover:bg-sky-500/35 disabled:opacity-50"
          >
            {retrying ? t("common.loading") : t("auth.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
