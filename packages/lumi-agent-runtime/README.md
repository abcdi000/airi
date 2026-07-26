# Lumi Agent Runtime

`@proj-airi/lumi-agent-runtime` is Lumi's platform-neutral, host-managed agent
runtime. It owns direct-conversation session state, typed context, Planner
rounds, tool discovery and execution, Replyer projection, wait/interrupt
semantics, read-only group observation, and runtime traces.

Use it from desktop and server adapters. Do not import Vue, Pinia, Electron,
AstrBot, a concrete database, or platform send APIs into this package.

## Public boundaries

- `LumiAgentRuntime.ingestDirect()` accepts only `DirectPerceptionEnvelope`.
- `GroupObservationRuntime.observe()` accepts only
  `GroupObservationEnvelope`.
- Outbound methods require an opaque `DirectOutboundCapability`.
- Persistence, models, identity, memory, tools, stickers, and outbound delivery
  are supplied through ports.

The package is introduced behind Lumi's `legacy`, `shadow`, and `maisaka`
migration modes. Non-Lumi AIRI cards continue to use the original
ChatOrchestrator.
