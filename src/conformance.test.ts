/**
 * Replaying the page's published transcript against this host.
 *
 * `protocol.ts` here is a hand-maintained copy of the page's, because a browser
 * library cannot be a dependency of a React Native app and the Swift and Kotlin
 * wrappers cannot import one at all. Writing that copy produced the defect the
 * arrangement predicts — the recovery signing domain transcribed under the wrong
 * name, which nothing but reading the original would have caught, and which
 * would have failed at the processor rather than at signing time.
 *
 * This is what stops the next one. `conformance/bridge-transcript.json` is the
 * page's own recording of what crosses the channel; this drives it into the real
 * host and checks the answers come back in the shape the page expects. A renamed
 * method, a renamed or retyped field, a changed error code or a changed envelope
 * fails here rather than on a device.
 *
 * It replays shapes rather than literal frames, because the artifact records
 * shapes: a transcript of one run's addresses and amounts would have to be
 * regenerated whenever any of them moved, and none of them is contractual.
 *
 * The vendored copy is refreshed by `bun run transcript:check`, which is what
 * notices the page has moved. This file is deliberately offline — a conformance
 * suite that needs the network fails for reasons that are not drift.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createBridgeHost } from "./host";
import { createPageDouble } from "./test/page-double";
import {
  ALLOWED_WALLET_METHODS,
  BRIDGE_ERROR_DOMAIN,
  BLOCKED_REASON,
  BRIDGE_METHOD,
  BridgeErrorCode,
  CAPABILITY,
  DISMISS_SOURCE,
  HOST_EVENT,
  HOST_METHOD,
  HOST_TO_PAGE_CHANNEL,
  MAX_FRAME_LENGTH,
  SIGN_RECOVERY_DOMAIN,
  SIGN_RECOVERY_DOMAIN_ENCODE_TYPE,
  SIGN_RECOVERY_ENCODE_TYPE,
  SIGN_RECOVERY_PRIMARY_TYPE,
  SIGN_RECOVERY_TYPES,
  PAGE_EVENT,
  PAGE_TO_HOST_CHANNEL,
  PROTOCOL_VERSION,
  type Caip27Params,
  type EmbedConfig,
  type Envelope,
  type OpenUrlParams,
  type SendTransactionParams,
  type SignRecoveryParams,
  type WalletState,
} from "./protocol";

type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  /** An array that carried no elements. A leaf rather than `[]`, so that
   *  merging a union never mistakes it for "no alternatives" and drops it —
   *  which is how every no-argument wallet method lost its params shape. */
  | "[]"
  | { [key: string]: Shape }
  | Shape[];

interface TranscriptFrame {
  dir: "page->host" | "host->page";
  kind: "event" | "request" | "response";
  method?: string;
  /** The CAIP-27 inner method, which is what a `wallet.request` frame is really
   *  about — the params shape is the wallet method's, not `wallet.request`'s. */
  walletMethod?: string;
  type?: string;
  answers?: string;
  ok?: boolean;
  errorCode?: number;
  errorDomain?: string;
  shape?: Shape;
}

interface Transcript {
  transcriptFormat: number;
  modalVersion?: string;
  vocabulary: {
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
    dismissalReasons: string[];
    dismissSources: string[];
    passthroughEvents: string[];
    signRecovery: {
      domain: Record<string, string>;
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      encodeType: string;
      domainEncodeType: string;
    };
  };
  frames: TranscriptFrame[];
}

/** The format this file knows how to read. A newer artifact must fail loudly
 *  rather than replay a structure it is guessing at. */
const SUPPORTED_FORMAT = 1;

const transcript = JSON.parse(
  readFileSync(
    resolve(__dirname, "../conformance/bridge-transcript.json"),
    "utf8",
  ),
) as Transcript;

const NONCE = "conformance-nonce";

function isRecord(shape: Shape): shape is { [key: string]: Shape } {
  return typeof shape === "object" && shape !== null && !Array.isArray(shape);
}

