/**
 * The sheet an integrator mounts, and the only React in this package.
 *
 * Everything about the contract lives in `host.ts`, which knows nothing about
 * React Native. What is left here is genuinely presentational or genuinely
 * platform-specific: presenting the web view, pinning it to our origin,
 * translating a back gesture, and keeping a deposit visible after the OS has
 * killed the page.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Modal,
  Platform,
  StyleSheet,
  View,
} from "react-native";
import WebViewClass, {
  type WebViewMessageEvent,
  type WebViewProps,
} from "react-native-webview";

/** The two methods the bridge needs off the web view. */
interface WebViewHandle {
  injectJavaScript(script: string): void;
  reload(): void;
}

/**
 * `react-native-webview` declares `class WebView<P = undefined> extends
 * Component<WebViewProps & P>`, so with the default type argument its props are
 * `WebViewProps & undefined` — `never` — and every prop is rejected. Re-typing
 * the import is the whole workaround; the runtime component is untouched.
 */
const WebView = WebViewClass as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebViewHandle> }
>;

import {
  buildChannelScript,
  createSessionNonce,
} from "./injection";
import { createBridgeHost, type BridgeHost, type BridgeHostHandlers } from "./host";
import {
  createDepositWatch,
  type DepositRow,
  type DepositWatch,
} from "./deposit-watch";
import { formatVersionHeader } from "./version";
import type {
  Caip27Params,
  DismissRequestedPayload,
  EmbedConfig,
  OpenUrlParams,
  SendTransactionParams,
  SendTransactionResult,
  SignRecoveryParams,
  SignRecoveryResult,
  UiStatePayload,
  WalletState,
} from "./protocol";

/**
 * The two hosted origins are release channels, not backends: prod tracks the
 * npm `@latest` page, dev tracks the `@dev` snapshot. Pin to dev while building
 * a wrapper — the page takes no configuration either way, so the only
 * difference is which bundle you get.
 */
export const EMBED_URL = "https://deposit.rhinestone.dev";
export const EMBED_URL_DEV = "https://dev.deposit.rhinestone.dev";

/**
 * How long to wait for the page to say `hello` before assuming the channel
 * missed its window.
 *
 * `injectedJavaScriptBeforeContentLoaded` runs at document start on iOS, but on
 * Android it is best-effort against the page's own scripts — and if the page
 * asks for the channel before it exists, its handshake fails outright rather
 * than waiting. One reload costs a second and fixes it; a second reload would
 * only loop, so the failure is surfaced instead.
 */
export const HANDSHAKE_TIMEOUT_MS = 8_000;

export interface WalletBridge {
  /** The full snapshot. Push a new object to update the page. */
  state: WalletState;
  /** CAIP-27. The `chainId` is authoritative — execute on that chain, do not
   *  report where the wallet happens to be. */
  request: (params: Caip27Params) => Promise<unknown> | unknown;
  /** The page's connect row was tapped. Present your own wallet picker. */
  onConnectRequested?: () => void;
  onDisconnectRequested?: () => void;
}

export interface DepositSheetProps {
  visible: boolean;
  /** Called when the sheet should close. Drive `visible` from it. */
  onDismiss: () => void;
  /** Every prop the web modal takes that survives a JSON hop. Changing it
   *  mid-session reconfigures the page in place. */
  config: EmbedConfig;

  wallet?: WalletBridge;
  /**
   * Withdraw's transfer. May be fulfilled by a relayer or a smart account —
   * it is not a wallet method, which is why it is not on the CAIP-27 channel.
   */
  sendTransaction?: (
    params: SendTransactionParams,
  ) => Promise<SendTransactionResult> | SendTransactionResult;
  /** Claim's signature: EOA, ERC-1271 or an ERC-6492 wrap, all hex here. */
  signRecovery?: (
    params: SignRecoveryParams,
  ) => Promise<SignRecoveryResult> | SignRecoveryResult;
  /**
   * Present a browser OVER the app — `expo-web-browser`'s `openBrowserAsync`,
   * or `react-native-inappbrowser-reborn`. Never `Linking.openURL`, which hands
   * the user to a different app, and never the web view itself, which puts the
   * payment page on the same document as the bridge.
   *
   * Without it the page offers no card and no exchange row at all. That is
   * deliberate: a payment method that fails at the point of paying is worse
   * than one not offered.
   */
  openUrl?: (params: OpenUrlParams) => Promise<void> | void;

  /** Defaults to the production page. */
  embedUrl?: string;
  /** Your app's own identity, folded into the version header so a page-and-app
   *  pair is attributable at the processor. */
  app?: { name?: string; version?: string };
  presentation?: "sheet" | "fullScreen";

