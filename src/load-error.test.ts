/**
 * The message an integrator gets when the page will not load.
 *
 * It was a bare "The deposit page could not be loaded." until an Android run hit
 * exactly that and the sentence said nothing: a DNS failure, a TLS failure, an
 * offline device and a proxy refusing the origin all arrive here identically,
 * and `onFatal` is the integrator's only instrument.
 */
import { describe, expect, it } from "vitest";

import { webViewLoadError } from "./load-error";

describe("a web view load failure", () => {
  it("carries the platform's description", () => {
    const error = webViewLoadError({
      nativeEvent: { description: "net::ERR_NAME_NOT_RESOLVED" },
    });
    expect(error.message).toContain("net::ERR_NAME_NOT_RESOLVED");
  });

  it("carries Android's numeric code alongside it", () => {
    const error = webViewLoadError({
      nativeEvent: { description: "net::ERR_NAME_NOT_RESOLVED", code: -2 },
    });
    expect(error.message).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(error.message).toContain("code -2");
  });

  it("still reads as a sentence when the platform said nothing", () => {
    // A message ending in " ()" is worse than the plain one.
    expect(webViewLoadError({}).message).toBe(
      "The deposit page could not be loaded.",
    );
    expect(webViewLoadError({ nativeEvent: { description: "   " } }).message).toBe(
      "The deposit page could not be loaded.",
    );
    expect(webViewLoadError(undefined).message).toBe(
      "The deposit page could not be loaded.",
    );
  });
});
