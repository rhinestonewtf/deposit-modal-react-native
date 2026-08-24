/**
 * Origin comparison, done by parsing rather than by prefix.
 *
 * The web view is pinned to our origin because a document loaded beside the
 * bridge gets the main-frame injection, and with it the nonce that gates wallet
 * traffic. A `startsWith` check does not express that:
 * `https://deposit.rhinestone.dev.evil.example` and
 * `https://deposit.rhinestone.dev@evil.example` both pass one and neither is
 * our origin.
 *
 * `URL` is not used. React Native's implementation is a partial polyfill whose
 * `origin` and `hostname` are unreliable across versions, and a pin that
 * silently degrades on some engine is worse than one written out.
 */

/**
 * The authority of an `https:` URL, lowercased, or `undefined` for anything
 * this must not treat as ours.
 *
 * Userinfo is rejected outright rather than parsed past: the real host of
 * `https://a@b/` is `b`, we never mint such a URL, and refusing is both safer
 * and shorter than being right about it. `\` goes with it — engines have
 * historically read it as `/` while a naive parser does not.
 */
export function parseHttpsAuthority(url: string): string | undefined {
  const match = /^https:\/\/([^/?#@\\]+)(?:[/?#]|$)/i.exec(url);
  const authority = match?.[1]?.toLowerCase();
  if (!authority) return undefined;
  // The default port is not part of the identity, and a page that links to
  // itself with one written out is still the same document.
  return authority.endsWith(":443") ? authority.slice(0, -4) : authority;
}

export function isSameOrigin(url: string, origin: string): boolean {
  const target = parseHttpsAuthority(url);
  const expected = parseHttpsAuthority(origin);
  return target !== undefined && target === expected;
}
