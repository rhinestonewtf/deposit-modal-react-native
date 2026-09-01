/**
 * Ordering for the `modalVersion` an embed origin stamps into its transcript.
 *
 * Its only job is telling a deploy that is BEHIND the vendored copy from a page
 * that has genuinely dropped something — see `check-transcript-freshness.ts`.
 */

const SNAPSHOT = /^0\.0\.0-dev-(\d{14})$/;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Negative when `mine` is older, positive when it is newer, `undefined` when
 * the two have no common scale.
 *
 * The origins publish two different forms: a release is plain semver, and dev
 * is a changesets snapshot, `0.0.0-dev-<YYYYMMDDHHMMSS>`, whose order is the
 * timestamp and whose leading `0.0.0` sorts below every release. So one of each
 * cannot be ordered at all — vendoring from prod and checking against dev is a
 * legitimate thing to do, and guessing an order there would produce exactly the
 * confident wrong answer this exists to prevent.
 */
export function compareModalVersions(
  mine: string,
  theirs: string,
): number | undefined {
  const mineSnapshot = SNAPSHOT.exec(mine);
  const theirsSnapshot = SNAPSHOT.exec(theirs);
  if (mineSnapshot && theirsSnapshot) {
    return Number(mineSnapshot[1]) - Number(theirsSnapshot[1]);
  }

  const mineRelease = RELEASE.exec(mine);
  const theirsRelease = RELEASE.exec(theirs);
  if (mineRelease && theirsRelease) {
    for (let part = 1; part <= 3; part += 1) {
      const diff = Number(mineRelease[part]) - Number(theirsRelease[part]);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  return undefined;
}

/**
 * Whether the origin is serving an older modal than the vendored copy came
 * from.
 *
 * Absent on either side is `false`: an unorderable pair is the same answer as
 * "no lag", because the check's fallback is to treat differences as breaks,
 * which is the safe direction.
 */
export function originIsBehind(
  vendored: string | undefined,
  published: string | undefined,
): boolean {
  if (vendored === undefined || published === undefined) return false;
  const order = compareModalVersions(vendored, published);
  return order !== undefined && order > 0;
}
