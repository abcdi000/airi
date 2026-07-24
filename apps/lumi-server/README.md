# Lumi Server

Standalone Node process that owns Lumi Online authentication, conversations,
memory, model generation, and server-side tools. It is managed by Lumi Server
Manager in packaged Windows builds and never creates an Electron window.

Use `pnpm -F @proj-airi/lumi-server start` for local development. Do not use
this process for offline-client data; online and offline storage are separate.

The optional `astrbot` config enables the AstrBot perception bridge. Each
`platformInstanceId + externalUserId` must be explicitly bound to an existing
Lumi person. Optional `vision` and existing `transcription` settings provide
server-owned image and audio perception; AstrBot never supplies interpreted
descriptions or transcripts.

See [the AstrBot plugin guide](../../integrations/astrbot/astrbot_plugin_lumi/README.md)
for the complete configuration and installation guide.
