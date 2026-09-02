---
"@rhinestone/deposit-modal-react-native": patch
---

`onFatal` now carries the web view's own description when the page fails to
load, and Android's numeric code with it. Without them a DNS failure, a TLS
failure, an offline device and a proxy refusing the origin all arrived as the
same sentence, and that sentence is the integrator's only instrument.
