# @proj-airi/lumi-runtime

Lumi runtime contracts for the AIRI migration.

This package is intentionally contract-first. It preserves Lumi's persona,
state, memory, image-understanding, and provider boundaries without copying the
old Python `ChatService` into AIRI.

It also owns the framework-independent Planner/Replyer contracts, social
language learning, expression selection, validation, and replay projection.
See [`../../docs/lumi/social-language-system.md`](../../docs/lumi/social-language-system.md).

Use this package when a stage, provider, plugin, or future runtime adapter needs
to exchange Lumi-shaped data. Do not put model calls, database persistence, UI
state, or avatar control logic in this package.

## Sub2API protocol

`@proj-airi/lumi-runtime/providers/sub2api` is the browser-safe protocol layer
shared by Lumi Server and the offline Electron client. It owns URL
normalization, model-catalog parsing, Responses request/SSE handling, strict
Auto fallback classification, usage mapping, and redacted provider errors.

Use this entrypoint when implementing a Sub2API transport. Keep account storage,
provider configuration, model execution, tool authorization, and tool execution
in their owning server or client runtime. The module intentionally depends only
on Web Platform APIs and must remain safe to bundle into an Electron renderer.

