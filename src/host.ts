/**
 * The host half of the bridge: correlation, dispatch, and what to do with
 * frames that do not fit.
 *
 * Deliberately free of React and of `react-native-webview`. It takes a `post`
 * function and is handed strings; everything about presenting a web view lives
 * in `DepositSheet`. That is what lets the whole contract be tested in Node,
 * and it is the same split the page makes on its side.
 *
 * The rule throughout mirrors the page's: a misfit frame is dropped and
 * counted, never turned into a user-visible failure. The page is another
 * process with its own bugs; this side's job is to remain a host.
 */
import {
  BRIDGE_METHOD,
  BridgeErrorCode,
  CAPABILITY,
  HOST_METHOD,
  MAX_FRAME_LENGTH,
  PROTOCOL_VERSION,
  SUBMITTING_WALLET_METHODS,
  bridgeError,
  isAllowedWalletMethod,
  unsupportedMethod,
  type BridgeError,
  type Caip27Params,
  type EmbedConfig,
  type Envelope,
  type HelloParams,
  type HelloResult,
  type HostEventType,
  type OpenUrlParams,
  type RequestEnvelope,
  type SendTransactionParams,
  type SendTransactionResult,
  type SignRecoveryParams,
  type SignRecoveryResult,
  type UiBackResult,
  type UiStatePayload,
  type WalletState,
} from "./protocol";
import { encodeFrameForInjection, parseInboundFrame } from "./injection";

/**
 * How long a back gesture waits for the page.
 *
 * A hardware back that hangs feels broken, and a back that dismisses a sheet
 * mid-signature loses money, so neither direction is free. The deadline is
 * short and its expiry resolves `handled: false` — the *permissive* answer —
 * because the dismissal policy is applied separately and independently, and a
 * page that has stopped answering has also stopped telling us it is locked.
 */
export const BACK_TIMEOUT_MS = 1_200;

export class HostError extends Error {
  readonly bridge: BridgeError;

  constructor(bridge: BridgeError) {
    super(bridge.message);
    this.name = "HostError";
    this.bridge = bridge;
  }
}

/** EIP-1193 4001. The user saw the request and said no. */
export function userRejected(message = "Request rejected."): HostError {
  return new HostError({ code: 4001, message });
}

/** A wallet exists but could not be reached. */
export function walletUnavailable(
  message = "Your wallet could not be reached.",
): HostError {
  return new HostError(
    bridgeError(BridgeErrorCode.WALLET_UNAVAILABLE, message),
  );
}

/**
 * The send may already be on chain.
 *
 * Throw this whenever an app switch, a process death or an SDK timeout leaves
 * you unable to say. The page has copy for it that does not invite a retry,
 * which no other answer does.
 */
export function submissionUncertain(
  message = "Your wallet may have submitted this. Check your activity before trying again.",
): HostError {
  return new HostError(
    bridgeError(BridgeErrorCode.SUBMISSION_UNCERTAIN, message),
  );
}

export interface BridgeHostHandlers {
  /** The wallet the page drives, CAIP-27. Omit for a deposit flow that offers
   *  QR and transfer only. */
  walletRequest?: (params: Caip27Params) => Promise<unknown> | unknown;
  /** Withdraw's transfer. Supplying it announces
   *  `CAPABILITY.SEND_TRANSACTION`. */
  sendTransaction?: (
    params: SendTransactionParams,
  ) => Promise<SendTransactionResult> | SendTransactionResult;
  /** Claim's signature. Supplying it announces `CAPABILITY.SIGN_RECOVERY`. */
  signRecovery?: (
    params: SignRecoveryParams,
  ) => Promise<SignRecoveryResult> | SignRecoveryResult;
  /** Present a browser over the app. Supplying it announces
   *  `CAPABILITY.OPEN_URL`; without it the page offers no card row at all. */
  openUrl?: (params: OpenUrlParams) => Promise<void> | void;
}

