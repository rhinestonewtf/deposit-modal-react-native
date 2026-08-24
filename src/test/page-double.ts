/**
 * The page's side of the channel, as a test double.
 *
 * It runs the host's injected script rather than reading the envelope out of a
 * captured argument, so the encoder is exercised on every test in this package
 * instead of only in its own. That seam — a frame that is a valid envelope but
 * an invalid JS statement — is the one a mocked `post` cannot fail on.
 */
import { NONCE_SEPARATOR } from "../injection";
import type { Envelope } from "../protocol";

export interface PageDouble {
  /** Hand this to `createBridgeHost`. */
  post: (script: string) => void;
  /** Every host→page frame, in order. */
  readonly frames: Envelope[];
  /** Post a frame as the main frame would. */
  send(host: { receive: (raw: unknown) => void }, frame: Envelope): void;
  /** Post a frame as a sub-frame would: no nonce prefix. */
  sendUnscoped(
    host: { receive: (raw: unknown) => void },
    frame: Envelope,
  ): void;
  /** Post something that is not an envelope at all. */
  sendRaw(host: { receive: (raw: unknown) => void }, raw: unknown): void;
}

export function createPageDouble(nonce: string): PageDouble {
  const frames: Envelope[] = [];
  const receiver = (json: string) => {
    frames.push(JSON.parse(json) as Envelope);
  };

  return {
    post(script: string) {
      // `new Function` rather than `eval` so the script sees only the window we
      // hand it, which is what the web view's main frame sees too.
      const run = new Function("window", script) as (window: unknown) => void;
      run({ __rhinestone_bridge: receiver });
    },
    frames,
    send(host, frame) {
      host.receive(`${nonce}${NONCE_SEPARATOR}${JSON.stringify(frame)}`);
    },
    sendUnscoped(host, frame) {
      host.receive(JSON.stringify(frame));
    },
    sendRaw(host, raw) {
      host.receive(raw);
    },
  };
}