/**
 * Values for the leaves the contract constrains by format rather than by type.
 *
 * The transcript records `url` as `"string"` because its VALUE is not
 * contractual — but its format is: the host must refuse anything but `https:`,
 * and a placeholder would be refused for conformance rather than for drift.
 * Keyed by field name, since that is what the shape carries.
 */
const CONSTRAINED_LEAVES: Record<
  string,
  { string?: unknown; number?: unknown }
> = {
  url: { string: "https://pay.example.com/order" },
  to: { string: "0x2222222222222222222222222222222222222222" },
  from: { string: "0x1111111111111111111111111111111111111111" },
  signer: { string: "0x1111111111111111111111111111111111111111" },
  destination: { string: "0x2222222222222222222222222222222222222222" },
  token: { string: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  amount: { string: "1000000" },
  depositId: { string: "4242" },
  // Two contracts share this name: a bare id for the transaction methods, a
  // CAIP-2 reference for CAIP-27. Keyed by name alone they collapse, and the
  // replay drove a number where the page sends `eip155:8453`.
  chainId: { number: 8453, string: "eip155:8453" },
};

/**
 * Build a concrete value the recorded shape describes — the inverse of the
 * page's `shapeOf`.
 *
 * A literal in the shape is vocabulary and is reproduced exactly, which is the
 * point of recording it as one; a leaf type name becomes a placeholder, since
 * no value at that position is contractual. A union takes the first alternative
 * that is not `"undefined"`, so an optional field is exercised present rather
 * than skipped.
 */
function materialize(shape: Shape, key = ""): unknown {
  if (shape === "string" || shape === "number") {
    const constrained = CONSTRAINED_LEAVES[key]?.[shape];
    if (constrained !== undefined) return constrained;
  }
  if (shape === "string") return "x";
  if (shape === "number") return 1;
  if (shape === "boolean") return true;
  if (shape === "null") return null;
  if (shape === "undefined") return undefined;
  if (shape === "[]") return [];

  if (Array.isArray(shape)) {
    if (shape.length === 0) return [];
    // A single-element array is an array shape; anything longer is a union of
    // alternatives, recorded when a field was seen carrying more than one.
    if (shape.length === 1) return [materialize(shape[0]!, key)];
    const preferred = shape.find((option) => option !== "undefined") ?? shape[0];
    return materialize(preferred!, key);
  }

  if (isRecord(shape)) {
    const value: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(shape)) {
      const built = materialize(entry, field);
      if (built !== undefined) value[field] = built;
    }
    return value;
  }

  // A literal, which is vocabulary: a method name, a dismissal reason, a
  // lifecycle discriminant.
  return shape;
}

/** Reduce a value to the same shape vocabulary the artifact uses, so an answer
 *  can be compared against a recorded one. Only the structure is compared, so
 *  literals collapse to their type here — the recorded side is what pins a
 *  vocabulary string, and it is checked separately. */
function structureOf(value: unknown): Shape {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : [structureOf(value[0])];
  }
  if (typeof value === "object") {
    const record: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as object).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      record[key] = structureOf(entry);
    }
    return record;
  }
  return typeof value as Shape;
}

/** The names the artifact uses for a leaf. Anything else at a leaf is a
 *  literal, and a literal constrains an answer's TYPE here — the vocabulary
 *  string itself is pinned by the checks above, against `protocol.ts`. */
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

/**
 * How an answer's structure fails the recorded shape, as a list of reasons.
 *
 * Presence is not conformance. A field the page retyped from `number` to
 * `string` is drift this host would keep answering the old way, and a field
 * that became an object is drift the page would read as `undefined` — so leaves
 * are compared by type and containers by kind, not by key alone.
 *
 * Only the recorded side constrains: an answer carrying a field that was never
 * recorded is an addition, which the contract permits. A union carrying
 * `"undefined"` is the page's way of recording a field seen present in one
 * scenario and absent in another, which is the one fact a native decoder cannot
 * infer from a single example — an answer may omit it.
 *
 * `tolerated` names paths the page reads optionally even though the recording
 * caught them present; an absent one there is not a failure.
 */
