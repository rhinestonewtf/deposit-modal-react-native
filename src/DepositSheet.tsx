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
  Animated,
  AppState,
  BackHandler,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
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
import {
  createBridgeHost,
  type BridgeHost,
  type BridgeHostHandlers,
} from "./host";
import {
  createDepositWatch,
  type DepositRow,
  type DepositWatch,
} from "./deposit-watch";
import { isSameOrigin, parseHttpsAuthority } from "./origin";
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

/**
 * What a host with no wallet reports, at hello and whenever one goes away.
 *
 * One constant rather than two literals: the page reads this to decide whether
 * to offer a wallet row at all, and the two moments that produce it — a session
 * starting without a wallet, and a wallet being cleared mid-session — have to
 * say exactly the same thing.
 */
export const DISCONNECTED_WALLET: WalletState = {
  isReady: true,
  isConnected: false,
  accounts: [],
  chainId: null,
};

/**
 * How much of the app stays visible above a full-height sheet.
 *
 * Approximates the inset iOS leaves at the `.large()` detent, which is what
 * `presentationStyle="pageSheet"` gave before this sheet was drawn here. Its
 * job is to keep the scrim visible, so it does not need the safe area to be
 * exact — and reading that would cost a dependency the package does not have.
 */
const SHEET_TOP_GAP = 64;

/** The grabber strip, overlaid on the page rather than stacked above it — the
 *  page already leaves this space, because iOS draws its own grabber there. */
const GRABBER_HEIGHT = 24;

/** How far down the grabber must travel before the release is a dismissal
 *  rather than a slip. */
const DISMISS_TRAVEL = 88;

/** Snapping to full height, once dragged past this much of the way there. */
const EXPAND_TRAVEL = 48;

