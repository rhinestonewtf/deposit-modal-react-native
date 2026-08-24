/**
 * The wire contract, from the host's side.
 *
 * This is a hand-maintained copy of `src/core/bridge/protocol.ts` in
 * `rhinestonewtf/deposit-modal`, which is the spec. It is a copy rather than an
 * import because the page's package is a browser library — importing it would
 * drag `react-dom`, `wagmi` and `@reown/appkit` into a React Native app that
 * must never resolve them — and because the Swift and Android wrappers have to
 * re-declare the same thing anyway. Three copies is the shape of the problem,
 * not a shortcut.
 *
 * Nothing yet stops the copies drifting, and discipline is not a plan for four
 * of them. What should: `deposit-modal` publishes the frame sequences its mock
 * host exchanges with the page, and each wrapper replays that transcript in its
 * own CI, so a renamed method or a changed error code fails there rather than
 * on a device. It is not built — RHI-5994 is where it falls out, because this
 * is the wrapper that first has to agree with the page about anything.
 *
 * The page's own compatibility rules, restated because this side has to honour
 * them too: an existing field never changes meaning or type, new fields are
 * optional, an unknown event is dropped, and an unknown method answers 4200.
 */

/** What this wrapper speaks, announced in `HelloResult.protocol`. */
export const PROTOCOL_VERSION = 2;

// -- channel ----------------------------------------------------------------

/**
 * Page→host: the page calls `window.rhinestoneBridge.postMessage(json)`.
 * Host→page: the host calls `window.__rhinestone_bridge(json)`.
 *
 * Both directions carry a JSON string, never an object. Android's
 * `addJavascriptInterface` cannot pass anything else, and the page drops a
 * non-string frame rather than coercing it — an object would otherwise arrive
 * as `"[object Object]"` and read as malformed rather than as the wrong type.
 */
export const PAGE_TO_HOST_CHANNEL = "rhinestoneBridge";
export const HOST_TO_PAGE_CHANNEL = "__rhinestone_bridge";

/**
 * Largest frame this host will parse, in UTF-16 code units. Mirrors the page's
 * own cap so neither side spends `JSON.parse` on something the other would
 * never send; the biggest legitimate frame either way is an EIP-712 struct.
 */
export const MAX_FRAME_LENGTH = 256 * 1024;

// -- envelope ---------------------------------------------------------------

export interface EventEnvelope {
  kind: "event";
  type: string;
  payload?: unknown;
}

export interface RequestEnvelope {
  kind: "request";
  id: string;
  method: string;
  params?: unknown;
}

export type ResponseEnvelope = {
  kind: "response";
  id: string;
} & ({ ok: true; result: unknown } | { ok: false; error: BridgeError });

export type Envelope = EventEnvelope | RequestEnvelope | ResponseEnvelope;

export interface BridgeError {
  code: number;
  /** Rendered to the user, and wallet-controlled — a chain-switch refusal shows
   *  this text verbatim. Cap and escape it wherever it is interpolated. */
  message: string;
  /** Present only on a bridge-specific code; absent means an EIP-1193 or
   *  JSON-RPC code passed through untranslated. */
  domain?: typeof BRIDGE_ERROR_DOMAIN;
  /**
   * A short, already-redacted diagnostic. Never rendered.
   *
   * **Never log a whole frame.** The obvious way to debug a new wrapper writes
   * the handshake to the device log, and the handshake carries the backend URL.
   * Log this field and the method, nothing else.
   */
  data?: string;
}

// -- method registry --------------------------------------------------------

