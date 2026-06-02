import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchActive, fetchDetails, fetchActivity, refresh } from "./api";

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
