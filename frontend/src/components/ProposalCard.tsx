import { useLanguage } from "../hooks/useLanguage";
import type { ProposalPayload } from "../api";

export type ProposalLineState =
  "pending" | "applied" | "discarded" | "failed";

export type ProposalCardState =
  "pending" | "confirming" | "applied" | "discarded" | "failed";

interface ProposalLine {
  proposal: ProposalPayload;
  state: ProposalLineState;
  errorMessage?: string | null;
}

interface ProposalGroupLike {
  groupId: string;
  toolName: "propose_case_patch" | "propose_chatter_post" | "propose_chatter_edit";
  state: ProposalCardState;
  lines: ProposalLine[];
  errorMessage?: string | null;
}

interface Props {
  group: ProposalGroupLike;
  blocked: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}

function formatValue(v: unknown, display: string | null | undefined): string {
  if (display !== null && display !== undefined && display !== "") return display;
  if (v === null || v === undefined || v === "") return "—";
  if (v === true) return "✓";
  if (v === false) return "—";
  return String(v);
}

function caseNumberOf(p: ProposalPayload): string {
  if (p.kind2 === "case_patch_proposal" || p.kind2 === "chatter_post_proposal") {
    return p.caseNumber;
  }
  return p.caseNumber ?? p.entryId.slice(0, 8);
}

function lineGlyph(state: ProposalLineState): string {
  if (state === "applied") return "✓";
  if (state === "failed") return "✗";
  if (state === "discarded") return "—";
  return "·";
}

export function ProposalCard({ group, blocked, onConfirm, onDiscard }: Props) {
  const { t } = useLanguage();

  const headerKey =
    group.toolName === "propose_case_patch" ? "chat.proposal.headerCasePatchBatch"
    : group.toolName === "propose_chatter_post" ? "chat.proposal.headerChatterPostBatch"
    : "chat.proposal.headerChatterEditBatch";
  const showButtons = group.state === "pending" || group.state === "failed";

  // Compute the union of all changed fields, so we can show one column
  // per field (case_patch only).
  const fieldColumns: string[] = (() => {
    if (group.toolName !== "propose_case_patch") return [];
    const seen = new Set<string>();
    const order: string[] = [];
    for (const line of group.lines) {
      const p = line.proposal as Extract<ProposalPayload, { kind2: "case_patch_proposal" }>;
      for (const c of p.changes) {
        const key = `${c.sobject}:${c.apiName}`;
        if (!seen.has(key)) {
          seen.add(key);
          order.push(key);
        }
      }
    }
    return order;
  })();

  function fieldLabel(key: string): string {
    for (const line of group.lines) {
      const p = line.proposal as Extract<ProposalPayload, { kind2: "case_patch_proposal" }>;
      const hit = p.changes.find((c) => `${c.sobject}:${c.apiName}` === key);
      if (hit) return hit.label;
    }
    return key;
  }

  return (
    <div className="surface-2 rounded-lg p-3 my-2 border border-sky-500/30 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-xs uppercase tracking-wider opacity-80">
          {t(headerKey as any, { count: group.lines.length })}
        </div>
      </div>

      {group.toolName === "propose_case_patch" && (
        <table className="w-full text-xs my-2">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1">Case</th>
              {fieldColumns.map((key) => (
                <th key={key} className="py-1">{fieldLabel(key)}</th>
              ))}
              <th className="py-1 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((line, i) => {
              const p = line.proposal as Extract<ProposalPayload, { kind2: "case_patch_proposal" }>;
              return (
                <tr key={i} className="border-t divider-t">
                  <td className="py-1 font-mono opacity-80">{caseNumberOf(line.proposal)}</td>
                  {fieldColumns.map((key) => {
                    const c = p.changes.find((x) => `${x.sobject}:${x.apiName}` === key);
                    if (!c) return <td key={key} className="py-1 opacity-40">—</td>;
                    return (
                      <td key={key} className="py-1 break-words">
                        <span className="opacity-60">{formatValue(c.oldValue, c.oldDisplay)}</span>
                        <span className="mx-1 opacity-50">→</span>
                        <span className="text-emerald-700 dark:text-emerald-300">
                          {formatValue(c.newValue, c.newDisplay)}
                        </span>
                      </td>
                    );
                  })}
                  <td
                    className="py-1 text-center"
                    title={line.errorMessage ?? undefined}
                  >
                    {lineGlyph(line.state)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {group.toolName === "propose_chatter_post" && (
        <table className="w-full text-xs my-2">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1 w-24">Case</th>
              <th className="py-1">Body</th>
              <th className="py-1 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((line, i) => {
              const p = line.proposal as Extract<ProposalPayload, { kind2: "chatter_post_proposal" }>;
              return (
                <tr key={i} className="border-t divider-t">
                  <td className="py-1 font-mono opacity-80">{p.caseNumber}</td>
                  <td className="py-1 break-words whitespace-pre-wrap">
                    {p.mentions && p.mentions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {p.mentions.map((m) => (
                          <span key={m.userId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-200">
                            @{m.displayName}
                          </span>
                        ))}
                      </div>
                    )}
                    {p.body}
                  </td>
                  <td className="py-1 text-center" title={line.errorMessage ?? undefined}>
                    {lineGlyph(line.state)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {group.toolName === "propose_chatter_edit" && (
        <table className="w-full text-xs my-2">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1 w-24">Case</th>
              <th className="py-1 w-1/2">Vorher</th>
              <th className="py-1">Nachher</th>
              <th className="py-1 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((line, i) => {
              const p = line.proposal as Extract<ProposalPayload, { kind2: "chatter_edit_proposal" }>;
              return (
                <tr key={i} className="border-t divider-t">
                  <td className="py-1 font-mono opacity-80">{p.caseNumber ?? p.entryId.slice(0, 8)}</td>
                  <td className="py-1 opacity-70 break-words whitespace-pre-wrap">{p.oldBody}</td>
                  <td className="py-1 break-words whitespace-pre-wrap">
                    <span className="text-emerald-700 dark:text-emerald-300">{p.newBody}</span>
                  </td>
                  <td className="py-1 text-center" title={line.errorMessage ?? undefined}>
                    {lineGlyph(line.state)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {group.state === "applied" && (
        <div className="text-xs text-emerald-700 dark:text-emerald-300 mt-2">
          {t("chat.proposal.stateApplied")}
        </div>
      )}
      {group.state === "discarded" && (
        <div className="text-xs opacity-60 mt-2">{t("chat.proposal.stateDiscarded")}</div>
      )}
      {group.state === "failed" && (
        <div className="text-xs text-rose-700 dark:text-rose-300 mt-2 break-words">
          {t("chat.proposal.stateFailed")}
          {group.errorMessage ? `: ${group.errorMessage}` : ""}
        </div>
      )}
      {group.state === "confirming" && (
        <div className="text-xs opacity-70 mt-2">{t("chat.proposal.stateConfirming")}</div>
      )}

      {showButtons && (
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={onDiscard}
            disabled={blocked}
            className="surface-1 surface-1-hover px-3 py-1 text-xs rounded cursor-pointer disabled:opacity-50"
          >
            {t("chat.proposal.discardAll")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={blocked}
            className="bg-sky-600 hover:bg-sky-500 text-white px-3 py-1 text-xs rounded cursor-pointer disabled:opacity-50"
            title={blocked ? t("chat.proposal.singleConfirmHint") : undefined}
          >
            {group.state === "failed"
              ? t("chat.proposal.retry")
              : t("chat.proposal.confirmAll")}
          </button>
        </div>
      )}
    </div>
  );
}
