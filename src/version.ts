/**
 * The version header, built the way the page builds it.
 *
 * The wrapper makes backend calls of its own — the deposit watch outlives the
 * web view, which is the whole point of it — and those must be attributable to
 * the same pair as the page's calls, or a mobile integration shows up at the
 * processor as two unrelated clients.
 *
 * **A new header would be a breaking change for a self-hosted proxy with an
 * explicit CORS allow-list**, so the wrapper's identity rides inside the
 * existing header's value, exactly as `setEmbedHost` does page-side. The page's
 * own version stays first and unchanged, so anything reading a leading semver
 * keeps working: `0.13.0 (ios; Acme/2.1.0)`.
 */

/** Written from package.json by `scripts/sync-version.ts` at build. */
export const WRAPPER_VERSION = "0.1.0";

export const VERSION_HEADER = "x-deposit-modal-version";

/**
 * `app` and `version` are the integrator's own strings. A newline in either
 * would be header injection, and `fetch` throws on an invalid header value —
 * which would take out every call rather than mangling one — so both are
 * reduced to a conservative charset and capped.
 */
function clean(value: string | undefined, max: number): string {
  return (value ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, max);
}

export function formatVersionHeader(
  modalVersion: string,
  host: { platform: string; app?: string; version?: string },
): string {
  const base = clean(modalVersion, 40) || WRAPPER_VERSION;
  const platform = clean(host.platform, 16) || "unknown";
  const app = clean(host.app, 32);
  const version = clean(host.version, 24);
  const named = app ? (version ? `${app}/${version}` : app) : "";
  return named ? `${base} (${platform}; ${named})` : `${base} (${platform})`;
}