function mismatches(
  actual: Shape,
  recorded: Shape,
  path = "",
  tolerated: ReadonlySet<string> = new Set(),
): string[] {
  const at = path || "the result";
  if (tolerated.has(path) && actual === "undefined") return [];

  if (Array.isArray(recorded)) {
    if (recorded.length === 0) return [];
    // One element is an array shape; more is a union of the alternatives the
    // field was seen carrying.
    if (recorded.length === 1) {
      if (actual === "[]") return [];
      if (Array.isArray(actual) && actual.length === 1) {
        return mismatches(actual[0]!, recorded[0]!, `${path}[]`, tolerated);
      }
      return [`${at}: expected an array, got ${JSON.stringify(actual)}`];
    }
    if (recorded.includes("undefined") && actual === "undefined") return [];
    const options = recorded.filter((option) => option !== "undefined");
    const satisfies = (candidate: Shape) =>
      options.some(
        (option) => mismatches(candidate, option, path, tolerated).length === 0,
      );
    if (satisfies(actual)) return [];
    // An array whose elements carried differing shapes is written the same way
    // as a union, so an array of one of the alternatives satisfies it too —
    // `capabilities` is recorded exactly that way.
    if (Array.isArray(actual) && actual.length === 1 && satisfies(actual[0]!)) {
      return [];
    }
    return [
      `${at}: expected one of ${JSON.stringify(recorded)}, got ${JSON.stringify(actual)}`,
    ];
  }

  if (isRecord(recorded)) {
    // An empty record was recorded carrying nothing, so it constrains nothing.
    if (Object.keys(recorded).length === 0) return [];
    if (!isRecord(actual)) {
      return [`${at}: expected an object, got ${JSON.stringify(actual)}`];
    }
    return Object.entries(recorded).flatMap(([key, entry]) =>
      mismatches(
        actual[key] ?? "undefined",
        entry,
        path ? `${path}.${key}` : key,
        tolerated,
      ),
    );
  }

  const want = leafType(recorded);
  if (typeof actual === "string" && leafType(actual) === want) return [];
  return [`${at}: expected ${want}, got ${JSON.stringify(actual)}`];
}

