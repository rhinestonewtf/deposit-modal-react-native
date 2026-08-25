/**
 * Compare the vendored conformance transcript against the one the page is
 * serving, and fail on a BREAK rather than on any difference.
 *
 * The vendored copy is what `conformance.test.ts` replays, and it has to be
 * vendored: the conformance suite must not need the network, or it fails for
 * reasons that are not drift, and the Swift and Kotlin wrappers cannot install
 * an npm package to get it either. A vendored copy that nothing refreshes is
 * the drift problem again one level up, which is what this closes.
 *
 * **Additions are not failures.** The contract's own discipline is that an
 * existing field never changes meaning or type, new fields are optional, and a
 * receiver ignores what it does not know — so a page that adds a method or an
 * event has not broken this wrapper, and reddening CI for it would train people
 * to re-vendor without reading. A REMOVAL or a RENAME is a break: this wrapper
 * declares a name the page no longer speaks, and the failure would otherwise be
 * a 4200 on a device.
 *
 * Run against dev by default, because dev tracks `main` and is where a contract
 * change lands first. Prod serves the released contract and moves once per
 * release.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ORIGIN = "https://dev.deposit.rhinestone.dev";

interface Vocabulary {
  protocol: number;
  channels: { pageToHost: string; hostToPage: string };
  maxFrameLength: number;
  pageMethods: string[];
  hostMethods: string[];
  pageEvents: string[];
  hostEvents: string[];
  capabilities: string[];
  walletMethods: string[];
  errorDomain: string;
  errorCodes: Record<string, number>;
}

interface Transcript {
  transcriptFormat: number;
  modalVersion?: string;
  vocabulary: Vocabulary;
  frames: unknown[];
}

const origin = process.argv[2] ?? DEFAULT_ORIGIN;
const url = `${origin.replace(/\/$/, "")}/bridge-transcript.json`;

const vendoredPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "conformance",
  "bridge-transcript.json",
);
const vendored = JSON.parse(readFileSync(vendoredPath, "utf8")) as Transcript;

let published: Transcript;
try {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${url} answered ${response.status}.`);
    process.exit(1);
  }
  published = (await response.json()) as Transcript;
} catch (error) {
  console.error(`Could not reach ${url}: ${(error as Error).message}`);
  process.exit(1);
}

const breaks: string[] = [];

if (published.transcriptFormat !== vendored.transcriptFormat) {
  breaks.push(
    `transcript format ${vendored.transcriptFormat} → ${published.transcriptFormat}; ` +
      `this wrapper's replay only reads ${vendored.transcriptFormat}`,
  );
}

// A protocol bump is additive by the page's own rule ("bumped only for an
// additive change a host might want to detect; never to signal a break"), so a
// higher number is reported and not failed. A LOWER one means the vendored copy
// came from somewhere ahead of what is deployed.
if (published.vocabulary.protocol < vendored.vocabulary.protocol) {
  breaks.push(
    `protocol went backwards: vendored ${vendored.vocabulary.protocol}, published ${published.vocabulary.protocol}`,
  );
}

const NAME_LISTS = [
  "pageMethods",
  "hostMethods",
  "pageEvents",
  "hostEvents",
  "capabilities",
  "walletMethods",
] as const;

const additions: string[] = [];

for (const list of NAME_LISTS) {
  const now = new Set(published.vocabulary[list]);
  for (const name of vendored.vocabulary[list]) {
    if (!now.has(name)) breaks.push(`${list}: "${name}" no longer exists`);
  }
  const had = new Set(vendored.vocabulary[list]);
  for (const name of published.vocabulary[list]) {
    if (!had.has(name)) additions.push(`${list}: "${name}" is new`);
  }
}

for (const [name, code] of Object.entries(vendored.vocabulary.errorCodes)) {
  const now = published.vocabulary.errorCodes[name];
  if (now === undefined) breaks.push(`errorCodes: "${name}" no longer exists`);
  else if (now !== code) {
    breaks.push(`errorCodes: "${name}" changed ${code} → ${now}`);
  }
}
for (const name of Object.keys(published.vocabulary.errorCodes)) {
  if (!(name in vendored.vocabulary.errorCodes)) {
    additions.push(`errorCodes: "${name}" is new`);
  }
}

for (const [field, value] of [
  ["channels.pageToHost", vendored.vocabulary.channels.pageToHost],
  ["channels.hostToPage", vendored.vocabulary.channels.hostToPage],
  ["errorDomain", vendored.vocabulary.errorDomain],
] as const) {
  const now =
    field === "errorDomain"
      ? published.vocabulary.errorDomain
      : field === "channels.pageToHost"
        ? published.vocabulary.channels.pageToHost
        : published.vocabulary.channels.hostToPage;
  if (now !== value) breaks.push(`${field} changed "${value}" → "${now}"`);
}

console.log(`vendored  ${vendoredPath}`);
console.log(`published ${url}${published.modalVersion ? ` (modal ${published.modalVersion})` : ""}`);

if (additions.length) {
  console.log(`\n${additions.length} addition(s) — not a break:`);
  for (const line of additions) console.log(`  + ${line}`);
  console.log(
    "\nRe-vendor to cover them in the replay:\n" +
      `  curl -fsS ${url} -o conformance/bridge-transcript.json`,
  );
}

if (breaks.length) {
  console.error(`\n${breaks.length} BREAK(S) — this wrapper speaks a contract the page does not:`);
  for (const line of breaks) console.error(`  ! ${line}`);
  console.error(
    "\nFix `src/protocol.ts` to match, re-vendor the transcript, and make the\n" +
      "conformance replay pass. Do not re-vendor alone — that silences the check\n" +
      "without fixing the wrapper.",
  );
  process.exit(1);
}

console.log(breaks.length === 0 && additions.length === 0 ? "\nIdentical." : "\nNo breaks.");
