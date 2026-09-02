/**
 * The web view's load failure, with what the platform said about it.
 *
 * Without the platform's own words this is the least actionable message in the
 * wrapper: a DNS failure, a TLS failure, an offline device and a proxy refusing
 * the origin all arrive here identically, and `onFatal` is the integrator's only
 * instrument.
 *
 * Both platforms populate `description`, and Android adds a numeric `code`
 * (`net::ERR_NAME_NOT_RESOLVED` and friends). Neither is a string to show a
 * user, so the legible sentence stays first and the diagnosis follows it.
 */
export function webViewLoadError(event: unknown): Error {
  const native = (
    event as { nativeEvent?: { description?: unknown; code?: unknown } } | undefined
  )?.nativeEvent;
  const description =
    typeof native?.description === "string" && native.description.trim()
      ? native.description.trim()
      : undefined;
  const code = typeof native?.code === "number" ? `code ${native.code}` : undefined;
  const detail = [description, code].filter(Boolean).join(", ");
  return new Error(
    detail
      ? `The deposit page could not be loaded (${detail}).`
      : "The deposit page could not be loaded.",
  );
}
