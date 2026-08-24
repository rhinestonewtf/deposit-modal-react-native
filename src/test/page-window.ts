/**
 * The page, as the web view's main frame actually sees it.
 *
 * Not a mock of the bridge: the component's real injection script runs in this
 * window, the page posts through the `rhinestoneBridge` that script installs,
 * and every host→page frame arrives as the script the host injected. So a test
 * exercises the nonce, the encoder and the correlation table rather than
 * agreeing with them.
 */
import {
  BRIDGE_METHOD,
  PROTOCOL_VERSION,
  type Envelope,
  type HelloResult,
  type ResponseEnvelope,
} from "../protocol";

function run(script: string, window: Record<string, unknown>): void {
  const fn = new Function("window", script) as (w: unknown) => void;
  fn(window);
}

export class PageWindow {
  readonly window: Record<string, unknown> = {};
  /** Every host→page frame that reached the receiver, in order. */
  readonly frames: Envelope[] = [];
  private nextId = 0;

  constructor(channelScript: string, deliver: (raw: string) => void) {
    this.window.ReactNativeWebView = { postMessage: deliver };
    run(channelScript, this.window);
    // The page installs its receiver before it says hello, so a host that
    // answers synchronously is not replying into a channel that does not exist.
    this.window.__rhinestone_bridge = (json: string) => {
      this.frames.push(JSON.parse(json) as Envelope);
    };
  }

  /** Hand the host's injected script to this window. */
  apply(script: string): void {
    run(script, this.window);
  }

  post(frame: Envelope): void {
    const channel = this.window.rhinestoneBridge as
      | { postMessage(json: string): void }
      | undefined;
    if (!channel) throw new Error("the host never installed a channel");
    channel.postMessage(JSON.stringify(frame));
  }

  request(method: string, params?: unknown): string {
    this.nextId += 1;
    const id = `page.${this.nextId}`;
    this.post({ kind: "request", id, method, ...(params ? { params } : {}) });
    return id;
  }

  hello(): string {
    return this.request(BRIDGE_METHOD.HELLO, {
      protocol: PROTOCOL_VERSION,
      modalVersion: "0.13.0",
    });
  }

  emit(type: string, payload?: unknown): void {
    this.post({ kind: "event", type, ...(payload ? { payload } : {}) });
  }

  responseTo(id: string): ResponseEnvelope | undefined {
    return this.frames.find(
      (frame): frame is ResponseEnvelope =>
        frame.kind === "response" && frame.id === id,
    );
  }

  helloResult(id: string): HelloResult | undefined {
    const response = this.responseTo(id);
    return response?.ok ? (response.result as HelloResult) : undefined;
  }

  /** Host→page requests, which is only ever `ui.back`. */
  hostRequests(): Extract<Envelope, { kind: "request" }>[] {
    return this.frames.filter(
      (frame): frame is Extract<Envelope, { kind: "request" }> =>
        frame.kind === "request",
    );
  }

  hostEvents(): Extract<Envelope, { kind: "event" }>[] {
    return this.frames.filter(
      (frame): frame is Extract<Envelope, { kind: "event" }> =>
        frame.kind === "event",
    );
  }
}
