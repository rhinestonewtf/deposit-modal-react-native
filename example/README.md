# Example app

```sh
bun install
EXPO_PUBLIC_BACKEND_URL=https://your-proxy.example/deposit bun run ios
```

It points at `EMBED_URL_DEV`, so it runs whatever the modal's `main` branch last
published to npm `@dev`.

`EXPO_PUBLIC_DEMO_PRIVATE_KEY` loads a throwaway account so the wallet path can
be driven on a simulator. Without it, set `EXPO_PUBLIC_RECIPIENT` to an address
you hold and the sheet runs wallet-free — QR and manual transfer — which is a
real configuration rather than a broken one. With neither, the button stays
disabled: registration fails for an address nobody holds, and the flow reports
that as the deposit service being unavailable.

`EXPO_PUBLIC_AUTO_OPEN=1` opens the sheet on launch, which is how it is driven
on a simulator with no way to tap.

Not built in CI: it needs a simulator, and the contract it exercises is covered
in Node by the package's own tests.
