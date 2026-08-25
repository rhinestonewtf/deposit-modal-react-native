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
  signRecovery?: {
    domain: Record<string, string>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    encodeType: string;
    domainEncodeType: string;
  };
}

type Shape = string | { [key: string]: Shape } | Shape[];

interface TranscriptFrame {
  dir: "page->host" | "host->page";
  kind: "event" | "request" | "response";
  method?: string;
  /** The CAIP-27 inner method. Part of a `wallet.request` frame's identity,
   *  because the params shape is the wallet method's rather than the
   *  envelope's. */
  walletMethod?: string;
  type?: string;
  answers?: string;
  ok?: boolean;
  errorCode?: number;
  shape?: Shape;
}

interface Transcript {
  transcriptFormat: number;
  modalVersion?: string;
  vocabulary: Vocabulary;
  frames: TranscriptFrame[];
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

const notes: string[] = [];

for (const list of NAME_LISTS) {
  const now = new Set(published.vocabulary[list]);
  for (const name of vendored.vocabulary[list]) {
    if (!now.has(name)) breaks.push(`${list}: "${name}" no longer exists`);
  }
  const had = new Set(vendored.vocabulary[list]);
  for (const name of published.vocabulary[list]) {
    if (!had.has(name)) notes.push(`${list}: "${name}" is new`);
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
    notes.push(`errorCodes: "${name}" is new`);
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

// A cap this wrapper hard-codes and must EQUAL, like the channel names above.
// Lowered, it sends frames the page drops; raised, it drops frames the page now
// considers legal. Neither direction is an addition.
if (published.vocabulary.maxFrameLength !== vendored.vocabulary.maxFrameLength) {
  breaks.push(
    `maxFrameLength changed ${vendored.vocabulary.maxFrameLength} → ${published.vocabulary.maxFrameLength}`,
  );
}

/**
 * The EIP-712 recovery constants, which no frame comparison could ever reach:
 * `host.signRecovery` sends the FIELDS and each host compiles the struct in, so
 * they cross the channel only as their consequence. The replay checks them
 * against the VENDORED copy, which leaves a page-side change looking fresh —
 * and the failure is remote and late, because the field array is hashed in
 * declared order, so a reorder derives a different separator and produces a
 * signature that is well formed, passes locally, and is rejected by the
 * processor. Compared verbatim, order included, for that reason.
 */
if (!published.vocabulary.signRecovery) {
  breaks.push("signRecovery is gone from the published vocabulary");
} else if (vendored.vocabulary.signRecovery) {
  const mine = vendored.vocabulary.signRecovery;
  const theirs = published.vocabulary.signRecovery;
  for (const [field, was, now] of [
    ["signRecovery.domain", mine.domain, theirs.domain],
    ["signRecovery.types", mine.types, theirs.types],
    ["signRecovery.primaryType", mine.primaryType, theirs.primaryType],
    ["signRecovery.encodeType", mine.encodeType, theirs.encodeType],
    [
      "signRecovery.domainEncodeType",
      mine.domainEncodeType,
      theirs.domainEncodeType,
    ],
  ] as const) {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      breaks.push(
        `${field} changed ${JSON.stringify(was)} → ${JSON.stringify(now)}`,
      );
    }
  }
}

/**
 * The vocabulary lists catch a NAME that disappeared; the frames are where a
 * FIELD does. A page that drops `txHash` from its sendTransaction answer, or
 * retypes `targetChain` from a number to a string, keeps every name intact and
 * would otherwise pass here — and the offline replay only ever sees the
 * vendored copy, so nothing else would notice.
 */

const LEAF_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
  "[]",
]);

function leafType(shape: string): string {
  return LEAF_TYPES.has(shape) ? shape : "string";
}

function isRecord(shape: Shape): shape is { [key: string]: Shape } {
  return typeof shape === "object" && shape !== null && !Array.isArray(shape);
}

function kindOf(shape: Shape): "object" | "array" | "leaf" {
  if (Array.isArray(shape)) return "array";
  return isRecord(shape) ? "object" : "leaf";
}

