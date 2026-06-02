import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DonutCard, formatRuntime } from "./DonutCard";
import type { StatusBucket } from "../types";

const buckets: StatusBucket[] = [
  {
    status: "New",
    count: 12,
    color: "#60A5FA",
    prioBreakdown: { Sev0: 1, Sev1: 4, Sev2: 5, Sev3: 2, Sev4: 0, Sev5: 0 },
    totalRuntimeSeconds: 432000,
  },
  {
    status: "In Progress",
    count: 24,
    color: "#A78BFA",
    prioBreakdown: { Sev0: 3, Sev1: 8, Sev2: 10, Sev3: 3, Sev4: 0, Sev5: 0 },
    totalRuntimeSeconds: 1234567,
  },
];

describe("formatRuntime", () => {
  it("formats seconds into d/h", () => {
    expect(formatRuntime(86400)).toBe("1d 0h");
    expect(formatRuntime(86400 + 3600 * 6)).toBe("1d 6h");
    expect(formatRuntime(3600 * 5)).toBe("0d 5h");
  });
});

describe("DonutCard", () => {
  it("renders total in center", () => {
    render(<DonutCard buckets={buckets} onSegmentClick={() => {}} />);
    expect(screen.getByText("36")).toBeInTheDocument();
    expect(screen.getByText(/ACTIVE/)).toBeInTheDocument();
  });

  it("renders count strip in bucket colors", () => {
    render(<DonutCard buckets={buckets} onSegmentClick={() => {}} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
  });

  it("renders RTS-heute pill when prop provided", () => {
    render(
      <DonutCard
        buckets={buckets}
        onSegmentClick={() => {}}
        returnToServiceToday={3}
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/RTS today/)).toBeInTheDocument();
  });
});
