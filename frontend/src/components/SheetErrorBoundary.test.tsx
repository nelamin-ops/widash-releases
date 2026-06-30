import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SheetErrorBoundary } from "./SheetErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("render crash");
}

describe("SheetErrorBoundary", () => {
  it("catches a child render crash and offers a close button instead of unmounting", () => {
    const onClose = vi.fn();
    // React logs the caught error to console.error — silence it so the
    // test output stays clean while still exercising the boundary.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SheetErrorBoundary onClose={onClose}>
        <Boom />
      </SheetErrorBoundary>,
    );

    const closeBtn = screen.getByRole("button", { name: /schließen/i });
    expect(closeBtn).toBeInTheDocument();

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();

    spy.mockRestore();
  });

  it("renders children untouched when they don't crash", () => {
    render(
      <SheetErrorBoundary onClose={() => {}}>
        <div>healthy sheet</div>
      </SheetErrorBoundary>,
    );
    expect(screen.getByText("healthy sheet")).toBeInTheDocument();
  });
});
