import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DetailsTable } from "./DetailsTable";
import type { RmaTicket } from "../types";

const tickets: RmaTicket[] = [
  {
    id: "a0a1", name: "W-12345", location: "FRA2", priority: "Sev0",
    status: "In Progress", componentType: "Disk",
    createdDate: "2026-05-14T08:00:00Z", assignee: "@nelamin",
    assetName: "", assetLocationPath: "", assetType: "", description: "", coolanLinks: [],
    gusUrl: "https://gus.lightning.force.com/lightning/r/ADM_Work__c/a0a1/view",
  },
];

describe("DetailsTable", () => {
  it("renders ticket rows with the GUS link", () => {
    render(<DetailsTable status="In Progress" tickets={tickets} onClose={() => {}} onOpenText={() => {}} onOpenCoolan={() => {}} onOpenTicket={() => {}} />);
    expect(screen.getByText("W-12345")).toBeInTheDocument();
    expect(screen.getByText("Sev0")).toBeInTheDocument();
    expect(screen.getByText("FRA2")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open in gus/i });
    expect(link).toHaveAttribute("href", tickets[0].gusUrl);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<DetailsTable status="In Progress" tickets={tickets} onClose={onClose} onOpenText={() => {}} onOpenCoolan={() => {}} onOpenTicket={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("displays the count in the heading", () => {
    render(<DetailsTable status="In Progress" tickets={tickets} onClose={() => {}} onOpenText={() => {}} onOpenCoolan={() => {}} onOpenTicket={() => {}} />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveTextContent("In Progress");
    expect(heading).toHaveTextContent("(1)");
  });
});