const CONFIG: EmbedConfig = {
  mode: "deposit",
  backendUrl: "https://proxy.example.com",
  recipient: "0x1111111111111111111111111111111111111111",
  targetChain: 8453,
  targetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const WALLET: WalletState = {
  isReady: true,
  isConnected: true,
  accounts: [
    { caip10: "eip155:8453:0x1111111111111111111111111111111111111111" },
  ],
  chainId: "eip155:8453",
  name: "Conformance Wallet",
};

/** What each handler was handed. The answers below are computed without it, so
 *  this is the only place the REQUEST half of the contract is observable. */
interface Received {
  walletRequest?: Caip27Params;
  sendTransaction?: SendTransactionParams;
  signRecovery?: SignRecoveryParams;
  openUrl?: OpenUrlParams;
}

/** Every handler supplied, so every capability is announced and no method is
 *  refused for a reason that is not drift. */
function hostWithEverything() {
  const page = createPageDouble(NONCE);
  const received: Received = {};
  const host = createBridgeHost({
    post: page.post,
    nonce: NONCE,
    host: { platform: "ios", app: "Conformance", version: "0.0.0" },
    getConfig: () => CONFIG,
    getWallet: () => WALLET,
    getHandlers: () => ({
      walletRequest: (params) => {
        received.walletRequest = params;
        switch (params.request.method) {
          case "eth_chainId":
            return "0x2105";
          case "eth_accounts":
            return ["0x1111111111111111111111111111111111111111"];
          case "wallet_switchEthereumChain":
            return null;
          case "eth_signTypedData_v4":
            return `0x${"ab".repeat(65)}`;
          default:
            return `0x${"11".repeat(32)}`;
        }
      },
      sendTransaction: (params) => {
        received.sendTransaction = params;
        return { txHash: `0x${"7a".repeat(32)}` };
      },
      signRecovery: (params) => {
        received.signRecovery = params;
        return { signature: `0x${"5c".repeat(65)}` };
      },
      openUrl: (params) => {
        received.openUrl = params;
      },
    }),
  });
  return { page, host, received };
}

/** Drive one recorded request into the host and wait for its answer. */
async function drive(frame: TranscriptFrame) {
  const { page, host, received } = hostWithEverything();
  const id = `replay-${frame.method}-${frame.walletMethod ?? ""}`;

  page.send(host, {
    kind: "request",
    id,
    method: frame.method!,
    ...(frame.shape === undefined ? {} : { params: materialize(frame.shape) }),
  } as Envelope);

  // The host answers from a promise chain, never synchronously inside the
  // page's own call stack — the same rule the page's mock host follows.
  await vi.waitFor(() =>
    expect(
      page.frames.some((sent) => sent.kind === "response" && sent.id === id),
      `no answer to ${frame.method}`,
    ).toBe(true),
  );

  const answer = page.frames.find(
    (sent): sent is Extract<Envelope, { kind: "response" }> =>
      sent.kind === "response" && sent.id === id,
  )!;
  return { answer, received };
}

function recordedRequest(method: string, walletMethod?: string) {
  const frame = transcript.frames.find(
    (candidate) =>
      candidate.dir === "page->host" &&
      candidate.kind === "request" &&
      candidate.method === method &&
      candidate.walletMethod === walletMethod,
  );
  expect(frame, `no recorded ${method} request`).toBeDefined();
  return frame!;
}

describe("the artifact", () => {
  it("is a format this wrapper can read", () => {
    expect(transcript.transcriptFormat).toBe(SUPPORTED_FORMAT);
  });
});

describe("the vocabulary this wrapper declares", () => {
  const { vocabulary } = transcript;

  it("speaks the same protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(vocabulary.protocol);
  });

  it("installs the channels under the names the page uses", () => {
    expect(PAGE_TO_HOST_CHANNEL).toBe(vocabulary.channels.pageToHost);
    expect(HOST_TO_PAGE_CHANNEL).toBe(vocabulary.channels.hostToPage);
    expect(MAX_FRAME_LENGTH).toBe(vocabulary.maxFrameLength);
  });

  it("names every method the same way", () => {
    expect(Object.values(BRIDGE_METHOD).sort()).toEqual(vocabulary.pageMethods);
    expect(Object.values(HOST_METHOD).sort()).toEqual(vocabulary.hostMethods);
    expect(Object.values(CAPABILITY).sort()).toEqual(vocabulary.capabilities);
  });

  it("names every event the same way", () => {
    expect(Object.values(PAGE_EVENT).sort()).toEqual(vocabulary.pageEvents);
    expect(Object.values(HOST_EVENT).sort()).toEqual(vocabulary.hostEvents);
  });

  // The signing surface. A method here the page does not send is one this host
  // exposes for nothing; one the page sends and this omits refuses the page's
  // own deposit, and surfaces as "An unknown RPC error occurred" with the
  // wallet's real message destroyed.
  it("allows exactly the wallet methods the page sends", () => {
    expect([...ALLOWED_WALLET_METHODS].sort()).toEqual(vocabulary.walletMethods);
  });

  // `dismissal.reason` and `dismissRequested.source` are fields this host
  // reads, so both are checkable rather than advisory. Exact equality in both
  // directions: a reason the page never sends is a branch an integrator writes
  // that can never run, and one it sends that this omits is typed as something
  // it is not.
  it("names every dismissal reason and source the same way", () => {
    expect(Object.values(BLOCKED_REASON).sort()).toEqual(
      vocabulary.dismissalReasons,
    );
    expect(Object.values(DISMISS_SOURCE).sort()).toEqual(
      vocabulary.dismissSources,
    );
  });

  // The defect this whole artifact was built for.
  //
  // These constants cross no frame — `host.signRecovery` sends the FIELDS, and
  // each host compiles the struct in — so nothing recorded could ever catch a
  // wrong transcription of them, which is exactly how the domain was first
  // written here under the wrong name. The failure is remote and late: the
  // field array is hashed in declared order, so a wrong domain or a reordered
  // type derives a different separator and produces a signature that is well
  // formed, passes locally, and is rejected by the processor.
  it("compiles the same EIP-712 struct the page publishes", () => {
    const published = vocabulary.signRecovery;
    expect(SIGN_RECOVERY_DOMAIN).toEqual(published.domain);
    expect(SIGN_RECOVERY_PRIMARY_TYPE).toBe(published.primaryType);
    expect(SIGN_RECOVERY_ENCODE_TYPE).toBe(published.encodeType);
    expect(SIGN_RECOVERY_DOMAIN_ENCODE_TYPE).toBe(published.domainEncodeType);
    // Compared as an ordered array, never as a set: the order IS the hash.
    expect(SIGN_RECOVERY_TYPES).toEqual(published.types);
  });

  // The domain is the only thing separating a bridge code from a wallet's own,
  // and a code that disagrees is a valid-looking wrong answer.
  it("agrees on the error domain and every code", () => {
    expect(BRIDGE_ERROR_DOMAIN).toBe(vocabulary.errorDomain);
    for (const [name, code] of Object.entries(vocabulary.errorCodes)) {
      expect(
        BridgeErrorCode[name as keyof typeof BridgeErrorCode],
        `error code ${name}`,
      ).toBe(code);
    }
    expect(Object.keys(BridgeErrorCode).sort()).toEqual(
      Object.keys(vocabulary.errorCodes).sort(),
    );
  });
});

