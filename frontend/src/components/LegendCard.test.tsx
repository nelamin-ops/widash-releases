import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LegendCard } from "./LegendCard";
import type { MyRtsTicket, StatusBucket } from "../types";

const buckets: StatusBucket[] = [
  { status: "New", count: 12, color: "#60A5FA",
    prioBreakdown: { Sev0: 0, Sev1: 0, Sev2: 0, Sev3: 0, Sev4: 0, Sev5: 0 }, totalRuntimeSeconds: 0 },
  { status: "Escalated", count: 3, color: "#F87171",
    prioBreakdown: { Sev0: 0, Sev1: 0, Sev2: 0, Sev3: 0, Sev4: 0, Sev5: 0 }, totalRuntimeSeconds: 0 },
];

const myRts: MyRtsTicket[] = [
  {
    id: "500X1", name: "90528893", location: "FRA3",
    subject: "DNR: POD332 blade4-0", setAt: "2026-05-19T16:04:59Z",
    gusUrl: "https://gus.lightning.force.com/lightning/r/Case/500X1/view",
  },
];

describe("LegendCard", () => {
  it("lists all buckets with their counts", () => {
    render(<LegendCard buckets={buckets} />);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Escalated")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders today, my-open count, and closed-total rows when provided", () => {
    render(
      <LegendCard
        buckets={buckets}
        returnToServiceToday={6}
        myRtsOpen={myRts}
        myRtsClosedTotal={26}
      />,
    );
    expect(screen.getByText(/today/)).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText(/Still open by me/)).toBeInTheDocument();
    expect(screen.getByText(/Already closed/)).toBeInTheDocument();
    expect(screen.getByText("26")).toBeInTheDocument();
    // Open-tickets table is collapsed by default.
    expect(screen.queryByText("90528893")).not.toBeInTheDocument();
  });

  it("expands the open-tickets table when the row is clicked", () => {
    render(
      <LegendCard
        buckets={buckets}
        returnToServiceToday={6}
        myRtsOpen={myRts}
        myRtsClosedTotal={26}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Still open by me/ }));
    expect(screen.getByText("90528893")).toBeInTheDocument();
    expect(screen.getByText(/POD332 blade4-0/)).toBeInTheDocument();
  });

  it("does not render the RTS block when no RTS props are passed", () => {
    render(<LegendCard buckets={buckets} />);
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Already closed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Still open by me/)).not.toBeInTheDocument();
  });
});
