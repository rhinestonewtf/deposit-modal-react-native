import { describe, it, expect } from "vitest";

import { compareModalVersions, originIsBehind } from "./modal-version";

describe("compareModalVersions", () => {
  it("orders two dev snapshots by their timestamp", () => {
    const older = "0.0.0-dev-20260901105152";
    const newer = "0.0.0-dev-20260901120231";
    expect(compareModalVersions(newer, older)).toBeGreaterThan(0);
    expect(compareModalVersions(older, newer)).toBeLessThan(0);
    expect(compareModalVersions(older, older)).toBe(0);
  });

  it("orders two releases by each part in turn", () => {
    expect(compareModalVersions("1.0.0", "0.14.1")).toBeGreaterThan(0);
    expect(compareModalVersions("0.14.1", "0.9.9")).toBeGreaterThan(0);
    expect(compareModalVersions("0.14.1", "0.14.2")).toBeLessThan(0);
    expect(compareModalVersions("0.14.1", "0.14.1")).toBe(0);
  });

  // The two forms share no scale: a snapshot's leading `0.0.0` would order it
  // below every release, so comparing them at all reports a deployed prod page
  // as ahead of a newer dev one.
  it("refuses to order a snapshot against a release", () => {
    expect(compareModalVersions("0.0.0-dev-20260901120231", "0.14.1")).toBe(
      undefined,
    );
    expect(compareModalVersions("0.14.1", "0.0.0-dev-20260901120231")).toBe(
      undefined,
    );
  });

  it("refuses anything it does not recognise", () => {
    expect(compareModalVersions("0.14.1-rc.1", "0.14.1")).toBe(undefined);
    expect(compareModalVersions("", "0.14.1")).toBe(undefined);
  });
});

describe("originIsBehind", () => {
  it("is true only when the vendored copy is newer", () => {
    const older = "0.0.0-dev-20260901105152";
    const newer = "0.0.0-dev-20260901120231";
    expect(originIsBehind(newer, older)).toBe(true);
    expect(originIsBehind(older, newer)).toBe(false);
    expect(originIsBehind(older, older)).toBe(false);
  });

  // A copy vendored without a version, or an origin serving one, cannot be
  // placed — and the fallback has to be "not a lag", so a real removal is still
  // reported as the break it is.
  it("is false when either side has no version, or they cannot be ordered", () => {
    expect(originIsBehind(undefined, "0.14.1")).toBe(false);
    expect(originIsBehind("0.14.1", undefined)).toBe(false);
    expect(originIsBehind("0.14.1", "0.0.0-dev-20260901120231")).toBe(false);
  });
});
