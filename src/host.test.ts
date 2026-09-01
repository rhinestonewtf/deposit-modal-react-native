import { describe, expect, it, vi } from "vitest";

import {
  createBridgeHost,
  submissionUncertain,
  type BridgeHostHandlers,
} from "./host";
import { createPageDouble } from "./test/page-double";
import {
  BRIDGE_ERROR_DOMAIN,
  BRIDGE_METHOD,
  BridgeErrorCode,
  CAPABILITY,
  HOST_METHOD,
  PROTOCOL_VERSION,
  type EmbedConfig,
  type Envelope,
  type HelloResult,
  type ResponseEnvelope,
  type WalletState,
} from "./protocol";

const NONCE = "0123456789abcdef";

const CONFIG: EmbedConfig = {
  mode: "deposit",
  backendUrl: "https://proxy.example/deposit",
  recipient: "0x2222222222222222222222222222222222222222",
  targetChain: 8453,
  targetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const WALLET: WalletState = {
  isReady: true,
  isConnected: true,
  accounts: [{ caip10: "eip155:8453:0x1111111111111111111111111111111111111111" }],
  chainId: "eip155:8453",
  name: "Test Wallet",
};

function setup(handlers: BridgeHostHandlers = {}) {
  const page = createPageDouble(NONCE);
  const host = createBridgeHost({
    post: page.post,
    nonce: NONCE,
    host: { platform: "ios", app: "TestApp", version: "1.0.0" },
    getConfig: () => CONFIG,
    getWallet: () => WALLET,
    getHandlers: () => handlers,
  });
  return { page, host };
}

function hello(id = "1"): Envelope {
  return {
    kind: "request",
    id,
    method: BRIDGE_METHOD.HELLO,
    params: { protocol: PROTOCOL_VERSION, modalVersion: "0.13.0" },
  };
}

function walletRequest(method: string, id = "2"): Envelope {
  return {
    kind: "request",
    id,
    method: BRIDGE_METHOD.WALLET_REQUEST,
    params: { chainId: "eip155:8453", request: { method } },
  };
}

function lastResponse(frames: Envelope[]): ResponseEnvelope {
  const responses = frames.filter(
    (frame): frame is ResponseEnvelope => frame.kind === "response",
  );
  const last = responses[responses.length - 1];
  if (!last) throw new Error("no response frame");
  return last;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("handshake", () => {
  it("answers hello with the host identity, config and wallet", async () => {
    const { page, host } = setup();
    page.send(host, hello());
    await settle();

    const response = lastResponse(page.frames);
    expect(response.ok).toBe(true);
    const result = (response as { result: HelloResult }).result;
    expect(result.protocol).toBe(PROTOCOL_VERSION);
    expect(result.host).toEqual({
      platform: "ios",
      app: "TestApp",
      version: "1.0.0",
    });
    expect(result.config).toEqual(CONFIG);
    expect(result.wallet).toEqual(WALLET);
    expect(host.connected).toBe(true);
  });

  it("reports the page's own version, so the pair can be attributed", async () => {
    const onHello = vi.fn();
    const page = createPageDouble(NONCE);
    const host = createBridgeHost({
      post: page.post,
      nonce: NONCE,
      host: { platform: "android" },
      getConfig: () => CONFIG,
      getWallet: () => WALLET,
      getHandlers: () => ({}),
      onHello,
    });
    page.send(host, hello());
    await settle();

    expect(onHello).toHaveBeenCalledWith({
      protocol: PROTOCOL_VERSION,
      modalVersion: "0.13.0",
    });
  });

  it("reads config at handshake time, not at construction", async () => {
    const page = createPageDouble(NONCE);
    let config: EmbedConfig = { ...CONFIG, theme: { mode: "light" } };
    const host = createBridgeHost({
      post: page.post,
      nonce: NONCE,
      host: { platform: "ios" },
      getConfig: () => config,
      getWallet: () => WALLET,
      getHandlers: () => ({}),
    });
    config = { ...CONFIG, theme: { mode: "dark" } };
    page.send(host, hello());
    await settle();

    const result = (lastResponse(page.frames) as { result: HelloResult }).result;
    expect(result.config.theme?.mode).toBe("dark");
  });
});

describe("capabilities", () => {
  it("derives them from the handlers rather than taking a list", () => {
    const { host } = setup({
      sendTransaction: () => ({ txHash: `0x${"1".repeat(64)}` }),
      openUrl: () => undefined,
    });
    expect(host.capabilities).toEqual([
      CAPABILITY.SEND_TRANSACTION,
      CAPABILITY.OPEN_URL,
      // Unconditional: it has no handler, and announcing it is what lets the
      // page send the probe this host is built to ignore.
      CAPABILITY.PROBE_FRAME_SCOPE,
    ]);
  });

  it("never answers the frame-scope probe, because it carries no nonce", async () => {
    const { page, host } = setup();
    const before = page.frames.length;
    // Exactly what a sub-frame can do: reach the channel without the nonce
    // only the main frame was given. Answering would tell the page this host
    // acts on sub-frame traffic, and cost it the wallet.
    host.receive(
      JSON.stringify({
        kind: "request",
        id: "probe-1",
        method: BRIDGE_METHOD.PROBE_FRAME_SCOPE,
        params: {},
      }),
    );
    await Promise.resolve();
    expect(page.frames).toHaveLength(before);
  });

  it("answers 4200 for a capability the host did not announce", async () => {
    const { page, host } = setup();
    page.send(host, {
      kind: "request",
      id: "9",
      method: BRIDGE_METHOD.SIGN_RECOVERY,
      params: {
        chainId: 8453,
        signer: "0x1111111111111111111111111111111111111111",
        depositId: "1",
        destination: "0x2222222222222222222222222222222222222222",
      },
    });
    await settle();

    const response = lastResponse(page.frames);
    expect(response.ok).toBe(false);
    expect((response as { error: { code: number } }).error.code).toBe(4200);
  });
});

describe("the wallet allowlist", () => {
  it("refuses a method the page would never send, without calling the wallet", async () => {
    const walletHandler = vi.fn();
    const { page, host } = setup({ walletRequest: walletHandler });
    page.send(host, walletRequest("eth_sign"));
    await settle();

    expect(walletHandler).not.toHaveBeenCalled();
    const response = lastResponse(page.frames);
    expect(response.ok).toBe(false);
    expect((response as { error: { code: number } }).error.code).toBe(4200);
  });

  it("forwards one the page does send", async () => {
    const walletHandler = vi.fn().mockResolvedValue("0x2105");
    const { page, host } = setup({ walletRequest: walletHandler });
    page.send(host, walletRequest("eth_chainId"));
    await settle();

    expect(walletHandler).toHaveBeenCalledOnce();
    expect(lastResponse(page.frames)).toMatchObject({ ok: true, result: "0x2105" });
  });
});

describe("a frame from outside the main frame", () => {
  it("is dropped when it carries no nonce", async () => {
    const walletHandler = vi.fn();
    const { page, host } = setup({ walletRequest: walletHandler });
    page.sendUnscoped(host, walletRequest("eth_sendTransaction"));
    await settle();

    expect(walletHandler).not.toHaveBeenCalled();
    expect(page.frames).toHaveLength(0);
    expect(host.stats["foreign-frame"]).toBe(1);
  });

  it("is dropped when it carries the wrong nonce", async () => {
    const walletHandler = vi.fn();
    const { host } = setup({ walletRequest: walletHandler });
    host.receive(`deadbeef|${JSON.stringify(walletRequest("eth_accounts"))}`);
    await settle();

    expect(walletHandler).not.toHaveBeenCalled();
    expect(host.stats["foreign-frame"]).toBe(1);
  });
});

describe("errors", () => {
  it("fails a send safe: an unknown throw becomes SUBMISSION_UNCERTAIN, never -32603", async () => {
    const { page, host } = setup({
      sendTransaction: () => {
        throw new Error("SDK exploded");
      },
    });
    page.send(host, {
      kind: "request",
      id: "3",
      method: BRIDGE_METHOD.SEND_TRANSACTION,
      params: {
        chainId: 8453,
        token: "0x0000000000000000000000000000000000000000",
        amount: "1",
        to: "0x2222222222222222222222222222222222222222",
        from: "0x1111111111111111111111111111111111111111",
      },
    });
    await settle();

    const error = (lastResponse(page.frames) as { error: unknown }).error as {
      code: number;
      domain?: string;
    };
    expect(error.code).toBe(BridgeErrorCode.SUBMISSION_UNCERTAIN);
    expect(error.domain).toBe(BRIDGE_ERROR_DOMAIN);
  });

  it("does not reach for that code when nothing could have moved", async () => {
    const { page, host } = setup({
      signRecovery: () => {
        throw new Error("no key");
      },
    });
    page.send(host, {
      kind: "request",
      id: "4",
      method: BRIDGE_METHOD.SIGN_RECOVERY,
      params: {
        chainId: 8453,
        signer: "0x1111111111111111111111111111111111111111",
        depositId: "1",
        destination: "0x2222222222222222222222222222222222222222",
      },
    });
    await settle();

    const error = (lastResponse(page.frames) as { error: unknown }) as {
      error: { code: number; domain?: string };
    };
    expect(error.error.code).toBe(-32603);
    expect(error.error.domain).toBeUndefined();
  });

  it("carries a HostError's domain through, so a bridge code stays one", async () => {
    const { page, host } = setup({
      walletRequest: () => {
        throw submissionUncertain();
      },
    });
    page.send(host, walletRequest("eth_sendTransaction"));
    await settle();

    const error = (lastResponse(page.frames) as { error: unknown }) as {
      error: { code: number; domain?: string };
    };
    expect(error.error.code).toBe(BridgeErrorCode.SUBMISSION_UNCERTAIN);
    expect(error.error.domain).toBe(BRIDGE_ERROR_DOMAIN);
  });
});

describe("host.openUrl", () => {
  it("refuses anything that is not https", async () => {
    const openUrl = vi.fn();
    const { page, host } = setup({ openUrl });
    page.send(host, {
      kind: "request",
      id: "5",
      method: BRIDGE_METHOD.OPEN_URL,
      params: { url: "intent://evil" },
    });
    await settle();

    expect(openUrl).not.toHaveBeenCalled();
    expect(lastResponse(page.frames).ok).toBe(false);
  });

  it("acks once the browser is asked for", async () => {
    const openUrl = vi.fn();
    const { page, host } = setup({ openUrl });
    page.send(host, {
      kind: "request",
      id: "6",
      method: BRIDGE_METHOD.OPEN_URL,
      params: { url: "https://pay.example/checkout" },
    });
    await settle();

    expect(openUrl).toHaveBeenCalledWith({ url: "https://pay.example/checkout" });
    expect(lastResponse(page.frames)).toMatchObject({ ok: true, result: {} });
  });
});

describe("ui.back", () => {
  it("resolves with what the page answered", async () => {
    const { page, host } = setup();
    page.send(host, hello());
    await settle();

    const pending = host.back();
    await settle();
    const request = page.frames.find(
      (frame) => frame.kind === "request" && frame.method === HOST_METHOD.BACK,
    );
    expect(request).toBeDefined();
    page.send(host, {
      kind: "response",
      id: (request as { id: string }).id,
      ok: true,
      result: { handled: true },
    });

    await expect(pending).resolves.toEqual({ handled: true });
  });

  it("does not swallow the gesture when the page never answers", async () => {
    vi.useFakeTimers();
    const page = createPageDouble(NONCE);
    const host = createBridgeHost({
      post: page.post,
      nonce: NONCE,
      host: { platform: "android" },
      getConfig: () => CONFIG,
      getWallet: () => WALLET,
      getHandlers: () => ({}),
      backTimeoutMs: 50,
    });
    page.send(host, hello());
    await vi.advanceTimersByTimeAsync(0);

    const pending = host.back();
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toEqual({ handled: false });
    vi.useRealTimers();
  });

  it("is a no-op before the handshake, when there is nothing to ask", async () => {
    const { host } = setup();
    await expect(host.back()).resolves.toEqual({ handled: false });
  });
});

describe("frames that do not fit", () => {
  it("counts them and stays a host", async () => {
    const { page, host } = setup();
    page.sendRaw(host, { kind: "event" });
    page.sendRaw(host, `${NONCE}|not json`);
    page.sendRaw(host, `${NONCE}|"a string"`);
    page.sendRaw(host, `${NONCE}|{"kind":"telegram"}`);
    page.send(host, { kind: "response", id: "nobody", ok: true, result: 1 });
    await settle();

    expect(host.stats["not-a-string"]).toBe(1);
    expect(host.stats["not-json"]).toBe(1);
    expect(host.stats["not-an-object"]).toBe(1);
    expect(host.stats["unknown-kind"]).toBe(1);
    expect(host.stats["unmatched-response"]).toBe(1);
    expect(page.frames).toHaveLength(0);
  });

  it("drops a lock it cannot read rather than letting a reader trip over it", async () => {
    const seen: string[] = [];
    const page = createPageDouble(NONCE);
    const host = createBridgeHost({
      post: page.post,
      nonce: NONCE,
      host: { platform: "ios" },
      getConfig: () => CONFIG,
      getWallet: () => WALLET,
      getHandlers: () => ({}),
      onEvent: (type) => seen.push(type),
    });

    // A page built against a different spelling of the contract. The two ship
    // separately, so this is a thing that happens rather than a hypothetical.
    page.send(host, {
      kind: "event",
      type: "ui.state",
      payload: { screen: "review" },
    });
    page.send(host, {
      kind: "event",
      type: "ui.state",
      payload: { screen: "review", dismissal: { state: "maybe" } },
    });
    await settle();

    expect(host.uiState).toBeUndefined();
    expect(host.stats["bad-ui-state"]).toBe(2);
    // Not forwarded either: a consumer reading the lock should never receive
    // one it has to check for itself.
    expect(seen).toEqual([]);
  });

  it("tracks the last ui.state snapshot", async () => {
    const { page, host } = setup();
    page.send(host, {
      kind: "event",
      type: "ui.state",
      payload: {
        screen: "review",
        dismissal: {
          state: "blocked",
          reason: "submission-in-flight",
          message: "Finishing up",
        },
      },
    });
    await settle();

    expect(host.uiState?.dismissal.state).toBe("blocked");
  });
});
