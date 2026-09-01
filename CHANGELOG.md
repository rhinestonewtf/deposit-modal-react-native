# @rhinestone/deposit-modal-react-native

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
