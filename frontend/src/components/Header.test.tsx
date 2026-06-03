import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header, ALL_LOCATIONS } from "./Header";

const allSelected = new Set<string>(ALL_LOCATIONS);

describe("Header", () => {
  it("renders title and dc names", () => {
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={allSelected}
        onToggleLocation={() => {}}
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
      />,
    );
    expect(screen.getByRole("button", { name: /switch to (light|dark) theme/i })).toBeInTheDocument();
  });

  it("calls onToggleLocation when an FRA pill is clicked", () => {
    const onToggleLocation = vi.fn();
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={allSelected}
        onToggleLocation={onToggleLocation}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /FRA2/ }));
    expect(onToggleLocation).toHaveBeenCalledWith("FRA2");
  });

  it("marks inactive FRA pills with aria-pressed=false", () => {
    render(
      <Header
        onRefresh={() => {}}
        selectedLocations={new Set(["FRA3"])}
        onToggleLocation={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /FRA1/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /FRA3/ })).toHaveAttribute("aria-pressed", "true");
  });
});