export interface BridgeHostOptions {
  /** Runs one statement of JavaScript in the web view's main frame. */
  post: (script: string) => void;
  /** Only frames carrying this prefix are acted on. */
  nonce: string;
  host: HelloResult["host"];
  /** Read at handshake time, so a config change before hello is picked up. */
  getConfig: () => EmbedConfig;
  getWallet: () => WalletState;
  /**
   * Read per request, and for the capability list at hello.
   *
   * Not a fixed object, because a host that had to be rebuilt when a handler
   * appeared would be a host rebuilt underneath a page that had already
   * handshaken with the old one — and the page has no reason to handshake
   * again. Every wallet update would then stop reaching it, and the only thing
   * that eventually noticed was the handshake deadline, which recovers by
   * reloading the page out from under whatever the user was doing.
   *
   * What the page is told at hello is therefore a snapshot: a capability that
   * appears afterwards is not announced until the next session. A wallet is
   * different and does not need one, because wallet availability rides
   * `wallet.state`, which is pushed.
   */
  getHandlers: () => BridgeHostHandlers;
  onEvent?: (type: string, payload: unknown) => void;
  /** Every `hello`, with the page's own version. Fires once per page load, so
   *  a reload after a crash fires it again. */
  onHello?: (params: HelloParams) => void;
  backTimeoutMs?: number;
}

export type DropReason =
  | "not-a-string"
  | "foreign-frame"
  | "too-large"
  | "not-json"
  | "not-an-object"
  | "unknown-kind"
  | "unmatched-response"
  | "bad-ui-state"
  | "closed";

export type HostStats = Record<DropReason, number>;

export interface BridgeHost {
  /** Feed it `event.nativeEvent.data`. */
  receive(raw: unknown): void;
  /** Android's hardware back, iOS's interactive swipe. */
  back(): Promise<UiBackResult>;
  pushWalletState(state: WalletState): void;
  configure(config: EmbedConfig): void;
  /** What would be announced at hello now, derived from the handlers. */
  readonly capabilities: readonly string[];
  /** Latest `ui.state`, or `undefined` before the first one. */
  readonly uiState: UiStatePayload | undefined;
  /** Whether a `hello` has been answered on the current page load. */
  readonly connected: boolean;
  close(): void;
  readonly stats: Readonly<HostStats>;
}

function emptyStats(): HostStats {
  return {
    "not-a-string": 0,
    "foreign-frame": 0,
    "too-large": 0,
    "not-json": 0,
    "not-an-object": 0,
    "unknown-kind": 0,
    "unmatched-response": 0,
    "bad-ui-state": 0,
    closed: 0,
  };
}

/**
 * The dismissal lock is the one payload this host reads a nested field out of,
 * so it is the one that has to be checked rather than cast.
 *
 * The page and the wrapper ship separately and by different routes — a hosted
 * page against an app-store build — so a frame from a version that spells this
 * differently is a thing that will happen, not a hypothetical. Casting it and
 * reading `dismissal.state` turns that into a crash inside someone's app, which
 * is the one outcome a protocol mismatch must never produce.
 */
function isUiState(payload: unknown): payload is UiStatePayload {
  const candidate = payload as UiStatePayload | undefined;
  if (!candidate || typeof candidate.screen !== "string") return false;
  const dismissal = candidate.dismissal as
    | UiStatePayload["dismissal"]
    | undefined;
  return dismissal?.state === "allowed" || dismissal?.state === "blocked";
}

/**
 * Capabilities are derived, never declared.
 *
 * A list the integrator passes alongside the handlers is a list that can
 * disagree with them, and both directions of that disagreement are bad: an
 * over-claim answers 4200 on a screen the page already offered, and an
 * under-claim hides a payment method the app supports.
 */
function deriveCapabilities(handlers: BridgeHostHandlers): string[] {
  const capabilities: string[] = [];
  if (handlers.sendTransaction) capabilities.push(CAPABILITY.SEND_TRANSACTION);
  if (handlers.signRecovery) capabilities.push(CAPABILITY.SIGN_RECOVERY);
  if (handlers.openUrl) capabilities.push(CAPABILITY.OPEN_URL);
  return capabilities;
}