/**
 * Literals collapse to their type, record keys sort, and union alternatives
 * sort and dedupe — so two recordings of the same contract compare equal
 * whatever order they were written in and whichever values they happened to
 * catch. A literal changing is a vocabulary change, and the lists above own it.
 */
function normalize(shape: Shape): Shape {
  if (Array.isArray(shape)) {
    const byForm = new Map<string, Shape>();
    for (const option of shape) {
      const normalized = normalize(option);
      byForm.set(JSON.stringify(normalized), normalized);
    }
    return [...byForm.keys()].sort().map((form) => byForm.get(form)!);
  }
  if (isRecord(shape)) {
    const record: { [key: string]: Shape } = {};
    for (const key of Object.keys(shape).sort()) {
      record[key] = normalize(shape[key]!);
    }
    return record;
  }
  return leafType(shape);
}

function canonical(shape: Shape): string {
  return JSON.stringify(normalize(shape));
}

function diffShape(
  mine: Shape,
  theirs: Shape,
  where: string,
  path = "",
): void {
  const at = path ? `${where} ${path}` : where;

  if (isRecord(mine) && isRecord(theirs)) {
    for (const [key, entry] of Object.entries(mine)) {
      const below = path ? `${path}.${key}` : key;
      const now = theirs[key];
      if (now === undefined) breaks.push(`${where} ${below} is gone`);
      else diffShape(entry, now, where, below);
    }
    for (const key of Object.keys(theirs)) {
      if (!(key in mine)) {
        notes.push(`${where} ${path ? `${path}.${key}` : key} is new`);
      }
    }
    return;
  }

  if (Array.isArray(mine) && Array.isArray(theirs)) {
    const spare = [...theirs];
    for (const option of mine) {
      const same = spare.findIndex(
        (candidate) => canonical(candidate) === canonical(option),
      );
      if (same !== -1) {
        spare.splice(same, 1);
        continue;
      }
      // An alternative that GAINED a field would otherwise read as one that
      // vanished, so pair it with the nearest alternative of the same kind
      // before calling it gone.
      const near = spare.findIndex(
        (candidate) => kindOf(candidate) === kindOf(option),
      );
      if (near !== -1) {
        diffShape(option, spare[near]!, where, path);
        spare.splice(near, 1);
        continue;
      }
      breaks.push(`${at} no longer carries ${canonical(option)}`);
    }
    for (const option of spare) {
      notes.push(`${at} also carries ${canonical(option)}`);
    }
    return;
  }

  if (canonical(mine) !== canonical(theirs)) {
    breaks.push(`${at} changed ${canonical(mine)} → ${canonical(theirs)}`);
  }
}

function frameKey(frame: TranscriptFrame): string {
  const name = frame.walletMethod
    ? `${frame.method} (${frame.walletMethod})`
    : (frame.method ?? frame.type ?? frame.answers ?? "");
  if (frame.kind !== "response") return `${frame.dir} ${frame.kind} ${name}`;
  const outcome = frame.ok ? "ok" : `error ${frame.errorCode ?? "?"}`;
  return `${frame.dir} response to ${name} ${outcome}`;
}

const publishedFrames = new Map<string, TranscriptFrame>();
for (const frame of published.frames ?? []) {
  publishedFrames.set(frameKey(frame), frame);
}

for (const frame of vendored.frames ?? []) {
  const key = frameKey(frame);
  const now = publishedFrames.get(key);
  if (!now) {
    // Which exchanges the page's scenarios happen to exercise is not the
    // contract; a name disappearing is, and the vocabulary lists own that.
    notes.push(`${key} is no longer recorded`);
    continue;
  }
  if (frame.shape === undefined) continue;
  if (now.shape === undefined) {
    breaks.push(`${key} no longer records a shape`);
    continue;
  }
  diffShape(frame.shape, now.shape, key);
}

console.log(`vendored  ${vendoredPath}`);
console.log(`published ${url}${published.modalVersion ? ` (modal ${published.modalVersion})` : ""}`);

if (notes.length) {
  console.log(`\n${notes.length} change(s) — not a break:`);
  for (const line of notes) console.log(`  · ${line}`);
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

console.log(breaks.length === 0 && notes.length === 0 ? "\nIdentical." : "\nNo breaks.");
