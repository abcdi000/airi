# Lumi Server

Standalone Node process that owns Lumi Online authentication, conversations,
memory, model generation, and server-side tools. It is managed by Lumi Server
Manager in packaged Windows builds and never creates an Electron window.

Use `pnpm -F @proj-airi/lumi-server start` for local development. Do not use
this process for offline-client data; online and offline storage are separate.