const HEIGHT_ANIMATION_MS = 220;

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
  // The page's own version, learned at hello. Also the signal that there is a
  // session to poll alongside.
  const [modalVersion, setModalVersion] = useState<string | null>(null);

  /**
   * What the flow last said it needs, in CSS pixels, and `null` for "present
   * the way this sheet did before the page published a height".
   *
   * Only ever replaced by a POSITIVE height. An absent `contentHeight` means
   * the page has nothing laid out to measure — never zero — so treating it as
   * a value would collapse the sheet between two screens.
   */
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  // One per mount. A reload keeps it: the page is the same document from the
  // channel's point of view, and rotating it would only orphan frames in
  // flight.
  const nonce = useMemo(() => createSessionNonce(), []);

  /**
   * Everything the host reaches for between renders goes through a ref.
   *
   * Not a style: a parent that re-renders with a fresh arrow for any of these
   * would otherwise change the identity of the effect's dependencies, and the
   * effect's cleanup CLOSES the bridge. A request already awaiting a signature
   * would answer into a closed host and never reach the page, which is a
   * payment hanging mid-flow because the screen above it repainted.
   */
  const configRef = useRef(config);
  configRef.current = config;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const latestRef = useRef({
    onReady,
    onLifecycle,
    onAnalytics,
    onError,
    onDepositSettled,
    onFatal,
    onDismiss,
    sendTransaction,
    signRecovery,
    openUrl,
  });
  latestRef.current = {
    onReady,
    onLifecycle,
    onAnalytics,
    onError,
    onDepositSettled,
    onFatal,
    onDismiss,
    sendTransaction,
    signRecovery,
    openUrl,
  };

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
    latestRef.current.onDismiss();
  }, []);

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

  /**
   * The handlers, rebuilt every render and never a dependency of anything.
   *
   * Nothing about a handler may rebuild the host — not its identity, and not
   * its presence either. A host rebuilt because `openUrl` arrived late is a
   * host rebuilt underneath a page that has already handshaken with the old
   * one, and the page has no reason to handshake again: wallet pushes stop
   * reaching it, a back gesture stops asking it, and the only thing that
   * eventually notices is the handshake deadline, which recovers by reloading
   * the page out from under whatever the user was doing.
   *
   * The cost is that a capability appearing after hello is not announced until
   * the next session, which is what the protocol says anyway — capabilities
   * are settled once per handshake. A wallet arriving late is the case that
   * actually matters, and it needs none of this: wallet availability rides
   * `wallet.state`, which is pushed.
   */
  const handlersRef = useRef<BridgeHostHandlers>({});
  handlersRef.current = {
    ...(wallet
      ? {
          walletRequest: (params: Caip27Params) =>
            (walletRef.current as WalletBridge).request(params),
        }
      : {}),
    ...(sendTransaction ? { sendTransaction } : {}),
    ...(signRecovery ? { signRecovery } : {}),
    ...(openUrl ? { openUrl } : {}),
  };

  // The host lives as long as the sheet is open. Rebuilding it mid-session
  // would drop the correlation table with requests outstanding.
  useEffect(() => {
    if (!visible) return;

    // Per session, not per mount. A sheet that opened, recovered from an
    // injection race and closed would otherwise spend its one reload forever:
    // every later session would report the first timeout as fatal, turning a
    // transient race into a permanent failure for as long as the component
    // stays mounted.
    reloadedRef.current = false;

    let settled = false;
    const host = createBridgeHost({
      post: (script) => webViewRef.current?.injectJavaScript(script),
      nonce,
      host: hostIdentity,
      getConfig: () => configRef.current,
      getWallet: () => walletRef.current?.state ?? DISCONNECTED_WALLET,
      getHandlers: () => handlersRef.current,
      onHello: ({ modalVersion }) => {
        settled = true;
        // The watch cannot start before this: its requests carry the same
        // version header the page's do, so the pair is one client at the
        // processor rather than two, and only the page can name its half.
        setModalVersion(modalVersion);
      },
      onEvent: (type, payload) => {
        const callbacks = latestRef.current;
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
            const height = state?.contentHeight;
            if (typeof height === "number" && height > 0) {
              setContentHeight(height);
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
    // One reload fixes that; a second would only loop, so the deadline is armed
    // again after it and the second expiry is reported rather than swallowed —
    // otherwise a page that is simply broken leaves the sheet on its spinner
    // for as long as the user is willing to look at it.
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (settled) return;
        if (!reloadedRef.current) {
          reloadedRef.current = true;
          webViewRef.current?.reload();
          arm();
          return;
        }
        latestRef.current.onFatal?.(
          new Error("The deposit page did not complete its handshake."),
        );
      }, handshakeTimeoutMs);
    };
    arm();

    return () => {
      clearTimeout(timer);
      host.close();
      hostRef.current = null;
      setModalVersion(null);
      // Per session: the next one starts on a screen this one knows nothing
      // about, and opening at the last screen's height would be a sheet sized
      // for content that is not there yet.
      setContentHeight(null);
    };
  }, [visible, nonce, hostIdentity, handshakeTimeoutMs]);

  /**
   * The watch follows the config, rather than the config it was born with.
   *
   * Keyed on the two fields it actually reads. An app that changes `recipient`
   * while the sheet stays open — switching account behind a live sheet — would
   * otherwise leave the page starting deposits for one address while the
   * watcher polled another, and the completion the web view died through would
   * be missed by the only thing still looking for it.
   *
   * Restarting takes a fresh baseline, which is right: what was already
   * finished for a different account is not this account's news.
   */
  useEffect(() => {
    if (!visible || !modalVersion || !config.recipient) return;
    const watch = createDepositWatch({
      backendUrl: config.backendUrl,
      recipient: config.recipient,
      versionHeader: formatVersionHeader(modalVersion, hostIdentity),
      ...(pollIntervalMs ? { intervalMs: pollIntervalMs } : {}),
      onSettled: (deposit) => latestRef.current.onDepositSettled?.(deposit),
      onError: () => {
        // A poll failure is not the flow's failure — the page runs its own
        // tracker against the same backend and reports what it sees.
        // Surfacing this too would double every outage.
      },
    });
    watchRef.current = watch;
    watch.start();
    return () => {
      watch.stop();
      if (watchRef.current === watch) watchRef.current = null;
    };
  }, [
    visible,
    modalVersion,
    config.backendUrl,
    config.recipient,
    hostIdentity,
    pollIntervalMs,
  ]);

  // Config is not a mount-time value: appearance can change while the sheet is
  // open, and the page repaints in place without disturbing the flow.
  useEffect(() => {
    if (hostRef.current?.connected) hostRef.current.configure(config);
  }, [config]);

  /**
   * A wallet going away has to be SAID.
   *
   * Capabilities settle once at hello, deliberately, so wallet availability is
   * the thing that rides `wallet.state` — and a host that drops its wallet and
   * pushes nothing leaves the page rendering the account it last heard about.
   * The next wallet action then answers 4200 rather than the page falling back
   * to the funding paths that need no wallet at all.
   *
   * Keyed on the wallet's presence as well as its state, or clearing it would
   * not even re-run this.
   */
  useEffect(() => {
    if (!hostRef.current?.connected) return;
    hostRef.current.pushWalletState(wallet?.state ?? DISCONNECTED_WALLET);
  }, [wallet, wallet?.state]);

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
   * How tall the sheet is, and the whole of what `contentHeight` buys.
   *
   * The reported height is applied VERBATIM, only clamped to a maximum. Never
   * minus an inset: the page measures its content inside whatever viewport it
   * has, so a host that subtracted something before applying it would hand back
   * a smaller viewport, be told a smaller height, and shrink again on every
   * round until the sheet collapsed.
   */
  const { height: windowHeight } = useWindowDimensions();
  const maxSheetHeight = Math.max(windowHeight - SHEET_TOP_GAP, 0);
  const targetHeight = Math.min(contentHeight ?? maxSheetHeight, maxSheetHeight);

  const sheetHeight = useRef(new Animated.Value(targetHeight)).current;
  const dragY = useRef(new Animated.Value(0)).current;

  // Opening is a snap, not an animation: there is nothing on screen yet to
  // animate from, and the sheet slides in as a whole.
  useEffect(() => {
    if (!visible) return;
    sheetHeight.setValue(targetHeight);
    dragY.setValue(0);
    // Deliberately keyed on the session alone. Height changes WITHIN a session
    // are the effect below, which animates them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    Animated.timing(sheetHeight, {
      toValue: targetHeight,
      duration: HEIGHT_ANIMATION_MS,
      // `height` is not a transform, so it cannot be driven off the JS thread.
      useNativeDriver: false,
    }).start();
  }, [visible, targetHeight, sheetHeight]);

  /**
   * The grabber's drag, and the reason this sheet is drawn here rather than
   * presented as a `pageSheet`.
   *
   * A downward release goes through `requestDismiss`, so the page gets first
   * refusal and the dismissal lock is enforceable — which the platform sheet's
   * own interactive swipe is not from JavaScript. The sheet springs back
   * regardless: if the close is allowed the parent takes `visible` away, and if
   * it is refused the sheet is already where it belongs.
   */
  const expandRef = useRef<() => void>(() => {});
  expandRef.current = () => setContentHeight(maxSheetHeight);
  const dismissRef = useRef<() => void>(() => {});
  dismissRef.current = () => void requestDismiss();

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > 4,
        onPanResponderMove: (_event, gesture) => {
          // Downward only. Upward travel is a snap on release rather than a
          // live resize, because growing the sheet grows the page's viewport
          // and re-laying the flow out on every frame of a drag is worse than
          // arriving at the new size once.
          dragY.setValue(Math.max(gesture.dy, 0));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_TRAVEL) dismissRef.current();
          else if (gesture.dy < -EXPAND_TRAVEL) expandRef.current();
          Animated.spring(dragY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(dragY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        },
      }),
    [dragY],
  );

  /**
   * The web view is pinned to our origin.
   *
   * A redirect inside the container would otherwise put another document on the
   * same web view as the bridge — and the main-frame injection would hand it
   * the nonce. Compared by parsing rather than by prefix, because
   * `https://deposit.rhinestone.dev.evil.example` passes a `startsWith` and is
   * not our origin.
   *
   * Anything else is a link the page meant to open outside — a block explorer,
   * a provider's terms — and handing it to the browser is what keeps it from
   * being a dead tap.
   */
  const onShouldStartLoadWithRequest = useCallback(
    (request: {
      url: string;
      navigationType?: string;
      isTopFrame?: boolean;
    }) => {
      // Sub-frames are not this gate's business, and treating them as one
      // breaks the page: a frame load is neither a navigation away from our
      // origin nor a link the user tapped, so cancelling it kills whatever the
      // page embedded and handing it to the browser is worse. The wallet seam
      // is protected from a frame by the nonce, which only the main frame
      // learns, not by this.
      //
      // `isTopFrame` is iOS-only; Android does not route sub-frame loads here
      // at all, so an absent value means the main frame on both.
      if (request.isTopFrame === false) return true;
      if (request.url === "about:blank") return true;
      if (isSameOrigin(request.url, embedUrl)) return true;
      if (parseHttpsAuthority(request.url) && latestRef.current.openUrl) {
        latestRef.current.openUrl({ url: request.url });
      }
      return false;
    },
    [embedUrl],
  );

  /**
   * The other way a link leaves the page, and the one a navigation gate never
   * sees.
   *
   * `target="_blank"` and `window.open` do not reach
   * `onShouldStartLoadWithRequest`: WKWebView asks to create a second web view,
   * and Android ships `setSupportMultipleWindows` on by default, so both
   * arrive here instead. Left unhandled they are dead taps — or worse, a child
   * web view holding a provider page outside the origin gate.
   *
   * Our own origin is ignored rather than forwarded: the page has no reason to
   * pop itself, and answering by opening a second, bridge-less copy of the
   * deposit page in the system browser is worse than the dead tap.
   */
  const onOpenWindow = useCallback(
    (event: { nativeEvent?: { targetUrl?: string } }) => {
      const url = event.nativeEvent?.targetUrl;
      if (typeof url !== "string") return;
      if (isSameOrigin(url, embedUrl)) return;
      if (parseHttpsAuthority(url)) latestRef.current.openUrl?.({ url });
    },
    [embedUrl],
  );

  const sheet = presentation === "sheet";

  return (
    /**
     * Transparent, because the sheet is drawn here rather than presented.
     *
     * `presentationStyle="pageSheet"` is a fixed, near-full-height box with no
     * detent API reachable from JavaScript, so a one-row screen was presented
     * at the height of the whole flow. Drawing it costs the scrim and the
     * spring; it buys the height, and a swipe the dismissal lock can refuse.
     *
     * The slide carries the scrim up with it, which a platform sheet would fade
     * separately. Worth the seam: animating out ourselves would mean holding
     * the modal mounted past `visible`, and the page behind it is already gone.
     */
    <Modal
      visible={visible}
      animationType="slide"
      transparent={sheet}
      presentationStyle={sheet ? "overFullScreen" : "fullScreen"}
      onRequestClose={() => void requestDismiss()}
    >
      {sheet ? (
        <Pressable
          style={styles.scrim}
          onPress={() => void requestDismiss()}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      ) : null}
      <Animated.View
        style={
          sheet
            ? [
                styles.sheet,
                { height: sheetHeight, transform: [{ translateY: dragY }] },
              ]
            : styles.container
        }
      >
        <WebView
          ref={webViewRef}
          source={{ uri: embedUrl }}
          // Everything, so that nothing is ever refused HERE.
          //
          // This is not the origin pin — `onShouldStartLoadWithRequest` below
          // is, and it is exact. What this list actually controls is what
          // `react-native-webview` does with a URL it rejects, which is hand it
          // to `Linking.openURL`: another app, chosen by scheme, with no gate
          // of ours in front of it. That is the app-launch primitive
          // `host.openUrl` exists to refuse, so the list must never reject
          // anything.
          //
          // It also silently swallowed our own page. A pattern of
          // `https://host/*` does not match `https://host`, which is exactly
          // what `source` carries, so the first load went to `Linking` and the
          // sheet sat on its spinner until the handshake deadline.
          originWhitelist={["*"]}
          // Only the main frame learns the nonce, which is what stops a
          // third-party frame reaching the wallet through a channel neither
          // platform scopes on its own.
          injectedJavaScriptBeforeContentLoaded={buildChannelScript(nonce)}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onOpenWindow={onOpenWindow}
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
        {sheet ? (
          // Overlaid rather than stacked above the web view: the page already
          // leaves this strip empty, because iOS draws its own grabber there,
          // and taking the space instead would push every screen down by it.
          <View style={styles.grabberArea} {...pan.panHandlers}>
            <View style={styles.grabber} />
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

/**
 * Spelled out rather than `StyleSheet.absoluteFillObject`, which **React Native
 * 0.86 removed** — only `absoluteFill`, a registered style id that cannot be
 * spread, survives.
 *
 * Spreading the missing export is not an error in TypeScript or at runtime: it
 * contributes nothing, and the view becomes an ordinary in-flow child. It then
 * lays out 402x0 — full width, no height — so it renders, reports a layout, and
 * paints nothing. The scrim was invisible on 0.86 and correct on the 0.73 this
 * package also supports.
 */
const FILL = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

const styles = StyleSheet.create({
  container: { flex: 1 },
  webView: { flex: 1 },
  loading: {
    ...FILL,
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    ...FILL,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    // The page paints its own background, so clipping the web view to the
    // radius is what stops its square corners showing through. Android does not
    // always clip a native child to a parent's radius — the corners read square
    // there, which is cosmetic and not worth a second view to fix.
    overflow: "hidden",
  },
  grabberArea: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: GRABBER_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "rgba(120, 120, 128, 0.4)",
  },
});
