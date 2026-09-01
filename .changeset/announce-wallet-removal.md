---
"@rhinestone/deposit-modal-react-native": patch
---

Tell the page when the wallet goes away. Clearing the `wallet` prop mid-session
pushed nothing, so the page kept rendering the account it last heard about and
the next wallet action answered 4200 instead of the page falling back to the
funding paths that need none. Capabilities settle once at hello by design, so
`wallet.state` is the only channel that can say it.
