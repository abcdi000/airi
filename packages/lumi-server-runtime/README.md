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

## Shared Agent Runtime

`createServerAgentRuntime()` adapts the platform-neutral
`@proj-airi/lumi-agent-runtime` to server-owned facilities:

- account-bound identity and conversation membership;
- authoritative SQLite session persistence;
- scoped memories and public group knowledge;
- social-language selection and feedback;
- Tool Mesh, MCP, plugin, sticker, and builtin tools;
- reliable multi-message delivery;
- model request traces and usage metadata.

The server starts one logical agent session per conversation. Messages in one
conversation remain FIFO while separate conversations may execute concurrently.
The model never receives an outbound transport directly; delivery requires a
host-issued direct-conversation capability.

## Runtime modes

- `legacy`: the existing consciousness path remains authoritative.
- `shadow`: shared runtime executes without visible output or side effects.
- `maisaka`: shared runtime is the sole online Lumi reply authority.

Server Manager exposes these settings under Model and Consciousness. Switching
modes does not rewrite memory, identity, MCP, plugin, or chat data.

## Prompt overrides

Server Manager can configure an optional prompt directory. Relative paths are
resolved from the Lumi Server configuration file. The server looks for these
UTF-8 files:

```text
planner.txt
replyer.txt
expression_selector.txt
expression_learning.txt
jargon_learning.txt
behavior_learning.txt
public_group_knowledge_learning.txt
context_summary.txt
```

A missing file keeps Lumi's built-in prompt. An empty override is rejected so
a partially edited file cannot silently remove a runtime contract. Overrides
are plain text only and are never executed. Their version is derived from the
content hash, and model-request audits store only prompt ID, version, hash,
duration, usage, and cache telemetry unless private prompt logging is
explicitly enabled.

## Restart behavior

The SQLite adapter persists typed history, completed event IDs, summaries,
generation counters, and wait continuations. Server startup calls
`resumePersistedSessions()` so a pending timeout wait is re-armed rather than
forgotten. Reliable message IDs remain the delivery and replay authority.

## Group observation

Allowlisted group observations use a separate, read-only runtime. Each group
has an independent FIFO batch and retry state, so one incomplete or failing
group cannot block another group that is ready for curation. Group input may
create reviewed expression, jargon, behavior, public-knowledge, and sticker
learning candidates; it has no outbound capability.

## AstrBot perception

`LumiAstrBotIntegration` is the trusted boundary for external AstrBot events.
It resolves configured external identities to server-owned Lumi people, sends
raw images through Lumi Eyes, sends raw audio through Lumi hearing, preserves
segment order, and submits one turn to the existing consciousness runtime.

`createLumiNetworkServer` exposes authenticated health and perception routes
only when its `astrbot` option is configured. Do not expose these routes
without a random token of at least 32 characters, and never accept a Lumi
person ID from an AstrBot request.

## Verification

```powershell
pnpm -F @proj-airi/lumi-server-runtime test
pnpm -F @proj-airi/lumi-server-runtime typecheck
```
