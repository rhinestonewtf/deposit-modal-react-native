/**
 * Writes `WRAPPER_VERSION` from package.json.
 *
 * Runs from `build` and from `changeset:version`, which between them covers
 * every path that publishes. The value is the wrapper's own identity in the
 * version header, so a build that skipped this would report the last released
 * version while running unreleased code — the one thing the header exists to
 * tell us apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src", "version.ts");

const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { version: string };

const source = readFileSync(target, "utf8");
const next = source.replace(
  /export const WRAPPER_VERSION = "[^"]*";/,
  `export const WRAPPER_VERSION = "${version}";`,
);

if (next === source && !source.includes(`"${version}"`)) {
  throw new Error(`Could not write WRAPPER_VERSION into ${target}`);
}

writeFileSync(target, next);
console.log(`sync-version: WRAPPER_VERSION -> ${version}`);
