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
- **Re-vendoring alone is the wrong fix for a red conformance run.** It silences
  the check without changing the wrapper. Fix `src/protocol.ts` to match first.
- **`bun run transcript:check` compares the vendored copy against what the page
  serves, and fails only on a BREAK** — a name removed or renamed, or a recorded
  field removed or retyped. Additions are reported, because the contract's own
  rule is that new fields are optional and a receiver ignores what it does not
  know, so failing on one would train people to re-vendor without reading. The
  vocabulary lists are what catch a name; the frames are what catch a field, and
  the offline replay only ever sees the vendored copy.
- It runs on a **schedule**, not per PR (`.github/workflows/conformance.yml`):
  whether the page has moved is a property of time. The PR gate is the offline
  replay, which needs no network.
- **A name that exists only as a TypeScript type cannot be checked**, so the
  transcript cannot pin it. Add a name to `BRIDGE_METHOD` / `PAGE_EVENT` /
  `HOST_EVENT` and derive the type from it, never the reverse.

## Gotchas

- **`vi` is not global here.** Unlike `deposit-modal`, this repo does not set
  `globals: true` — import from `vitest` explicitly.
- **Scripts use `node:fs`, not Bun APIs.** `bun-types` is not installed, so a
  `Bun.file` call typechecks locally and fails `bun run typecheck`.
- **The version literal is checked by CI**, not just written: `src/version.ts`
  must match `package.json`, so a build that skipped `sync-version` fails. The
  header is how a mobile integration is attributed at the processor.
- The example app's demo wallet **hardcodes Base** and rejects any other chain,
  so a dev test on another corridor needs that changed, not just config.
