/**
 * The sheet itself, against a real page.
 *
 * The component's own injection script runs in the page double's window, so
 * every frame in here crosses the nonce, the encoder and the correlation table.
 * What is mocked is React Native and the web view — the things a simulator
 * would otherwise be required for — and nothing about the bridge.
 *
 * Both rounds of review blockers landed in this file's effects, which is what
 * it is here to cover: a session that must survive a parent's re-render, a
 * reload allowance that must not survive the session, and a watch that has to
 * follow a config it was not born with.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const { native } = await import("./test/native-probe");
  const passthrough = (name: string) =>
    function Passthrough(props: { children?: React.ReactNode }) {
      return ReactModule.createElement(name, null, props.children ?? null);
    };
  return {
    Platform: {
      get OS() {
        return native.platformOS;
      },
    },
    Modal: function Modal(props: Record<string, unknown>) {
      native.modal.props = props;
      return props.visible
        ? ReactModule.createElement(
            "Modal",
            null,
            props.children as React.ReactNode,
          )
        : null;
    },
    View: passthrough("View"),
    ActivityIndicator: passthrough("ActivityIndicator"),
    StyleSheet: {
      create: <T,>(sheet: T) => sheet,
      absoluteFillObject: {},
    },
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        native.backHandlers.push(handler);
        return {
          remove() {
            native.backHandlers = native.backHandlers.filter(
              (candidate) => candidate !== handler,
            );
          },
        };
      },
    },
    AppState: {
      addEventListener: (_event: string, handler: (state: string) => void) => {
        native.appStateHandlers.push(handler);
        return {
          remove() {
            native.appStateHandlers = native.appStateHandlers.filter(
              (candidate) => candidate !== handler,
            );
          },
        };
      },
    },
  };
});

vi.mock("react-native-webview", async () => {
  const ReactModule = await import("react");
  const { native } = await import("./test/native-probe");
  const WebView = ReactModule.forwardRef(function WebView(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    native.webView.props = props;
    ReactModule.useImperativeHandle(
      ref,
      () => ({
        injectJavaScript(script: string) {
          native.webView.injected.push(script);
          native.webView.onInject?.(script);
        },
        reload() {
          native.webView.reloads += 1;
        },
      }),
      [],
    );
    return null;
  });
  return { __esModule: true, default: WebView, WebView };
});

import { DepositSheet, type DepositSheetProps } from "./DepositSheet";
import { PageWindow } from "./test/page-window";
import {
  native,
  pressAndroidBack,
  resetNative,
} from "./test/native-probe";
import {
  BRIDGE_METHOD,
  CAPABILITY,
  HOST_METHOD,
  type EmbedConfig,
} from "./protocol";

const RECIPIENT_A = "0x1111111111111111111111111111111111111111";
const RECIPIENT_B = "0x2222222222222222222222222222222222222222";

const CONFIG: EmbedConfig = {
  mode: "deposit",
  backendUrl: "https://proxy.example/deposit",
  recipient: RECIPIENT_A,
  targetChain: 8453,
  targetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

type Fetches = { url: string }[];

let renderer: ReactTestRenderer | null = null;
let fetches: Fetches = [];

function mount(props: Partial<DepositSheetProps> = {}): void {
  const merged: DepositSheetProps = {
    visible: true,
    onDismiss: () => undefined,
    config: CONFIG,
    ...props,
  };
  act(() => {
    renderer = create(React.createElement(DepositSheet, merged));
  });
}

function update(props: Partial<DepositSheetProps> = {}): void {
  const merged: DepositSheetProps = {
    visible: true,
    onDismiss: () => undefined,
    config: CONFIG,
    ...props,
  };
  act(() => {
    renderer?.update(React.createElement(DepositSheet, merged));
  });
}

/** Load the page into the web view, over the component's own channel script. */
function loadPage(): PageWindow {
  const props = native.webView.props;
  if (!props) throw new Error("the web view never rendered");
  const script = props.injectedJavaScriptBeforeContentLoaded as string;
  const onMessage = props.onMessage as (event: {
    nativeEvent: { data: string };
  }) => void;
  const page = new PageWindow(script, (raw) =>
    onMessage({ nativeEvent: { data: raw } }),
  );
  native.webView.onInject = (injected) => page.apply(injected);
  return page;
}

