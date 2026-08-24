/**
 * The half of the flow that has to outlive the web view.
 *
 * A deposit settles on our side, not in the page: the user funds it, and the
 * backend finishes the job whether or not anything is watching. But the sheet
 * is the only thing watching, and the OS kills a backgrounded web view
 * routinely — so a user who backgrounds the app mid-settlement comes back to a
 * blank sheet, with the deposit long since complete.
 *
 * This polls `GET /deposits` for the same recipient while the wrapper is alive,
 * which is the reopen case the history panel already covers made to work while
 * the app is merely backgrounded. No background scheduler and no push: the
 * moment the process is gone this stops, and the history panel takes over.
 */
import { VERSION_HEADER } from "./version";

export interface DepositRow {
  chain?: string;
  txHash: string;
  token?: string;
  amount?: string;
  status: string;
  targetChain?: string;
  targetToken?: string;
  sourceTxHash?: string | null;
  destinationTxHash?: string | null;
  sourceAmount?: string | null;
  destinationAmount?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
}

/**
 * Anything else — `pending`, `processing`, a status added later — is in flight.
 * Read as a closed set of *finished* states rather than a closed set of live
 * ones, so a new backend status is treated as "still going" instead of being
 * reported as a completion.
 */
export const TERMINAL_DEPOSIT_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "refunded",
];

export function isTerminal(status: string): boolean {
  return TERMINAL_DEPOSIT_STATUSES.includes(status.toLowerCase());
}

export const DEFAULT_POLL_INTERVAL_MS = 8_000;

export interface DepositWatchOptions {
  backendUrl: string;
  recipient: string;
  /** The value for `x-deposit-modal-version`, from `formatVersionHeader`. */
  versionHeader: string;
  /** Fires once per deposit, when it first reaches a terminal status. */
  onSettled: (deposit: DepositRow) => void;
  /** Every poll failure. Polling continues; a proxy blip is not an outage. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface DepositWatch {
  start(): void;
  stop(): void;
  /** One pass, for a `visibilitychange`-style nudge on return from a browser. */
  poll(): Promise<void>;
}

export function createDepositWatch(options: DepositWatchOptions): DepositWatch {
  const {
    backendUrl,
    recipient,
    versionHeader,
    onSettled,
    onError,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    limit = 20,
    fetchImpl,
  } = options;

  /**
   * Every txHash reported, so a deposit settles once however many polls see it.
   * Also seeded by the first pass — see below.
   */
  const reported = new Set<string>();
  let baselineTaken = false;
  let baselineInFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: AbortController | undefined;
  let running = false;

  // Not gated on `running`: the interval is, but an explicit poll is something
  // the caller asked for — returning from the payment browser is the case, and
  // that arrives as an app-state change rather than as a tick.
  async function poll(): Promise<void> {
    // The poll that takes the baseline must be allowed to finish. Aborting it
    // hands the baseline to a later response, and every terminal row in THAT
    // one is suppressed as history — including the deposit that settled while
    // the user was away, which is the single case this whole watch exists for.
    // Returning from the payment browser is exactly when both happen at once.
    if (!baselineTaken && baselineInFlight) return;

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    if (!baselineTaken) baselineInFlight = true;

    try {
      const url = `${backendUrl.replace(/\/$/, "")}/deposits?recipient=${encodeURIComponent(recipient)}&limit=${limit}`;
      const response = await (fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { [VERSION_HEADER]: versionHeader },
        signal: controller.signal,
      });
      if (!response.ok) {
        onError?.(new Error(`Deposit poll failed: ${response.status}`));
        return;
      }
      const body = (await response.json()) as { deposits?: DepositRow[] };
      const deposits = Array.isArray(body?.deposits) ? body.deposits : [];

      // The first pass suppresses what was ALREADY finished when the watch
      // started — the user's deposit history, which would otherwise announce
      // itself as a fresh settlement the moment the sheet opened. A row that is
      // in flight at baseline is deliberately left unreported, so the
      // completion it is heading for still fires.
      if (!baselineTaken) {
        for (const deposit of deposits) {
          if (deposit?.txHash && isTerminal(deposit.status)) {
            reported.add(deposit.txHash);
          }
        }
        baselineTaken = true;
        return;
      }

      for (const deposit of deposits) {
        if (!deposit?.txHash || reported.has(deposit.txHash)) continue;
        // A row that is new AND already terminal is the case this exists for:
        // the deposit both started and finished while the web view was dead.
        if (!isTerminal(deposit.status)) continue;
        reported.add(deposit.txHash);
        onSettled(deposit);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      onError?.(error);
    } finally {
      if (inFlight === controller) inFlight = undefined;
      // Cleared even on an abort or a failure, or a baseline that never
      // arrived would lock every later poll out.
      baselineInFlight = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void poll();
      timer = setInterval(() => void poll(), intervalMs);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      inFlight?.abort();
      inFlight = undefined;
    },
    poll,
  };
}
