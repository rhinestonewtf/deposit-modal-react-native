---
"@rhinestone/deposit-modal-react-native": minor
---

Size the sheet to the flow it is showing. The page publishes a `contentHeight`
on `ui.state`, and the sheet is drawn here rather than presented as a
`pageSheet` — which is a fixed near-full-height box with no detent API reachable
from JavaScript, so a one-row screen was presented at the height of the whole
deposit flow.

Drawing it also makes the dismissal lock enforceable against a swipe: a drag
down and a tap outside both go through `ui.back` and the page's dismissal
policy, where `pageSheet`'s own interactive swipe could not be refused.

A page that publishes no height presents exactly as before.
