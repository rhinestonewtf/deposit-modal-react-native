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

/**
 * The drawn sheet: the height it settled on, and the gesture handlers driving
 * it. `height` is read off the fake `Animated.Value`, which applies a `timing`
 * immediately, so it is where the sheet ENDS UP rather than a frame of it.
 */
export interface SheetProbe {
  props: Record<string, unknown> | null;
  /** The scrim's `onPress`, as a tap outside the sheet delivers it. */
  scrimPress: (() => void) | null;
  pan: Record<string, (event: unknown, gesture: unknown) => unknown> | null;
}

/** The screen the mocked `useWindowDimensions` reports. */
export const WINDOW = { width: 390, height: 844 };

export const native = {
  platformOS: "ios" as "ios" | "android" | "other",
  webView: { props: null, injected: [], reloads: 0 } as WebViewProbe,
  modal: { props: null } as ModalProbe,
  sheet: { props: null, scrimPress: null, pan: null } as SheetProbe,
  /** Registered `hardwareBackPress` handlers, newest last. */
  backHandlers: [] as (() => boolean)[],
  /** Registered `AppState` `change` handlers. */
  appStateHandlers: [] as ((state: string) => void)[],
};

export function resetNative(platformOS: "ios" | "android" = "ios"): void {
  native.platformOS = platformOS;
  native.webView = { props: null, injected: [], reloads: 0 };
  native.modal = { props: null };
  native.sheet = { props: null, scrimPress: null, pan: null };
  native.backHandlers = [];
  native.appStateHandlers = [];
}

/** The height the sheet is presenting at, in the units the page reports. */
export function sheetHeight(): number | null {
  const style = native.sheet.props?.style;
  if (!Array.isArray(style)) return null;
  for (const entry of style) {
    const height = (entry as { height?: { value?: number } } | null)?.height;
    if (height && typeof height.value === "number") return height.value;
  }
  return null;
}

/** A grabber drag of `dy` points, released. Negative is upward. */
export function dragSheet(dy: number): void {
  const pan = native.sheet.pan;
  if (!pan) throw new Error("the sheet never rendered a grabber");
  pan.onPanResponderMove?.({}, { dy });
  pan.onPanResponderRelease?.({}, { dy });
}

/** Android's hardware back, as the platform delivers it. */
export function pressAndroidBack(): void {
  const handler = native.backHandlers[native.backHandlers.length - 1];
  handler?.();
}

export function sendAppState(state: string): void {
  for (const handler of native.appStateHandlers) handler(state);
}
