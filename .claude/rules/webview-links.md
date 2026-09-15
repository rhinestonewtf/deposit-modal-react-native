---
paths:
  - src/DepositSheet.tsx
---

# Links leaving the web view

- **Each `target="_blank"` or `window.open` on Android orphans an `about:blank` web view that outlives the sheet.**
  react-native-webview's `onCreateWindow` builds a plain `WebView` for the popup and never destroys it; it holds no bridge, and `onOpenWindow` cannot reach it.
