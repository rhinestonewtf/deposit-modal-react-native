# deposit-modal-react-native — Claude Instructions

`@rhinestone/deposit-modal-react-native` — the React Native wrapper around the
hosted deposit embed. It presents a native sheet holding a WebView pinned to our
origin, holds the host app's wallet, and forwards bridge traffic.

It is the **reference wrapper**: Swift and Android are written against whatever
shape this settles on, so a decision here is a decision three times over.

## Where it sits

```
host app
  └── <DepositSheet … />        ← this package
        └── WebView → deposit.rhinestone.dev   (the hosted page)
              └── the integrator's proxy → deposit-processor
```

The page is `@rhinestone/deposit-modal`'s `./embed` entry, built and hosted
separately. This package never talks to a backend itself.

## The contract, and why it is copied

`src/protocol.ts` is a **hand-maintained copy** of
`src/core/bridge/protocol.ts` in `rhinestonewtf/deposit-modal`, which is the
spec. It is a copy rather than an import because importing the page's package
would drag `react-dom`, `wagmi` and `@reown/appkit` into a React Native app that
must never resolve them — and because Swift and Kotlin cannot import it at all.

- **`conformance/bridge-transcript.json` is what stops the copies drifting.**
  The page records what crosses the channel and publishes it; `conformance.test.ts`
  replays it against the real host. A renamed method, a renamed or retyped
  field, a changed error code or a changed envelope fails there.
- **Never hand-edit the vendored transcript.** Refresh it from the page:
  `curl -fsS https://dev.deposit.rhinestone.dev/bridge-transcript.json -o conformance/bridge-transcript.json`.
  It has to come from a served origin rather than from the `deposit-modal`
  checkout: `modalVersion` is stamped at page build, so the committed copy there
  carries none and a vendored copy without one cannot be dated.
- **Re-vendoring alone is the wrong fix for a red conformance run.** It silences
  the check without changing the wrapper. Fix `src/protocol.ts` to match first.
- **`bun run transcript:check` compares the vendored copy against what the page
  serves, and fails only on a BREAK** — a name removed or renamed, a recorded
  field removed or retyped, or any change at all to a value the wrapper
  hard-codes (channel names, error domain, frame cap, the EIP-712 recovery
  constants). Additions are reported, because the contract's own rule is that
  new fields are optional and a receiver ignores what it does not know, so
  failing on one would train people to re-vendor without reading.
- **A break against an origin serving an OLDER `modalVersion` than the vendored
  copy is a deploy lag, and exits 3 instead** — between a page merging and the
  origin redeploying, a name it has not shipped yet is indistinguishable from
  one it dropped. Unorderable versions (a release against a dev snapshot) and a
  copy with no version get the blunt answer, where a difference is a break.
- **It is the only thing that can catch page-side recovery drift.** The offline
  replay compares `protocol.ts` against the VENDORED copy, so a page that moves
  leaves that copy looking correct until this runs.
- **A recorded exchange disappearing is a break while the page still declares
  its name.** The replay drives what the artifact records and nothing else, so a
  vanished frame silently deletes that method's field and arity coverage. When
  the name went too, the vocabulary lists have already broken on it.
- **A wallet method's `request.params` is an index-keyed tuple, because arity is
  contract there** — a list's length is fixture size, an argument vector's is
  not. `params: []` stays the `"[]"` leaf so "takes no arguments" is
  distinguishable from "takes an empty object". `materialize` turns a tuple back
  into an array; everything else reads it as an ordinary record.
- **A payload field or literal that disappears is a break, unless its frame is
  `passthrough`.** `host.ts` compares `dismissal.state` against `"allowed"` and
  `"blocked"`, so renaming one drops every `ui.state` frame with no name in any
  vocabulary list changing. The three forwarded events (`analytics`, `error`,
  `lifecycle`) are wholly exempt — nothing reads a field out of them, so their
  churn is the product's.
- It runs on a **schedule**, not per PR (`.github/workflows/conformance.yml`):
  whether the page has moved is a property of time. The PR gate is the offline
  replay, which needs no network.
- **A name that exists only as a TypeScript type cannot be checked**, so the
  transcript cannot pin it. Add a name to `BRIDGE_METHOD` / `PAGE_EVENT` /
  `HOST_EVENT` / `BLOCKED_REASON` / `DISMISS_SOURCE` and derive the type from
  it, never the reverse.

## Releasing

- **A push to main opens a Release PR; merging that PR publishes `@latest`.**
  One branch, no `@dev` channel — the snapshot in `deposit-modal` exists to pin
  its hosted page to an npm tag, and this package has no hosted artifact.
- **Publishing is npm trusted publishing over OIDC, and npmjs.com pins the trust
  to the workflow's FILENAME.** Renaming `.github/workflows/release.yml` fails
  the publish on authorization, naming nothing.
- **The wrapper's version is not tied to the page's.** It carries no dependency
  on `@rhinestone/deposit-modal`, loads the page by URL, and negotiates at the
  handshake — so a page release changes what an installed wrapper talks to, and
  `conformance.yml` is what reports that rather than a paired release.

## Gotchas

- **`vi` is not global here.** Unlike `deposit-modal`, this repo does not set
  `globals: true` — import from `vitest` explicitly.
- **Scripts use `node:fs`, not Bun APIs.** `bun-types` is not installed, so a
  `Bun.file` call typechecks locally and fails `bun run typecheck`.
- **The version literal is checked by CI**, not just written: `src/version.ts`
  must match `package.json`, so a build that skipped `sync-version` fails. The
  header is how a mobile integration is attributed at the processor.
- The example app's demo wallet **rejects any request off its own chain**, so
  `EXPO_PUBLIC_CHAIN_ID` and `EXPO_PUBLIC_TARGET_CHAIN_ID` have to move together
  — pointing only the target elsewhere fails at the first signature.
- **A testnet run cannot reach the wallet.** The processor's portfolio scan is
  mainnet-only, so faucet funds are invisible and the external-wallet row reads
  "No balance". Proving the signing seam needs a funded mainnet account.
- **`idb ui tap` drives the simulator** and needs no Accessibility grant, unlike
  `osascript` clicking. `pip install fb-idb`; `idb_companion` comes from brew.
  Coordinates are logical points — screenshot pixels ÷ 3 on a 3x device.
