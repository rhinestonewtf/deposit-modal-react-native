# @rhinestone/deposit-modal-react-native

## 0.2.0

### Minor Changes

- 5f3233a: Size the sheet to the flow it is showing. The page publishes a `contentHeight`
  on `ui.state`, and the sheet is drawn here rather than presented as a
  `pageSheet` — which is a fixed near-full-height box with no detent API reachable
  from JavaScript, so a one-row screen was presented at the height of the whole
  deposit flow.

  Drawing it also makes the dismissal lock enforceable against a swipe: a drag
  down and a tap outside both go through `ui.back` and the page's dismissal
  policy, where `pageSheet`'s own interactive swipe could not be refused.

  A page that publishes no height presents exactly as before.

  Fixed alongside it: the loading overlay was spread from
  `StyleSheet.absoluteFillObject`, which React Native 0.86 removed. Spreading the
  missing export is silent, so it laid out full width and no height and painted
  nothing on that version.

### Patch Changes

- df27e96: `onFatal` now carries the web view's own description when the page fails to
  load, and Android's numeric code with it. Without them a DNS failure, a TLS
  failure, an offline device and a proxy refusing the origin all arrived as the
  same sentence, and that sentence is the integrator's only instrument.

## 0.1.1

### Patch Changes

- efaa050: Tell the page when the wallet goes away. Clearing the `wallet` prop mid-session
  pushed nothing, so the page kept rendering the account it last heard about and
  the next wallet action answered 4200 instead of the page falling back to the
  funding paths that need none. Capabilities settle once at hello by design, so
  `wallet.state` is the only channel that can say it.

## 0.1.0

### Minor Changes

- 7e18376: The React Native wrapper: `DepositSheet` presents the hosted deposit page in a
  native sheet, the app's own wallet signs over CAIP-27, and a deposit that
  settles while the web view is dead is still reported.
