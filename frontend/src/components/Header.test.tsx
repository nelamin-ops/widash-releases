import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "./Header";

const FRA_SITES = ["FRA1", "FRA2", "FRA3"] as const;
const allSelected = new Set<string>(FRA_SITES);

describe("Header", () => {
  it("renders title and dc names", () => {
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={allSelected}
        onToggleLocation={() => {}}
        sites={FRA_SITES}
      />,
    );
    expect(screen.getByAltText("WiDash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /FRA1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /FRA2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /FRA3/ })).toBeInTheDocument();
  });

  it("calls onRefresh when refresh button clicked", () => {
    const onRefresh = vi.fn();
    render(
      <Header
        onRefresh={onRefresh}
        selectedLocations={allSelected}
        onToggleLocation={() => {}}
        sites={FRA_SITES}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reload data/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("toggle theme button is present", () => {
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={allSelected}
        onToggleLocation={() => {}}
        sites={FRA_SITES}
      />,
    );
    expect(screen.getByRole("button", { name: /switch to (light|dark) theme/i })).toBeInTheDocument();
  });

  it("calls onToggleLocation when a site pill is clicked", () => {
    const onToggleLocation = vi.fn();
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={allSelected}
        onToggleLocation={onToggleLocation}
        sites={FRA_SITES}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /FRA2/ }));
    expect(onToggleLocation).toHaveBeenCalledWith("FRA2");
  });

  it("marks inactive site pills with aria-pressed=false", () => {
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={new Set(["FRA3"])}
        onToggleLocation={() => {}}
        sites={FRA_SITES}
      />,
    );
    expect(screen.getByRole("button", { name: /FRA1/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /FRA3/ })).toHaveAttribute("aria-pressed", "true");
  });
});
