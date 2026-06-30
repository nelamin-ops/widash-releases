import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CaseDetailSheet } from "./CaseDetailSheet";
import type { RmaTicket } from "../types";

// The sheet fetches its own detail / feed / coolan / patchplan on mount.
// Stub those so the test only exercises the synchronous first render —
// which is where the white-screen bug lived.
vi.mock("../api", () => ({
  fetchCaseDetail: vi.fn().mockResolvedValue({
    caseId: "x", caseNumber: "90524212", sections: [],
  }),
  fetchCaseFeed: vi.fn().mockResolvedValue({ entries: [] }),
  fetchCoolanComponents: vi.fn().mockResolvedValue({
    machineUuid: "", components: [],
  }),
  fetchPatchplanCables: vi.fn().mockResolvedValue({
    cables: [], totalIndexed: 0,
  }),
  refreshPatchplan: vi.fn().mockResolvedValue(undefined),
  patchCase: vi.fn(),
  patchAsset: vi.fn(),
  patchChatterEntry: vi.fn(),
  postCaseComment: vi.fn(),
  searchLookup: vi.fn().mockResolvedValue({ results: [] }),
}));

const noop = () => {};
const sheetProps = {
  heightVh: 50,
  tabsPinned: false,
  onClose: noop,
  onMinimize: noop,
  onResize: noop,
  onToggleTabsPinned: noop,
  onOpenCoolan: noop,
};

describe("CaseDetailSheet — opening a lookup hit", () => {
  it("renders a lookup-shaped ticket (only id/name/status) without white-screening", async () => {
    // openCaseFromLookup builds the ticket from a backend lookup hit that
    // carries only id / caseNumber / status — every other RmaTicket field
    // is absent. Before the fix the first render dereferenced
    // ticket.assetName.split() and ticket.coolanLinks.length, threw, and
    // (with no error boundary) unmounted the whole app. This is the exact
    // repro Najih hit clicking an RTS case from the search box.
    const ticket = {
      id: "500AbCdEf",
      name: "90524212",
      status: "Return to Service",
    } as unknown as RmaTicket;

    expect(() =>
      render(<CaseDetailSheet ticket={ticket} {...sheetProps} />),
    ).not.toThrow();
    expect(
      screen.getByRole("heading", { name: "90524212" }),
    ).toBeInTheDocument();
    // Let the on-mount fetches settle so their state updates don't fire
    // outside act() (keeps the test output clean — no behaviour change).
    await waitFor(() =>
      expect(screen.getByText(/live/i)).toBeInTheDocument(),
    );
  });
});
