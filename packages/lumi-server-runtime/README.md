# @proj-airi/lumi-server-runtime

The authoritative Node runtime for Lumi Online. It owns account-to-person
mapping, invitations, conversation membership, reliable message sequencing,
server backups, and per-conversation execution lanes.

Use it only in the Lumi server process. Windows and Pocket clients should use
`@proj-airi/lumi-online` and must never import this package.