/**
 * What to answer when a handler throws something that is not a `HostError`.
 *
 * For anything the page can safely retry, -32603 is right. For a send it is
 * the one code that must never be used: viem retries -32603 three times on its
 * own, and a retried `eth_sendTransaction` is a second broadcast of the same
 * transfer. An integrator's handler that threw after calling their wallet is
 * exactly the case nobody can resolve from here, so a submitting method fails
 * safe to `SUBMISSION_UNCERTAIN` — the page stops and tells the user to check,
 * rather than offering a button that sends again.
 */
function toBridgeError(error: unknown, submitting: boolean): BridgeError {
  if (error instanceof HostError) return error.bridge;
  const message =
    error instanceof Error && error.message
      ? error.message
      : "The app could not complete this request.";
  if (submitting) {
    return bridgeError(BridgeErrorCode.SUBMISSION_UNCERTAIN, message);
  }
  return { code: -32603, message };
}

export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { post, nonce, getHandlers, onEvent, onHello } = options;
  const backTimeoutMs = options.backTimeoutMs ?? BACK_TIMEOUT_MS;

  const stats = emptyStats();
  const pending = new Map<string, (result: UiBackResult) => void>();

  let closed = false;
  let connected = false;
  let uiState: UiStatePayload | undefined;
  let backCounter = 0;

  function send(frame: Envelope): void {
    if (closed) {
      stats.closed += 1;
      return;
    }
    post(encodeFrameForInjection(JSON.stringify(frame)));
  }

  function respond(id: string, result: unknown): void {
    send({ kind: "response", id, ok: true, result });
  }

  function fail(id: string, error: BridgeError): void {
    send({ kind: "response", id, ok: false, error });
  }

  function emit(type: HostEventType, payload: unknown): void {
    send({ kind: "event", type, payload });
  }

  async function handleWalletRequest(params: unknown): Promise<unknown> {
    const caip27 = params as Caip27Params | undefined;
    const method = caip27?.request?.method;
    if (typeof method !== "string") {
      throw new HostError({ code: -32602, message: "Malformed wallet request." });
    }
    // Enforced here as well as page-side. This is the signing surface the
    // wrapper exposes to whatever reaches the channel, and a pass-through host
    // is one publishing `eth_sign` to it.
    if (!isAllowedWalletMethod(method)) {
      throw new HostError(unsupportedMethod(method));
    }
    const handlers = getHandlers();
    if (!handlers.walletRequest) {
      throw new HostError(unsupportedMethod(BRIDGE_METHOD.WALLET_REQUEST));
    }
    return handlers.walletRequest(caip27 as Caip27Params);
  }

  async function dispatch(envelope: RequestEnvelope): Promise<void> {
    const { id, method, params } = envelope;
    let submitting = false;
    try {
      switch (method) {
        case BRIDGE_METHOD.HELLO: {
          const hello = params as HelloParams | undefined;
          if (hello && typeof hello.modalVersion === "string") {
            onHello?.(hello);
          }
          connected = true;
          const result: HelloResult = {
            protocol: PROTOCOL_VERSION,
            host: options.host,
            capabilities: deriveCapabilities(getHandlers()),
            config: options.getConfig(),
            wallet: options.getWallet(),
          };
          respond(id, result);
          return;
        }
        case BRIDGE_METHOD.WALLET_REQUEST: {
          const inner = (params as Caip27Params | undefined)?.request?.method;
          submitting =
            typeof inner === "string" &&
            SUBMITTING_WALLET_METHODS.includes(inner);
          respond(id, await handleWalletRequest(params));
          return;
        }
        case BRIDGE_METHOD.SEND_TRANSACTION: {
          const handlers = getHandlers();
          if (!handlers.sendTransaction) {
            fail(id, unsupportedMethod(method));
            return;
          }
          submitting = true;
          respond(
            id,
            await handlers.sendTransaction(params as SendTransactionParams),
          );
          return;
        }
        case BRIDGE_METHOD.SIGN_RECOVERY: {
          const handlers = getHandlers();
          if (!handlers.signRecovery) {
            fail(id, unsupportedMethod(method));
            return;
          }
          respond(
            id,
            await handlers.signRecovery(params as SignRecoveryParams),
          );
          return;
        }
        case BRIDGE_METHOD.OPEN_URL: {
          const handlers = getHandlers();
          if (!handlers.openUrl) {
            fail(id, unsupportedMethod(method));
            return;
          }
          const url = (params as OpenUrlParams | undefined)?.url;
          // The page only sends a URL from its own provider allow-list, but a
          // host that forwards this to an OS-level open without checking has
          // published an app-launch primitive — `intent://`, a custom scheme —
          // to whatever reaches the channel.
          if (typeof url !== "string" || !url.startsWith("https://")) {
            fail(id, {
              code: -32602,
              message: "The payment page address is not a secure link.",
            });
            return;
          }
          await handlers.openUrl({ url });
          // Deliberately empty: the page acts on the ack.
          respond(id, {});
          return;
        }
        default:
          fail(id, unsupportedMethod(method));
      }
    } catch (error) {
      fail(id, toBridgeError(error, submitting));
    }
  }

  function onEnvelope(envelope: Envelope): void {
    if (envelope.kind === "event") {
      if (envelope.type === "ui.state") {
        // Dropped rather than forwarded, so nothing downstream has to wonder
        // whether the lock it is reading is shaped like one. A full snapshot
        // arrives on every change, so the next one heals this.
        if (!isUiState(envelope.payload)) {
          stats["bad-ui-state"] += 1;
          return;
        }
        uiState = envelope.payload;
      }
      onEvent?.(envelope.type, envelope.payload);
      return;
    }
    if (envelope.kind === "request") {
      void dispatch(envelope);
      return;
    }
    const settle = pending.get(envelope.id);
    if (!settle) {
      stats["unmatched-response"] += 1;
      return;
    }
    pending.delete(envelope.id);
    // `ui.back` is the only host→page request, and its failure arm means the
    // same thing to us as `handled: false`: the page is not taking the
    // gesture, so the dismissal policy decides.
    settle(
      envelope.ok && typeof (envelope.result as UiBackResult)?.handled ===
        "boolean"
        ? (envelope.result as UiBackResult)
        : { handled: false },
    );
  }

  return {
    receive(raw: unknown) {
      if (closed) {
        stats.closed += 1;
        return;
      }
      const parsed = parseInboundFrame(raw);
      if (!parsed) {
        stats[typeof raw === "string" ? "foreign-frame" : "not-a-string"] += 1;
        return;
      }
      if (parsed.nonce !== nonce) {
        stats["foreign-frame"] += 1;
        return;
      }
      if (parsed.json.length > MAX_FRAME_LENGTH) {
        stats["too-large"] += 1;
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(parsed.json);
      } catch {
        stats["not-json"] += 1;
        return;
      }
      if (typeof frame !== "object" || frame === null) {
        stats["not-an-object"] += 1;
        return;
      }
      const kind = (frame as { kind?: unknown }).kind;
      if (kind !== "event" && kind !== "request" && kind !== "response") {
        stats["unknown-kind"] += 1;
        return;
      }
      onEnvelope(frame as Envelope);
    },

    back() {
      if (closed || !connected) return Promise.resolve({ handled: false });
      backCounter += 1;
      const id = `host.${backCounter}`;
      return new Promise<UiBackResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ handled: false });
        }, backTimeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        send({ kind: "request", id, method: HOST_METHOD.BACK });
      });
    },

    pushWalletState(state: WalletState) {
      // The full snapshot, never a delta.
      emit("wallet.state", state);
    },

    configure(config: EmbedConfig) {
      emit("session.configure", config);
    },

    get capabilities() {
      return deriveCapabilities(getHandlers());
    },

    get uiState() {
      return uiState;
    },

    get connected() {
      return connected;
    },

    close() {
      closed = true;
      for (const settle of pending.values()) settle({ handled: false });
      pending.clear();
    },

    stats,
  };
}
