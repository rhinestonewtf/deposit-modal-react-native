/**
 * What the React Native mocks record, and what a test drives them through.
 *
 * A plain module rather than anything in the mock factories: `vi.mock` hoists
 * its factory above the imports, so a factory cannot close over a test's
 * variables. Both sides import this instead.
 */

export interface WebViewProbe {
  /** Latest props, so a test can call `onMessage` the way the platform does. */
  props: Record<string, unknown> | null;
  /** Every script the host injected, in order. */
  injected: string[];
  reloads: number;
  /** Set by a test to run each injected script against a page double. */
  onInject?: (script: string) => void;
}

export interface ModalProbe {
  props: Record<string, unknown> | null;
}

export const native = {
  platformOS: "ios" as "ios" | "android" | "other",
  webView: { props: null, injected: [], reloads: 0 } as WebViewProbe,
  modal: { props: null } as ModalProbe,
  /** Registered `hardwareBackPress` handlers, newest last. */
  backHandlers: [] as (() => boolean)[],
  /** Registered `AppState` `change` handlers. */
  appStateHandlers: [] as ((state: string) => void)[],
};

export function resetNative(platformOS: "ios" | "android" = "ios"): void {
  native.platformOS = platformOS;
  native.webView = { props: null, injected: [], reloads: 0 };
  native.modal = { props: null };
  native.backHandlers = [];
  native.appStateHandlers = [];
}

/** Android's hardware back, as the platform delivers it. */
export function pressAndroidBack(): void {
  const handler = native.backHandlers[native.backHandlers.length - 1];
  handler?.();
}

export function sendAppState(state: string): void {
  for (const handler of native.appStateHandlers) handler(state);
}