export const BRIDGE_METHOD = {
  /** Page→host, first frame of the session. Answers `HelloResult`. */
  HELLO: "hello",
  /** Page→host: a CAIP-27 wallet request, `Caip27Params`. */
  WALLET_REQUEST: "wallet.request",
  /** Page→host: withdraw's transfer. Gated by `CAPABILITY.SEND_TRANSACTION`. */
  SEND_TRANSACTION: "host.sendTransaction",
  /** Page→host: claim's signature. Gated by `CAPABILITY.SIGN_RECOVERY`. */
  SIGN_RECOVERY: "host.signRecovery",
  /** Page→host: show a payment page outside the web view. Gated by
   *  `CAPABILITY.OPEN_URL`. */
  OPEN_URL: "host.openUrl",
} as const;

export type BridgeMethod = (typeof BRIDGE_METHOD)[keyof typeof BRIDGE_METHOD];

export const HOST_METHOD = {
  /** Host→page: Android's hardware back and iOS's interactive swipe. Answers
   *  `UiBackResult`, and the host must await it before acting. */
  BACK: "ui.back",
} as const;

export type HostMethod = (typeof HOST_METHOD)[keyof typeof HOST_METHOD];

/** A capability IS the method it gates, so the two cannot drift apart. */
export const CAPABILITY = {
  SEND_TRANSACTION: BRIDGE_METHOD.SEND_TRANSACTION,
  SIGN_RECOVERY: BRIDGE_METHOD.SIGN_RECOVERY,
  OPEN_URL: BRIDGE_METHOD.OPEN_URL,
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

// -- handshake --------------------------------------------------------------

export interface HelloParams {
  protocol: number;
  /** The page's own version. Reused verbatim as the version header on any
   *  request this wrapper makes on the session's behalf, so the two are
   *  attributed as one thing at the processor. */
  modalVersion: string;
}

export interface HelloResult {
  protocol: number;
  host: {
    platform: "ios" | "android" | "other";
    app?: string;
    version?: string;
  };
  /**
   * The optional vocabulary this host implements. Unlisted means the page must
   * not send it; a host that receives one anyway answers 4200.
   */
  capabilities: readonly string[];
  config: EmbedConfig;
  /** Initial snapshot, so wallet state is not a separate race after hello. */
  wallet: WalletState;
}

export type EmbedMode = "deposit" | "withdraw" | "claim";

/**
 * EVM chain id, or a CAIP-2 string for a non-EVM target.
 *
 * Loosely typed on purpose: the page hashes this value into the account salt,
 * so its *spelling* is a deposit address. A union of the ids we happen to know
 * today would either reject a chain the backend has since added or invite a
 * wrapper release for each one.
 */
export type TargetChain = number | string;

export interface OutputTokenRule {
  match: {
    chain?: string;
    token?: string;
    symbol?: string;
  };
  outputToken: string;
}

/** Which Swapped payment groups the fiat on-ramp offers; omit to offer all. */
export interface FiatMethodsConfig {
  creditcard?: boolean;
  "bank-transfer"?: boolean;
  "apple-pay"?: boolean;
}

export interface DepositModalTheme {
  /**
   * Absent means light, unconditionally — never "follow the OS". `"system"`
   * asks the page to read `prefers-color-scheme`, which inside a web view is
   * not the same question on both platforms: iOS reports the app's effective
   * appearance, and Android reports the WebView theme's `isLightTheme`, which
   * is light whenever the app never declared one. An app that knows its own
   * appearance should send `"light"` or `"dark"` and re-send on change.
   */
  mode?: "light" | "dark" | "system";
  radius?: "none" | "sm" | "md" | "lg" | "full";
  fontColor?: string;
  iconColor?: string;
  ctaColor?: string;
  ctaHoverColor?: string;
  borderColor?: string;
  backgroundColor?: string;
}

export interface DepositModalUIConfig {
  showBackButton?: boolean;
  maxDepositUsd?: number;
  minDepositUsd?: number;
  feeSponsored?: boolean;
  feeTooltip?: string;
}

/**
 * Every prop that survives a JSON hop. Names match the web modal's React props
 * 1:1 — this is a transport, not a redesign.
 *
 * Config crosses the bridge and never the URL: a public URL taking a recipient
 * and a backend URL is a phishing surface, and it would put keyed endpoints
 * into URL bars and device logs.
 */
export interface EmbedConfig {
  mode: EmbedMode;

  backendUrl: string;
  recipient: string;
  targetChain: TargetChain;
  targetToken: string;

  sourceChain?: number;
  sourceToken?: string;
  /** USD amount, or the case-insensitive sentinel `"max"`. */
  defaultAmount?: string;
  appBalanceUsd?: number;

  outputTokenRules?: OutputTokenRule[];
  rejectUnmapped?: boolean;
  forceRegister?: boolean;

  enableWallet?: boolean;
  enableFiatOnramp?: boolean;
  enableQrTransfer?: boolean;
  enableGaslessDeposit?: boolean;
  enableExchangeConnect?: boolean;
  fiatMethods?: FiatMethodsConfig;
  assetMigrations?: Record<string, unknown>;
  initialAssetMigration?: string;

  /** Not a mount-time value: appearance can change while the sheet is open, and
   *  a host that tracks it re-sends its config over `session.configure`. */
  theme?: DepositModalTheme;
  uiConfig?: DepositModalUIConfig;
  debug?: boolean;

  /** Withdraw only. */
  accountAddress?: string;

  /** Claim only: prefills the lookup form. */
  defaultTxHash?: string;
  /** Claim only: seeds the refund destination, which the user can still edit. */
  defaultDestination?: string;
}

// -- events -----------------------------------------------------------------

export type PageEventType =
  | "ready"
  | "lifecycle"
  | "analytics"
  | "error"
  | "ui.state"
  | "wallet.connectRequested"
  | "wallet.disconnectRequested"
  | "dismissRequested";

export type HostEventType = "session.configure" | "wallet.state";

export interface DismissRequestedPayload {
  source: "close-button" | "flow-complete" | "back-past-first-screen";
}

/**
 * Events are at-least-once and a host must be idempotent.
 *
 * This is a property the page already has rather than a rule imposed on it:
 * errors carry no dedupe at all, so a backend outage streams one per poll. A
 * host that toasts per error event will show hundreds. Key terminal state on
 * the transaction hash.
 */

// -- wallet channel ---------------------------------------------------------

export interface WalletState {
  /** `false` makes the page show "connecting" rather than a connect prompt. */
  isReady: boolean;
  isConnected: boolean;
  accounts: { caip10: string }[];
  /**
   * The wallet's selected EVM chain, CAIP-2. `null` means no wallet, or not
   * connected yet — a *connected* host must report one, or the page shows no
   * wallet row rather than a degraded one.
   */
  chainId: string | null;
  icon?: string;
  name?: string;
}

/** CAIP-27 shaped, so native wallet SDKs forward rather than translate. */
export interface Caip27Params {
  /**
   * Authoritative for this request — the chain the host must execute it on,
   * not a report of where the wallet currently is.
   */
  chainId: string;
  request: { method: string; params?: unknown };
}

/**
 * The complete set of methods the page will ever send.
 *
 * Enforced here as well as page-side, and that is not redundancy: this list is
 * the signing surface the wrapper exposes to whatever reaches the channel, and
 * a host that forwards blindly is publishing `eth_sign` to it.
 *
 * `eth_chainId`, `eth_accounts` and `wallet_sendTransaction` are on it because
 * viem calls them itself while sending a transaction. Omitting one refuses the
 * page's own deposit, and the refusal surfaces as "An unknown RPC error
 * occurred" with the wallet's real message destroyed.
 */
export const ALLOWED_WALLET_METHODS = [
  "eth_chainId",
  "eth_accounts",
  "eth_sendTransaction",
  "wallet_sendTransaction",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
] as const;

export type AllowedWalletMethod = (typeof ALLOWED_WALLET_METHODS)[number];

export function isAllowedWalletMethod(
  method: string,
): method is AllowedWalletMethod {
  return (ALLOWED_WALLET_METHODS as readonly string[]).includes(method);
}

/** Methods whose failure may already have moved funds. */
export const SUBMITTING_WALLET_METHODS: readonly string[] = [
  "eth_sendTransaction",
  "wallet_sendTransaction",
];

// -- errors -----------------------------------------------------------------

/**
 * EIP-1193 codes pass through unchanged: 4001 user rejected, 4100 unauthorized,
 * 4200 unsupported method, 4900 disconnected, 4902 unrecognized chain. So do
 * JSON-RPC's -32602 and -32603.
 *
 * **Never answer a send with -32603.** viem retries that code three times on
 * its own, and a retried `eth_sendTransaction` is a second broadcast of the
 * same transfer. A send the host could not complete is 4001 if the user
 * refused it, and `SUBMISSION_UNCERTAIN` if it cannot tell.
 */
export const BRIDGE_ERROR_DOMAIN = "bridge";

export const BridgeErrorCode = {
  /** A wallet exists but cannot be reached — app not installed, session
   *  dropped mid-request. Distinct from 4900, which means not connected. */
  WALLET_UNAVAILABLE: 1,
  /**
   * The host cannot say whether the transaction reached the network.
   *
   * An app switch can be killed by the OS between wallet submission and the
   * return trip. Without a code for it the host must lie in one direction or
   * the other, and the safe-looking lie — reporting failure — is the one that
   * double-spends.
   */
  SUBMISSION_UNCERTAIN: 2,
  /** The page's own deadline expired. Raised page-side, never sent by a host. */
  REQUEST_TIMEOUT: 3,
  /** The channel went away with the request outstanding. */
  CHANNEL_CLOSED: 4,
  /** The host answered, but not with something the method can return. */
  MALFORMED_RESULT: 5,
} as const;

export type BridgeErrorCodeValue =
  (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode];

export function bridgeError(
  code: BridgeErrorCodeValue,
  message: string,
  data?: string,
): BridgeError {
  return { domain: BRIDGE_ERROR_DOMAIN, code, message, ...(data ? { data } : {}) };
}

/** EIP-1193 4200. The answer to every method this host does not implement. */
export function unsupportedMethod(method: string): BridgeError {
  return { code: 4200, message: `Unsupported method: ${method}` };
}

// -- dismissal lock ---------------------------------------------------------

/**
 * Full snapshot, emitted whenever any field changes rather than only on
 * navigation, so a dropped frame self-heals on the next one. The lock is
 * derived state, never a command.
 */
export interface UiStatePayload {
  /** Stable screen id. Usable for a sheet title or telemetry; never branch
   *  payment logic on it. */
  screen: string;
  dismissal: DismissalPolicy;
}

export type DismissalPolicy =
  | { state: "allowed" }
  /**
   * Refuse dismissal outright. At these moments the answer is not the user's to
   * give: closing resets the flow, the page has no storage of its own, and a
   * third-party payment session handle cannot be reconstructed.
   *
   * A lock is never open-ended — every request the page blocks on carries a
   * deadline it enforces itself, so a host that drops a request cannot produce
   * a sheet the user cannot close.
   */
  | { state: "blocked"; reason: BlockedReason; message: string };

export type BlockedReason =
  | "wallet-request-pending"
  | "submission-in-flight"
  | "provider-session-active"
  | "settlement-in-progress";

export interface UiBackResult {
  /**
   * `true` — do nothing. Either the page went back a step, or it refused the
   * gesture because the last dismissal policy was `blocked`.
   *
   * `false` — the page had nowhere to go; the host may dismiss, subject to the
   * last dismissal policy.
   */
  handled: boolean;
}

// -- withdraw and claim -----------------------------------------------------

export interface SendTransactionParams {
  chainId: number;
  /**
   * ERC-20 address, or the zero address for the chain's native asset. Spelled
   * out because it is not the EIP-7528 `0xeee…eee` a host would reasonably
   * guess, and a host that guesses transfers a nonexistent token rather than
   * failing.
   */
  token: string;
  /** Base units as a decimal string. No bigint crosses the wire. */
  amount: string;
  /** Authoritative destination. Never substitute your own. */
  to: string;
  /** The account the funds must leave. */
  from: string;
}

export const NATIVE_TOKEN_ADDRESS =
  "0x0000000000000000000000000000000000000000";

export interface SendTransactionResult {
  /** On-chain transaction hash, not a user-operation hash or bundler id —
   *  progress is tracked by looking the deposit up by this value. */
  txHash: string;
}

/**
 * The struct `host.signRecovery` authorizes, compiled in rather than taken over
 * the wire.
 *
 * **This is the whole security boundary of that method.** A free-form
 * `typedData` on the wire would make it mean "sign anything" — a Permit2
 * transfer, an ERC-2612 permit — to a host that opted into believing it narrow.
 * Nothing on this side could tell the difference. Signing these fields bounds a
 * page compromise to "refund my own failed deposit to the wrong address".
 *
 * The domain carries no `chainId` and no `verifyingContract`, so a signature is
 * replayable across chains and environments for the same `depositId`. That is a
 * property of the struct the page already signs, not one the bridge introduces.
 */
export const SIGN_RECOVERY_DOMAIN = {
  name: "Rhinestone Deposit Recovery",
  version: "1",
} as const;

export const SIGN_RECOVERY_PRIMARY_TYPE = "RecoverDeposit";

export const SIGN_RECOVERY_TYPES = {
  RecoverDeposit: [
    { name: "depositId", type: "uint256" },
    { name: "destination", type: "address" },
  ],
} as const;

/**
 * The exact strings EIP-712 hashes. The domain one is published because its
 * field array is hashed in declared order, so a host that synthesizes its own
 * derives a different separator and produces a valid-looking wrong signature —
 * one that fails at the processor rather than at signing time.
 */
export const SIGN_RECOVERY_ENCODE_TYPE =
  "RecoverDeposit(uint256 depositId,address destination)";
export const SIGN_RECOVERY_DOMAIN_ENCODE_TYPE =
  "EIP712Domain(string name,string version)";

export interface SignRecoveryParams {
  /**
   * The chain the deposit is on, and therefore the chain the signature is
   * verified against. **Not part of the signed domain** — folding it in derives
   * a different separator and produces exactly the valid-looking wrong
   * signature the field exists to prevent.
   */
  chainId: number;
  /** The address whose verifier must accept the result: the deposit's
   *  recipient, not necessarily the connected wallet. */
  signer: string;
  /** A DECIMAL STRING. A uint256 that routinely exceeds
   *  `Number.MAX_SAFE_INTEGER`, and no bigint crosses the wire. */
  depositId: string;
  destination: string;
}

export interface SignRecoveryResult {
  /** `0x`-prefixed hex. May be an EOA signature, an ERC-1271 one, or an
   *  ERC-6492 wrap for an undeployed account — all three are hex to the page. */
  signature: string;
}

// -- the system browser -----------------------------------------------------

/**
 * Show a page outside the web view.
 *
 * **A browser container, never the web view itself and never another app.**
 * `SFSafariViewController` and Chrome Custom Tabs both present over the host,
 * so the user returns with one tap and lands where a redirect would.
 *
 * **Refuse anything but `https:`.** The page only sends a URL from its own
 * provider allow-list, but a host that forwards this to an OS-level open
 * without checking has published an app-launch primitive to whatever reaches
 * the channel.
 *
 * **Answer when the browser is presented, not when it is dismissed.** A
 * dismissal-tied answer has to survive the host being killed behind Custom
 * Tabs, and a lost answer leaves the page waiting on a payment it can already
 * see the result of.
 */
export interface OpenUrlParams {
  url: string;
}

export type OpenUrlResult = Record<string, never>;
