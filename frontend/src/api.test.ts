import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchActive, fetchDetails, fetchActivity, refresh } from "./api";
import type { ChatStreamEvent, CasePatchProposal } from "./api";

function lastFetchUrl(): string {
  const calls = (fetch as any).mock.calls as unknown[][];
  return calls[calls.length - 1][0] as string;
}

describe("api", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // Make sure the report-id key doesn't leak between tests via the
    // jsdom localStorage instance.
    try { localStorage.removeItem("widash.reportId"); } catch { /* ignore */ }
  });

  it("fetchActive hits /api/rma/active", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ total: 0, buckets: [], fetchedAt: "2026-05-18T00:00:00Z" }),
    });
    await fetchActive();
    expect(lastFetchUrl()).toBe("/api/rma/active");
  });

  it("fetchDetails encodes status with spaces", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ status: "In Progress", tickets: [] }),
    });
    await fetchDetails("In Progress");
    expect(lastFetchUrl()).toBe("/api/rma/active/In%20Progress");
  });

  it("fetchActivity passes type and limit", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ events: [] }),
    });
    await fetchActivity("comment", 50);
    expect(lastFetchUrl()).toBe("/api/activity?type=comment&limit=50");
  });

  it("refresh POSTs", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ status: "refreshed" }),
    });
    await refresh();
    expect(fetch).toHaveBeenCalledWith("/api/refresh", { method: "POST" });
  });

  it("throws ApiError on 401", async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "auth_expired" }),
    });
    await expect(fetchActive()).rejects.toMatchObject({ error: "auth_expired" });
  });

  it("attaches X-Report-Id header when set in localStorage", async () => {
    localStorage.setItem("widash.reportId", "00OEE000001HkkD2AS");
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ total: 0, buckets: [], fetchedAt: "2026-05-18T00:00:00Z" }),
    });
    await fetchActive();
    const calls = (fetch as any).mock.calls as unknown[][];
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("X-Report-Id")).toBe("00OEE000001HkkD2AS");
  });
});

describe("ChatStreamEvent", () => {
  it("includes a proposal variant with discriminated proposal payload", () => {
    const proposal: CasePatchProposal = {
      kind2: "case_patch_proposal",
      proposalId: "p_abcdef",
      caseId: "500AAA",
      caseNumber: "91886282",
      assetId: null,
      changes: [],
    };
    const ev: ChatStreamEvent = { kind: "proposal", proposal };
    expect(ev.kind).toBe("proposal");
    if (ev.kind === "proposal" && ev.proposal.kind2 === "case_patch_proposal") {
      expect(ev.proposal.caseNumber).toBe("91886282");
    }
  });

  it("includes a live usage variant carrying running token totals", () => {
    const ev: ChatStreamEvent = { kind: "usage", input: 1200, output: 350 };
    expect(ev.kind).toBe("usage");
    if (ev.kind === "usage") {
      expect(ev.input + ev.output).toBe(1550);
    }
  });
});
