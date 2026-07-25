# @proj-airi/lumi-server-runtime

The authoritative Node runtime for Lumi Online. It owns account-to-person
mapping, invitations, conversation membership, reliable message sequencing,
server backups, and per-conversation execution lanes.

Online social-language state is server-authoritative, backed up with the main
database, and uses the existing singleton vector worker when semantic
expression retrieval is enabled. See
[`../../docs/lumi/social-language-system.md`](../../docs/lumi/social-language-system.md).

Use it only in the Lumi server process. Windows and Pocket clients should use
`@proj-airi/lumi-online` and must never import this package.

## AstrBot perception

`LumiAstrBotIntegration` is the trusted boundary for external AstrBot events.
It resolves configured external identities to server-owned Lumi people, sends
raw images through Lumi Eyes, sends raw audio through Lumi hearing, preserves
segment order, and submits one turn to the existing consciousness runtime.

`createLumiNetworkServer` exposes authenticated health and perception routes
only when its `astrbot` option is configured. Do not expose these routes
without a random token of at least 32 characters, and never accept a Lumi
person ID from an AstrBot request.
