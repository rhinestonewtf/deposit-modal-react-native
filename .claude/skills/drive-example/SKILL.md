---
name: drive-example
description: Use when driving the example app by hand on an Android emulator or iOS simulator — tapping through the sheet, inspecting the embed page over the Chrome DevTools Protocol, or exercising link hand-off (`target="_blank"`, `host.openUrl`) without funding a deposit.
---

# Driving the example app

Booting, building and `idb` basics are in `CLAUDE.md` and `example/README.md`; this starts once the app is up.

## Wallet

- Every wrapper's example shares one demo key, address `0x87262957F9a48a36FfAAe3Ec79De67a38F2EFb50` on Base.
  With no target overrides a run is a same-chain deposit back to that wallet, so repeat runs spend only gas.

## Android emulator

- Never `adb shell input keyevent 111`: ESC reaches the sheet as a dismissal. Hide the keyboard with the IME's own chevron.
- `input tap` on a button that has just re-laid out registers as a long press and opens the text-selection popup.
  Screenshot between taps rather than batching them.
- The Kotlin example uses the same applicationId and the Swift example the same bundle identifier
  (`dev.rhinestone.depositmodal.example`), so installing one replaces the other.

## Inspecting the embed page over CDP

- react-native-webview enables WebView debugging only in a debug build (`ReactBuildConfig.DEBUG`), so inspect an `expo run:android` build.
- `adb shell grep webview_devtools_remote /proc/net/unix` names the socket, then
  `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`; `curl -s localhost:9333/json` lists the pages.
- Connect to the page's `webSocketDebuggerUrl` with the Origin header suppressed (`suppress_origin=True` in Python
  `websocket-client`), or the handshake 403s.
- `Runtime.evaluate` returns live DOM geometry, which settles "is this our layout?" in one call.
- `Page.captureScreenshot` re-rasters from the compositor while `adb exec-out screencap -p` reads the display.
  If the two disagree the artifact is in the surface, and no page change can fix it.
- The emulator composites through ANGLE on SwiftShader, so confirm a surface artifact on a physical device before chasing it.

## Link hand-off without a funded flow

- `target="_blank"` needs no provider link: inject an `<a target="_blank" href="https://…">` with `Runtime.evaluate` and tap it.
  It takes the same `onOpenWindow` path as the page's explorer links.
- `host.openUrl` needs no deposit: add `enableFiatOnramp: true` to the example's `config` and tap a Cash method.
  The provider page opens before any payment; `adb logcat | grep android.intent.action.VIEW` shows the hand-off.