describe("replaying every recorded page→host request", () => {
  const requests = transcript.frames.filter(
    (frame) => frame.dir === "page->host" && frame.kind === "request",
  );

  it("has requests to replay", () => {
    expect(requests.length).toBeGreaterThan(0);
  });

  for (const frame of requests) {
    const name = `${frame.method}${frame.walletMethod ? ` (${frame.walletMethod})` : ""}`;
    it(`answers ${name}`, async () => {
      const { answer } = await drive(frame);

      // A 4200 here means this host does not implement a method the page sends,
      // which is the drift the whole artifact exists to catch — every handler
      // is supplied above, so nothing legitimately refuses.
      expect(
        answer.ok || answer.error.code !== 4200,
        `${name} was refused as unsupported`,
      ).toBe(true);

      // Matched on the wallet method too: one union across all six results
      // accepts a string where a send's hash belongs and `null` where an
      // account list does, and the page's own decoder refuses that — a wrapper
      // could replay green while stranding a transfer the page cannot read.
      const recorded = transcript.frames.find(
        (candidate) =>
          candidate.dir === "host->page" &&
          candidate.kind === "response" &&
          candidate.answers === frame.method &&
          candidate.walletMethod === frame.walletMethod &&
          candidate.ok === true,
      );
      if (!recorded?.shape) return;

      expect(answer.ok, `${name} answered with an error`).toBe(true);
      if (!answer.ok) return;

      // Every field the page expects to read, carrying the type it expects to
      // read it as. A host omitting a field the page marked optional passes;
      // one omitting a required field, or answering it as another type, does
      // not.
      expect(
        mismatches(structureOf(answer.result), recorded.shape),
        `${name} answered a shape the page does not expect`,
      ).toEqual([]);
    });
  }
});

/**
 * What the page SENDS, as opposed to what it reads back.
 *
 * The replay above proves the host answers; it cannot prove the answer was
 * computed from the right fields, because every handler there ignores its
 * params. A page that renamed `to` to `recipient` would hand the wrapper an
 * object with no `to` in it, every handler would answer exactly as before, and
 * the integrator's app — which reads `params.to` — would transfer nothing.
 *
 * Each field is named through the wrapper's own parameter type, so a rename in
 * `protocol.ts` fails `tsc` rather than this; and its type is asserted at
 * runtime, so a rename or a retype on the PAGE's side fails here.
 */
