# @rhinestone/deposit-modal-react-native

The Rhinestone deposit flow in a React Native app: a native sheet holding our
hosted page, with your app's wallet driving every signature.

```sh
bun add @rhinestone/deposit-modal-react-native react-native-webview
```

```tsx
import { DepositSheet } from "@rhinestone/deposit-modal-react-native";

<DepositSheet
  visible={open}
  onDismiss={() => setOpen(false)}
  config={{
    mode: "deposit",
    backendUrl: "https://your-proxy.example/deposit",
    recipient: account,
    targetChain: 8453,
    // An address, never a symbol — an EVM target rejects "USDC".
    targetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  }}
  wallet={{
    state: walletState,
    request: ({ chainId, request }) => yourWallet.request(chainId, request),
    onConnectRequested: () => yourWalletPicker.open(),
  }}
  openUrl={({ url }) => WebBrowser.openBrowserAsync(url)}
/>;
```

## Before your first build

**Your proxy must allow `https://deposit.rhinestone.dev`.** Every backend call
from a mobile integration originates from our hosted page, not from your app's
domain, so a proxy with an explicit CORS allow-list rejects all of them at
preflight — the whole sheet dead, with nothing naming the cause. A proxy using a
permissive default is unaffected. Dev builds use
`https://dev.deposit.rhinestone.dev`.

## The two hosted pages are release channels

`EMBED_URL` tracks the npm `@latest` modal, `EMBED_URL_DEV` tracks the `@dev`
snapshot. Neither takes configuration — the only difference is which bundle you
get, so pin `embedUrl={EMBED_URL_DEV}` while building against an unreleased
change and drop it before you ship.

The page adapts to your wrapper at runtime: both sides announce their protocol
version and capabilities during the handshake, which is what keeps a protocol
*bug* fixable for an app already in the store.

## What each prop turns on

`config` is every prop the web modal takes that survives a JSON hop, with the
same names. It is not a mount-time value — change it and the page reconfigures
in place, which is how appearance follows an app that can switch it mid-flow.

| you pass | the page gains |
|---|---|
| `wallet` | The connect row, and signing over CAIP-27 |
| `sendTransaction` | Withdraw |
| `signRecovery` | Claim |
| `openUrl` | The card and exchange rows |

Omitting one is not a degraded flow, it is a smaller one. **Without `openUrl`
the page offers no card row at all**, because card verification routinely
refuses an embedded web view and a payment method that fails at the point of
paying is worse than one never offered.

### `openUrl` must present a browser over your app

`expo-web-browser`'s `openBrowserAsync`, or `react-native-inappbrowser-reborn`.
Never `Linking.openURL`, which hands the user to a different app, and never the
web view itself, which is the arrangement this exists to end. Answer when the
browser is presented, not when it is dismissed — a dismissal-tied answer has to
survive your activity being killed behind Custom Tabs.

Nothing about the deposit depends on that answer. Our own order-status route
drives the tracker, so the page is idle while the user is elsewhere.

## Errors your handlers throw

Throw `userRejected()` when the user said no, `walletUnavailable()` when you
could not reach the wallet, and `submissionUncertain()` when an app switch or a
process death left you unable to say whether a transaction was broadcast.

That last one matters more than it looks. Without it a host has to lie in one
direction or the other, and the safe-*looking* lie — reporting failure — is the
one that double-spends: the page re-offers its button and the user sends again.
Anything else you throw from a sending handler is treated as uncertain for the
same reason.

## A deposit that outlives the page

The OS kills a backgrounded web view routinely, and a user who backgrounds the
app mid-settlement would otherwise return to a blank sheet with the deposit long
since complete. While the component is mounted it polls the same `/deposits`
route the page uses and reports terminal deposits through `onDepositSettled`,
including one that both started and finished while the page was dead. Once the
process is gone this stops; the modal's history panel covers the reopen.

## The sheet is the height of the flow

The page publishes what it currently needs and the sheet follows it, so a
one-row screen is not presented at the height of the whole deposit flow. Drag
the grabber up for full height; a page that publishes no height gets full height
to begin with.

Nothing to pass — `presentation="fullScreen"` opts out, and an integrator who
ignores all of this is unaffected.

## Dismissal is not always yours to grant

The page publishes a dismissal policy, and at a few moments it is `blocked`:
a wallet request outstanding, a submission in flight, a payment session held by
a third party. Android's hardware back and the sheet's own close both route
through the page first, and a dismissal it cannot accept now is honoured when
the lock lifts rather than refused.

A lock is never open-ended — every request the page blocks on carries its own
deadline — so this cannot produce a sheet the user is stuck in.

**The swipe goes through the same policy.** The sheet is drawn here rather than
presented as a `pageSheet`, whose interactive swipe React Native gives no way to
refuse — so a drag on the grabber and a tap outside are ours to route, and a
locked screen cannot be swiped away mid-signature. `presentation="fullScreen"`
remains available, but it is no longer the way to protect a signature.

## Development

```sh
bun install
bun run typecheck
bun run test
bun run build
```

`src/host.ts` is the contract; it has no React and no `react-native-webview` in
it, so the whole bridge is testable in Node against `src/test/page-double.ts`,
which runs the injected script rather than reading the frame out of a mock.
`src/DepositSheet.tsx` is what is left over: presentation, origin pinning, the
back gesture, and the poll.

The sheet is covered too, against a page double living in a real window
(`src/test/page-window.ts`): React Native and the web view are mocked, the
bridge is not, so a component test still crosses the nonce, the encoder and the
correlation table. That is where the session lifetime is pinned down — a session
that must survive a parent's re-render, a reload allowance that must not survive
the session, and a watch that has to follow a config it was not born with.
