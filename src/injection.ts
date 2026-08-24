/**
 * The two halves of the channel that have to be written as source text.
 *
 * `react-native-webview` gives us `window.ReactNativeWebView.postMessage` in
 * one direction and `injectJavaScript` in the other. Neither is the shape the
 * page expects, and neither is safe to use naively, so both adaptations live
 * here rather than inline in the component.
 */

const CHANNEL_INSTALLED_FLAG = "__rhinestoneChannelInstalled";

/** Separates the nonce from the frame. Not produced by `JSON.stringify`. */
export const NONCE_SEPARATOR = "|";

/**
 * Installs the page→host half, and nothing else.
 *
 * **The nonce is the frame scoping.** `react-native-webview` does not scope its
 * message handler to the main frame on either platform — that is the hole
 * RHI-5993 tracks page-side — so a sub-frame that reaches `ReactNativeWebView`
 * can post into our `onMessage` and drive the wallet. This script is injected
 * with `injectedJavaScriptBeforeContentLoadedForMainFrameOnly`, so only the
 * main frame ever learns the nonce, and `createBridgeHost` drops a frame that
 * does not carry it. A sub-frame can still call `postMessage` directly; it
 * cannot produce a frame this host will act on.
 *
 * The nonce is not a secret from the page — the page is us. It separates our
 * own document from everything else loaded in the same web view.
 */
export function buildChannelScript(nonce: string): string {
  // Interpolates a nonce we generated ourselves, never anything the page or a
  // provider supplied.
  return `(function () {
  if (window.${CHANNEL_INSTALLED_FLAG}) { return; }
  window.${CHANNEL_INSTALLED_FLAG} = true;
  var send = function (json) {
    if (typeof json !== 'string') { return; }
    window.ReactNativeWebView.postMessage(${JSON.stringify(nonce)} + ${JSON.stringify(NONCE_SEPARATOR)} + json);
  };
  Object.defineProperty(window, 'rhinestoneBridge', {
    value: Object.freeze({ postMessage: send }),
    writable: false,
    configurable: false,
  });
})();
true;`;
}

export interface ParsedInboundFrame {
  nonce: string;
  json: string;
}

/**
 * Split what `onMessage` handed us. `undefined` for anything that is not
 * `<nonce>|<json>` — including a frame a sub-frame posted directly, which
 * carries no prefix at all.
 */
export function parseInboundFrame(
  raw: unknown,
): ParsedInboundFrame | undefined {
  if (typeof raw !== "string") return undefined;
  const separator = raw.indexOf(NONCE_SEPARATOR);
  if (separator <= 0) return undefined;
  return { nonce: raw.slice(0, separator), json: raw.slice(separator + 1) };
}

/**
 * Characters that are legal in a JSON string but not safe in script source.
 *
 * U+2028 and U+2029 were line terminators in JS before ES2019, so an unescaped
 * one truncates the statement on an older engine. This boundary carries
 * wallet-controlled text by design — `BridgeError.message` is the wallet's own
 * copy — so it is not theoretical. `<` goes too, cheaply, so the same encoder
 * stays correct if a frame ever reaches a `<script>` body.
 */
const UNSAFE_IN_SCRIPT = new RegExp("[\\u2028\\u2029<]", "g");

/** Wrap a frame as a call to the page's receiver. */
export function encodeFrameForInjection(json: string): string {
  const literal = JSON.stringify(json).replace(
    UNSAFE_IN_SCRIPT,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  // The trailing `true;` keeps iOS from warning about a non-serializable
  // evaluation result.
  return `window.__rhinestone_bridge && window.__rhinestone_bridge(${literal}); true;`;
}

/**
 * A nonce for one web-view session.
 *
 * `crypto.getRandomValues` where the runtime has it — Hermes does not, and
 * neither does an older JSC, so the fallback is `Math.random`. That is weaker
 * than it looks against the adversary this defends against, a third-party frame
 * *inside our own web view*: it cannot read the value, and it gets one guess
 * per frame with no feedback. A wrapper that wants more should install
 * `react-native-get-random-values` and pass its own.
 */
export function createSessionNonce(): string {
  const globalCrypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } }
  ).crypto;
  const bytes = new Uint8Array(16);
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
