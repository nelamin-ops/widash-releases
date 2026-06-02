import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityLog } from "./ActivityLog";
import type { ActivityEvent } from "../types";

const events: ActivityEvent[] = [
  {
    id: "1", ticketId: "W-12345", ticketSfId: "a0a1",
    type: "status_change",
    timestamp: "2026-05-18T14:32:00Z",
    actor: "@nelamin", fromStatus: "Pending Drain", toStatus: "Drained",
    location: "FRA2", caseStatus: "Drained",
  },
  {
    id: "2", ticketId: "W-12340", ticketSfId: "a0a2",
    type: "comment",
    timestamp: "2026-05-18T14:18:00Z",
    actor: "@j.smith", commentText: "Vendor RMA dispatched",
    location: "FRA1", caseStatus: "Drained",
  },
];

const noopProps = {
  onOpenText: () => {},
  includeBots: false,
  onToggleIncludeBots: () => {},
};

describe("ActivityLog", () => {
  it("renders events and filter pills", () => {
    render(
      <ActivityLog
        events={events}
        filter="all"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    expect(screen.getByText(/W-12345/)).toBeInTheDocument();
    expect(screen.getByText(/W-12340/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^status$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^comments$/i })).toBeInTheDocument();
  });

  it("calls onFilterChange when pill clicked", () => {
    const onFilterChange = vi.fn();
    render(
      <ActivityLog
        events={events}
        filter="all"
        onFilterChange={onFilterChange}
        {...noopProps}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^status$/i }));
    expect(onFilterChange).toHaveBeenCalledWith("status_change");
  });

  it("highlights the active filter", () => {
    render(
      <ActivityLog
        events={events}
        filter="comment"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    const commentBtn = screen.getByRole("button", { name: /^comments$/i });
    expect(commentBtn.className).toMatch(/bg-white\/15|active/);
  });

  it("renders status change with from and to", () => {
    render(
      <ActivityLog
        events={[events[0]]}
        filter="all"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    expect(screen.getByText("Pending Drain")).toBeInTheDocument();
    expect(screen.getByText("Drained")).toBeInTheDocument();
  });

  it("renders comment text", () => {
    render(
      <ActivityLog
        events={[events[1]]}
        filter="all"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    expect(screen.getByText(/Vendor RMA dispatched/)).toBeInTheDocument();
  });

  it("calls onOpenText with the comment body when the comment cell is clicked", () => {
    const onOpenText = vi.fn();
    render(
      <ActivityLog
        events={[events[1]]}
        filter="all"
        onFilterChange={() => {}}
        onOpenText={onOpenText}
        includeBots={false}
        onToggleIncludeBots={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/Vendor RMA dispatched/));
    expect(onOpenText).toHaveBeenCalled();
    expect(onOpenText.mock.calls[0][2]).toBe("Vendor RMA dispatched");
  });

  it("filters events by status when a status pill is selected", () => {
    const closedEvent: ActivityEvent = {
      ...events[0], id: "3", ticketId: "W-99999", caseStatus: "Closed",
    };
    render(
      <ActivityLog
        events={[events[0], closedEvent]}
        filter="all"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    // Both rows visible before filtering.
    expect(screen.getByText(/W-12345/)).toBeInTheDocument();
    expect(screen.getByText(/W-99999/)).toBeInTheDocument();
    // Open the status menu and pick Drained.
    fireEvent.click(screen.getByRole("button", { name: /status filter/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Drained$/ }));
    expect(screen.getByText(/W-12345/)).toBeInTheDocument();
    expect(screen.queryByText(/W-99999/)).not.toBeInTheDocument();
  });

  it("comment search hides status_change events and matches body", () => {
    render(
      <ActivityLog
        events={events}
        filter="all"
        onFilterChange={() => {}}
        {...noopProps}
      />,
    );
    const search = screen.getByPlaceholderText(/search comments/i);
    fireEvent.change(search, { target: { value: "vendor" } });
    expect(screen.getByText(/Vendor RMA dispatched/)).toBeInTheDocument();
    // Status-change row should be filtered out.
    expect(screen.queryByText(/W-12345/)).not.toBeInTheDocument();
  });
});