  onReady?: () => void;
  onLifecycle?: (event: unknown) => void;
  onAnalytics?: (event: unknown) => void;
  onError?: (event: unknown) => void;
  /**
   * A deposit reached a terminal status while this component was mounted,
   * including one that started and finished while the page was dead.
   */
  onDepositSettled?: (deposit: DepositRow) => void;
  /** The page could not be reached, or never completed its handshake. */
  onFatal?: (error: Error) => void;

  pollIntervalMs?: number;
  handshakeTimeoutMs?: number;
  renderLoading?: () => ReactNode;
}

function originOf(url: string): string {
  const match = /^https:\/\/[^/]+/i.exec(url);
  return match ? match[0] : url;
}

export function DepositSheet(props: DepositSheetProps): React.JSX.Element {
  const {
    visible,
    onDismiss,
    config,
    wallet,
    sendTransaction,
    signRecovery,
    openUrl,
    embedUrl = EMBED_URL,
    app,
    presentation = "sheet",
    onReady,
    onLifecycle,
    onAnalytics,
    onError,
    onDepositSettled,
    onFatal,
    pollIntervalMs,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    renderLoading,
  } = props;

  const webViewRef = useRef<WebViewHandle | null>(null);
  const hostRef = useRef<BridgeHost | null>(null);
  const watchRef = useRef<DepositWatch | null>(null);
  const reloadedRef = useRef(false);
  const pendingDismissRef = useRef(false);
  const [loading, setLoading] = useState(true);

  // One per mount. A reload keeps it: the page is the same document from the
  // channel's point of view, and rotating it would only orphan frames in
  // flight.
  const nonce = useMemo(() => createSessionNonce(), []);
  const origin = useMemo(() => originOf(embedUrl), [embedUrl]);

  // Read by handlers the host calls between renders, so they must not close
  // over a stale render's props.
  const configRef = useRef(config);
  configRef.current = config;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const callbacksRef = useRef({ onReady, onLifecycle, onAnalytics, onError });
  callbacksRef.current = { onReady, onLifecycle, onAnalytics, onError };

  const hostIdentity = useMemo(
    () => ({
      platform: (Platform.OS === "ios"
        ? "ios"
        : Platform.OS === "android"
          ? "android"
          : "other") as "ios" | "android" | "other",
      ...(app?.name ? { app: app.name } : {}),
      ...(app?.version ? { version: app.version } : {}),
    }),
    [app?.name, app?.version],
  );

  const dismissNow = useCallback(() => {
    pendingDismissRef.current = false;
    onDismiss();
  }, [onDismiss]);

  /**
   * A dismissal the page did not ask for: the close affordance the host owns.
   * The page gets first refusal — back is a navigation before it is an exit —
   * and the lock is checked separately, because a page that has stopped
   * answering has also stopped telling us it is locked.
   */
  const requestDismiss = useCallback(async () => {
    const host = hostRef.current;
    if (!host) {
      dismissNow();
      return;
    }
    const { handled } = await host.back();
    if (handled) return;
    if (host.uiState?.dismissal.state === "blocked") {
      pendingDismissRef.current = true;
      return;
    }
    dismissNow();
  }, [dismissNow]);

  const handlers: BridgeHostHandlers = useMemo(
    () => ({
      ...(wallet
        ? {
            walletRequest: (params: Caip27Params) =>
              (walletRef.current as WalletBridge).request(params),
          }
        : {}),
      ...(sendTransaction ? { sendTransaction } : {}),
      ...(signRecovery ? { signRecovery } : {}),
      ...(openUrl ? { openUrl } : {}),
    }),
    // `wallet` only gates whether the capability exists; the call itself goes
    // through the ref, so a new snapshot every render does not rebuild the host.
    [Boolean(wallet), sendTransaction, signRecovery, openUrl],
  );

  // The host lives as long as the sheet is open. Rebuilding it mid-session
  // would drop the correlation table with requests outstanding.
  useEffect(() => {
    if (!visible) return;

    let settled = false;
    const host = createBridgeHost({
      post: (script) => webViewRef.current?.injectJavaScript(script),
      nonce,
      host: hostIdentity,
      getConfig: () => configRef.current,
      getWallet: () =>
        walletRef.current?.state ?? {
          isReady: true,
          isConnected: false,
          accounts: [],
          chainId: null,
        },
      handlers,
      onHello: ({ modalVersion }) => {
        settled = true;
        // Only once the page has named itself: the watch's requests carry the
        // same version header the page's do, so the pair is one client at the
        // processor rather than two.
        const recipient = configRef.current.recipient;
        if (!recipient || watchRef.current) return;
        const watch = createDepositWatch({
          backendUrl: configRef.current.backendUrl,
          recipient,
          versionHeader: formatVersionHeader(modalVersion, hostIdentity),
          ...(pollIntervalMs ? { intervalMs: pollIntervalMs } : {}),
          onSettled: (deposit) => onDepositSettled?.(deposit),
          onError: () => {
            // A poll failure is not the flow's failure — the page is running
            // its own tracker against the same backend and reports what it
            // sees. Surfacing this too would double every outage.
          },
        });
        watchRef.current = watch;
        watch.start();
      },
      onEvent: (type, payload) => {
        const callbacks = callbacksRef.current;
        switch (type) {
          case "ready":
            setLoading(false);
            callbacks.onReady?.();
            return;
          case "lifecycle":
            callbacks.onLifecycle?.(payload);
            return;
          case "analytics":
            callbacks.onAnalytics?.(payload);
            return;
          case "error":
            callbacks.onError?.(payload);
            return;
          case "wallet.connectRequested":
            walletRef.current?.onConnectRequested?.();
            return;
          case "wallet.disconnectRequested":
            walletRef.current?.onDisconnectRequested?.();
            return;
          case "ui.state": {
            const state = payload as UiStatePayload | undefined;
            // A dismissal the page asked for while it was locked is honoured
            // when the lock lifts, not refused. `dismissRequested` is an event
            // and cannot be refused; it is a request to close, not permission.
            if (
              pendingDismissRef.current &&
              state?.dismissal.state === "allowed"
            ) {
              dismissNow();
            }
            return;
          }
          case "dismissRequested": {
            const source = (payload as DismissRequestedPayload | undefined)
              ?.source;
            if (
              source !== "flow-complete" &&
              hostRef.current?.uiState?.dismissal.state === "blocked"
            ) {
              pendingDismissRef.current = true;
              return;
            }
            dismissNow();
            return;
          }
          default:
            return;
        }
      },
    });
    hostRef.current = host;

    // Android's injection window is best-effort, and a page that asked for the
    // channel too early has already failed its handshake rather than waiting.
    const timer = setTimeout(() => {
      if (settled) return;
      if (!reloadedRef.current) {
        reloadedRef.current = true;
        webViewRef.current?.reload();
        return;
      }
      onFatal?.(new Error("The deposit page did not complete its handshake."));
    }, handshakeTimeoutMs);

    return () => {
      clearTimeout(timer);
      host.close();
      hostRef.current = null;
      watchRef.current?.stop();
      watchRef.current = null;
    };
  }, [
    visible,
    nonce,
    hostIdentity,
    handlers,
    handshakeTimeoutMs,
    pollIntervalMs,
    onDepositSettled,
    onFatal,
    dismissNow,
  ]);

  // Config is not a mount-time value: appearance can change while the sheet is
  // open, and the page repaints in place without disturbing the flow.
  useEffect(() => {
    if (hostRef.current?.connected) hostRef.current.configure(config);
  }, [config]);

  useEffect(() => {
    if (wallet && hostRef.current?.connected) {
      hostRef.current.pushWalletState(wallet.state);
    }
  }, [wallet?.state]);

  useEffect(() => {
    if (!visible || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        void requestDismiss();
        // Always claimed: the answer is asynchronous, so letting the default
        // run would close the sheet before the page had a chance to refuse.
        return true;
      },
    );
    return () => subscription.remove();
  }, [visible, requestDismiss]);

  // Returning from the payment browser is the one moment a poll is worth more
  // than the interval it would otherwise wait for.
  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void watchRef.current?.poll();
    });
    return () => subscription.remove();
  }, [visible]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    hostRef.current?.receive(event.nativeEvent.data);
  }, []);

  /**
   * The web view is pinned to our origin.
   *
   * A redirect inside the container would otherwise put another document on the
   * same web view as the bridge. Anything else is a link the page meant to open
   * outside — a block explorer, a provider's terms — and handing it to the
   * browser is what keeps it from being a dead tap.
   */
  const onShouldStartLoadWithRequest = useCallback(
    (request: { url: string; navigationType?: string }) => {
      if (request.url === "about:blank") return true;
      if (request.url.startsWith(origin)) return true;
      if (request.url.startsWith("https://") && openUrl) {
        void openUrl({ url: request.url });
      }
      return false;
    },
    [origin, openUrl],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      presentationStyle={presentation === "sheet" ? "pageSheet" : "fullScreen"}
      onRequestClose={() => void requestDismiss()}
    >
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ uri: embedUrl }}
          originWhitelist={[`${origin}/*`]}
          // Only the main frame learns the nonce, which is what stops a
          // third-party frame reaching the wallet through a channel neither
          // platform scopes on its own.
          injectedJavaScriptBeforeContentLoaded={buildChannelScript(nonce)}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onError={() =>
            onFatal?.(new Error("The deposit page could not be loaded."))
          }
          // The page sizes itself to the visual viewport and draws its own
          // safe-area padding; a second inset here would double it.
          contentInsetAdjustmentBehavior="never"
          allowsInlineMediaPlayback
          javaScriptEnabled
          domStorageEnabled
          style={styles.webView}
        />
        {loading ? (
          <View style={styles.loading} pointerEvents="none">
            {renderLoading ? renderLoading() : <ActivityIndicator />}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webView: { flex: 1 },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
