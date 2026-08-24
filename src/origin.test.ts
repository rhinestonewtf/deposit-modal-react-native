import { describe, expect, it } from "vitest";

import { isSameOrigin, parseHttpsAuthority } from "./origin";

const ORIGIN = "https://deposit.rhinestone.dev";

describe("pinning the web view to our origin", () => {
  it("accepts the page itself", () => {
    expect(isSameOrigin(ORIGIN, ORIGIN)).toBe(true);
    expect(isSameOrigin(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isSameOrigin(`${ORIGIN}/assets/index-abc.js`, ORIGIN)).toBe(true);
    expect(isSameOrigin(`${ORIGIN}/?mode=deposit#step`, ORIGIN)).toBe(true);
    expect(isSameOrigin("https://DEPOSIT.RHINESTONE.DEV/", ORIGIN)).toBe(true);
    expect(isSameOrigin(`${ORIGIN}:443/`, ORIGIN)).toBe(true);
  });

  it("refuses a host that merely starts with ours", () => {
    expect(isSameOrigin("https://deposit.rhinestone.dev.evil.example/", ORIGIN)).toBe(
      false,
    );
    expect(isSameOrigin("https://deposit.rhinestone.deveil/", ORIGIN)).toBe(false);
  });

  it("refuses userinfo, whoever it names", () => {
    expect(isSameOrigin("https://deposit.rhinestone.dev@evil.example/", ORIGIN)).toBe(
      false,
    );
    expect(
      isSameOrigin("https://deposit.rhinestone.dev:x@evil.example/", ORIGIN),
    ).toBe(false);
  });

  it("refuses a backslash where an engine might read a slash", () => {
    expect(isSameOrigin("https://deposit.rhinestone.dev\\@evil.example/", ORIGIN)).toBe(
      false,
    );
  });

  it("refuses another port, and another scheme", () => {
    expect(isSameOrigin(`${ORIGIN}:8443/`, ORIGIN)).toBe(false);
    expect(isSameOrigin("http://deposit.rhinestone.dev/", ORIGIN)).toBe(false);
    expect(isSameOrigin("javascript:alert(1)", ORIGIN)).toBe(false);
    expect(isSameOrigin("intent://deposit.rhinestone.dev", ORIGIN)).toBe(false);
    expect(isSameOrigin("about:blank", ORIGIN)).toBe(false);
  });

  it("parses nothing out of what is not an https URL", () => {
    expect(parseHttpsAuthority("")).toBeUndefined();
    expect(parseHttpsAuthority("https://")).toBeUndefined();
    expect(parseHttpsAuthority("//deposit.rhinestone.dev")).toBeUndefined();
  });
});