describe("the request fields handed to the host app", () => {
  it("hands sendTransaction the transfer, not an empty object", async () => {
    const { received } = await drive(
      recordedRequest(BRIDGE_METHOD.SEND_TRANSACTION),
    );
    expect(received.sendTransaction, "sendTransaction never ran").toBeDefined();
    const params = received.sendTransaction!;
    expect({
      chainId: typeof params.chainId,
      token: typeof params.token,
      amount: typeof params.amount,
      to: typeof params.to,
      from: typeof params.from,
    }).toEqual({
      chainId: "number",
      token: "string",
      amount: "string",
      to: "string",
      from: "string",
    });
  });

  // `chainId` is NOT part of the signed domain, so a wrong one here is not
  // caught by the struct check above — it picks the verifier.
  it("hands signRecovery the deposit it is signing for", async () => {
    const { received } = await drive(
      recordedRequest(BRIDGE_METHOD.SIGN_RECOVERY),
    );
    expect(received.signRecovery, "signRecovery never ran").toBeDefined();
    const params = received.signRecovery!;
    expect({
      chainId: typeof params.chainId,
      signer: typeof params.signer,
      depositId: typeof params.depositId,
      destination: typeof params.destination,
    }).toEqual({
      chainId: "number",
      signer: "string",
      depositId: "string",
      destination: "string",
    });
  });

  it("hands openUrl a url", async () => {
    const { received } = await drive(recordedRequest(BRIDGE_METHOD.OPEN_URL));
    expect(received.openUrl, "openUrl never ran").toBeDefined();
    expect(typeof received.openUrl!.url).toBe("string");
  });

  // The CAIP-27 envelope, where `chainId` is a CAIP-2 reference rather than the
  // bare id the transaction methods send. It is authoritative for the request —
  // the chain the wallet must execute on, not a report of where it is — so a
  // host reading it as a number switches to nothing.
  for (const walletMethod of ALLOWED_WALLET_METHODS) {
    it(`hands walletRequest a CAIP-27 envelope for ${walletMethod}`, async () => {
      const { received } = await drive(
        recordedRequest(BRIDGE_METHOD.WALLET_REQUEST, walletMethod),
      );
      expect(received.walletRequest, "walletRequest never ran").toBeDefined();
      const params = received.walletRequest!;
      expect({
        chainId: typeof params.chainId,
        method: typeof params.request.method,
      }).toEqual({ chainId: "string", method: "string" });
      expect(params.request.method).toBe(walletMethod);
    });
  }
});

describe("replaying every recorded host→page frame", () => {
  // The host builds these rather than parsing them, so this is the direction
  // where a wrapper invents a field name and nothing on the page notices until
  // the frame is dropped on a device.
  it("builds hello's answer with every field the page reads", async () => {
    const { page, host } = hostWithEverything();
    page.send(host, {
      kind: "request",
      id: "hello-1",
      method: BRIDGE_METHOD.HELLO,
      params: { protocol: PROTOCOL_VERSION, modalVersion: "0.0.0" },
    } as Envelope);

    await vi.waitFor(() => expect(page.frames.length).toBeGreaterThan(0));
    const answer = page.frames.find(
      (sent): sent is Extract<Envelope, { kind: "response" }> =>
        sent.kind === "response" && sent.id === "hello-1",
    );
    expect(answer?.ok).toBe(true);

    const recorded = transcript.frames.find(
      (frame) =>
        frame.dir === "host->page" &&
        frame.kind === "response" &&
        frame.answers === BRIDGE_METHOD.HELLO,
    );
    expect(
      mismatches(
        structureOf(answer!.ok ? answer!.result : undefined),
        recorded!.shape!,
        "",
        // `host.app` and `host.version` are optional on the page's side; the
        // rest of hello is not.
        new Set(["host.app", "host.version"]),
      ),
      "hello answered a shape the page does not expect",
    ).toEqual([]);
  });

  it("emits both host events under the recorded names", () => {
    const { page, host } = hostWithEverything();
    host.configure(CONFIG);
    host.pushWalletState(WALLET);

    const emitted = page.frames
      .filter((frame) => frame.kind === "event")
      .map((frame) => frame.type);
    for (const name of transcript.vocabulary.hostEvents) {
      expect(emitted, `never emitted ${name}`).toContain(name);
    }
  });
});