/** Let the host's async dispatch settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  resetNative("ios");
  fetches = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    fetches.push({ url: String(url) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ deposits: [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

describe("the handshake", () => {
  it("answers the page with the capabilities the props imply", async () => {
    mount({
      sendTransaction: () => ({ txHash: `0x${"1".repeat(64)}` }),
      openUrl: () => undefined,
    });
    const page = loadPage();
    const id = page.hello();
    await flush();

    const result = page.helloResult(id);
    expect(result?.host.platform).toBe("ios");
    expect(result?.config).toEqual(CONFIG);
    expect(result?.capabilities).toEqual([
      CAPABILITY.SEND_TRANSACTION,
      CAPABILITY.OPEN_URL,
      CAPABILITY.PROBE_FRAME_SCOPE,
    ]);
  });

  it("reports ready once the page says so", async () => {
    const onReady = vi.fn();
    mount({ onReady });
    const page = loadPage();
    page.hello();
    await flush();
    page.emit("ready");
    await flush();

    expect(onReady).toHaveBeenCalledOnce();
  });
});

describe("a parent re-render", () => {
  it("does not close the bridge under a request already in flight", async () => {
    let release: (() => void) | undefined;
    const openUrl = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    // Inline arrows on every prop: the normal way to write this, and the shape
    // that used to rebuild the host on any repaint of the screen above.
    mount({ openUrl, onDismiss: () => undefined, onReady: () => undefined });
    const page = loadPage();
    page.hello();
    await flush();

    const id = page.request(BRIDGE_METHOD.OPEN_URL, {
      url: "https://pay.example/checkout",
    });
    await flush();
    expect(page.responseTo(id)).toBeUndefined();

    // Fresh identities for every callback, as a parent re-render produces.
    update({
      openUrl: (params) => openUrl(),
      onDismiss: () => undefined,
      onReady: () => undefined,
    });

    release?.();
    await flush();

    expect(page.responseTo(id)).toMatchObject({ ok: true });
  });

  it("keeps the session when a handler appears late, and reloads nothing", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    mount({ onFatal, handshakeTimeoutMs: 1_000 });
    const page = loadPage();
    page.hello();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // An app that connects its wallet after startup is the ordinary case, and
    // it used to rebuild the host under a page that had already handshaken —
    // the page then never heard another wallet push, and the handshake
    // deadline "recovered" by reloading it mid-flow.
    update({
      onFatal,
      handshakeTimeoutMs: 1_000,
      wallet: {
        state: {
          isReady: true,
          isConnected: true,
          accounts: [{ caip10: `eip155:8453:${RECIPIENT_A}` }],
          chainId: "eip155:8453",
        },
        request: () => "0x2105",
      },
      openUrl: vi.fn(),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(native.webView.reloads).toBe(0);
    expect(onFatal).not.toHaveBeenCalled();

    // The wallet the app just connected reaches the page as a push, which is
    // how wallet availability travels — it is not a capability.
    const pushed = page
      .hostEvents()
      .filter((frame) => frame.type === "wallet.state");
    expect(pushed.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  // Capabilities settle once at hello, so wallet availability is the thing that
  // rides `wallet.state`. A host that drops its wallet and pushes nothing
  // leaves the page rendering the account it last heard about, and the next
  // wallet action answers 4200 instead of the page falling back to the funding
  // paths that need no wallet.
  it("tells the page when the wallet goes away", async () => {
    const wallet = {
      state: {
        isReady: true,
        isConnected: true,
        accounts: [{ caip10: `eip155:8453:${RECIPIENT_A}` }],
        chainId: "eip155:8453",
      },
      request: () => "0x2105",
    };
    mount({ wallet, onError: () => undefined });
    const page = loadPage();
    page.hello();
    await flush();

    update({ onError: () => undefined });
    await flush();

    const pushed = page
      .hostEvents()
      .filter((frame) => frame.type === "wallet.state");
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[pushed.length - 1]!.payload).toMatchObject({
      isConnected: false,
      accounts: [],
      chainId: null,
      // Ready, not "connecting": there is no wallet coming, and the page shows
      // a spinner where it should show the paths that need none.
      isReady: true,
    });
  });

  it("keeps one session, so the page is never asked to handshake twice", async () => {
    mount({ onError: () => undefined });
    const page = loadPage();
    page.hello();
    await flush();

    const before = native.webView.reloads;
    update({ onError: () => undefined });
    update({ onError: () => undefined });

    expect(native.webView.reloads).toBe(before);
    // Still answering: a rebuilt host would have dropped the correlation table.
    const id = page.request(BRIDGE_METHOD.WALLET_REQUEST, {
      chainId: "eip155:8453",
      request: { method: "eth_sign" },
    });
    await flush();
    expect(page.responseTo(id)).toMatchObject({ ok: false });
  });
});

describe("the handshake deadline", () => {
  it("reloads once, then reports rather than spinning forever", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    mount({ onFatal, handshakeTimeoutMs: 1_000 });
    // Deliberately no page: this is the injection race the reload exists for.

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(native.webView.reloads).toBe(1);
    expect(onFatal).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("gives each session its own reload, not each mount", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    mount({ onFatal, handshakeTimeoutMs: 1_000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_200);
    });
    expect(native.webView.reloads).toBe(1);
    expect(onFatal).toHaveBeenCalledOnce();

    // Close and reopen the same mounted sheet.
    update({ onFatal, handshakeTimeoutMs: 1_000, visible: false });
    update({ onFatal, handshakeTimeoutMs: 1_000, visible: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    // A transient race in one session must not disarm recovery in the next.
    expect(native.webView.reloads).toBe(2);
    expect(onFatal).toHaveBeenCalledOnce();
  });
});

describe("the deposit watch", () => {
  it("polls for the recipient the config names now, not the one at hello", async () => {
    mount();
    const page = loadPage();
    page.hello();
    await flush();

    expect(fetches.some((call) => call.url.includes(RECIPIENT_A))).toBe(true);
    fetches = [];

    // The app switched account behind a live sheet.
    update({ config: { ...CONFIG, recipient: RECIPIENT_B } });
    await flush();

    expect(fetches.some((call) => call.url.includes(RECIPIENT_B))).toBe(true);
    expect(fetches.some((call) => call.url.includes(RECIPIENT_A))).toBe(false);
  });

  it("does not start before the page has named its version", async () => {
    mount();
    loadPage();
    await flush();

    expect(fetches).toHaveLength(0);
  });
});

describe("pinning the web view", () => {
  it("refuses a host that only looks like ours, and hands https to the browser", () => {
    const openUrl = vi.fn();
    mount({ openUrl });
    const shouldLoad = native.webView.props?.onShouldStartLoadWithRequest as (
      request: { url: string },
    ) => boolean;

    expect(shouldLoad({ url: "https://deposit.rhinestone.dev/" })).toBe(true);

    // A lookalike is not our origin, so it does not load here — but it is still
    // an ordinary external link once it is outside the web view.
    expect(shouldLoad({ url: "https://deposit.rhinestone.dev.evil.example/" })).toBe(
      false,
    );
    expect(openUrl).toHaveBeenCalledWith({
      url: "https://deposit.rhinestone.dev.evil.example/",
    });

    // Userinfo goes nowhere at all. We never mint such a URL, and handing an
    // authority two readers disagree about to an OS-level open is the thing
    // `host.openUrl` refuses in the first place.
    openUrl.mockClear();
    expect(shouldLoad({ url: "https://deposit.rhinestone.dev@evil.example/" })).toBe(
      false,
    );
    expect(shouldLoad({ url: "intent://evil" })).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves a sub-frame alone", () => {
    const openUrl = vi.fn();
    mount({ openUrl });
    const shouldLoad = native.webView.props?.onShouldStartLoadWithRequest as (
      request: { url: string; isTopFrame?: boolean },
    ) => boolean;

    // A frame load is neither a navigation away nor a tapped link. Cancelling
    // it kills whatever the page embedded, and handing it to the browser is
    // worse — the payment page would open outside the frame that is waiting
    // for it.
    expect(
      shouldLoad({ url: "https://pay.example/frame", isTopFrame: false }),
    ).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();

    // Absent means the main frame: Android never routes a sub-frame here.
    expect(shouldLoad({ url: "https://pay.example/page" })).toBe(false);
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it("never lets the web view refuse a URL itself, our own page included", () => {
    mount({ openUrl: vi.fn() });

    // `react-native-webview` hands a URL its whitelist rejects to
    // `Linking.openURL` — another app, by scheme, with no gate of ours in
    // front of it. And a `https://host/*` pattern does not match
    // `https://host`, which is what `source` carries, so a narrower list also
    // swallowed the page it was written to protect.
    expect(native.webView.props?.originWhitelist).toEqual(["*"]);
    expect(native.webView.props?.source).toEqual({
      uri: "https://deposit.rhinestone.dev",
    });
  });

  it("catches the popup path a navigation gate never sees", () => {
    const openUrl = vi.fn();
    mount({ openUrl });
    const onOpenWindow = native.webView.props?.onOpenWindow as (event: {
      nativeEvent: { targetUrl: string };
    }) => void;

    // `target="_blank"` and `window.open` arrive here, not at
    // `onShouldStartLoadWithRequest`.
    onOpenWindow({ nativeEvent: { targetUrl: "https://basescan.org/tx/0x1" } });
    expect(openUrl).toHaveBeenCalledWith({ url: "https://basescan.org/tx/0x1" });

    // Our own page popping itself would open a second, bridge-less copy.
    openUrl.mockClear();
    onOpenWindow({ nativeEvent: { targetUrl: "https://deposit.rhinestone.dev/x" } });
    onOpenWindow({ nativeEvent: { targetUrl: "intent://evil" } });
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("dismissal", () => {
  it("asks the page first, and closes when it has nowhere to go", async () => {
    resetNative("android");
    const onDismiss = vi.fn();
    mount({ onDismiss });
    const page = loadPage();
    page.hello();
    await flush();
    page.emit("ui.state", {
      screen: "home",
      dismissal: { state: "allowed" },
    });
    await flush();

    pressAndroidBack();
    await flush();

    const back = page
      .hostRequests()
      .find((frame) => frame.method === HOST_METHOD.BACK);
    expect(back).toBeDefined();
    expect(onDismiss).not.toHaveBeenCalled();

    page.post({
      kind: "response",
      id: back!.id,
      ok: true,
      result: { handled: false },
    });
    await flush();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("holds a close the page asked for while it is locked, then honours it", async () => {
    const onDismiss = vi.fn();
    mount({ onDismiss });
    const page = loadPage();
    page.hello();
    await flush();

    page.emit("ui.state", {
      screen: "review",
      dismissal: {
        state: "blocked",
        reason: "submission-in-flight",
        message: "Finishing up",
      },
    });
    page.emit("dismissRequested", { source: "close-button" });
    await flush();
    expect(onDismiss).not.toHaveBeenCalled();

    page.emit("ui.state", {
      screen: "success",
      dismissal: { state: "allowed" },
    });
    await flush();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("closes on a finished flow even while the last policy was blocked", async () => {
    const onDismiss = vi.fn();
    mount({ onDismiss });
    const page = loadPage();
    page.hello();
    await flush();

    page.emit("ui.state", {
      screen: "processing",
      dismissal: {
        state: "blocked",
        reason: "settlement-in-progress",
        message: "Settling",
      },
    });
    page.emit("dismissRequested", { source: "flow-complete" });
    await flush();

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
