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

