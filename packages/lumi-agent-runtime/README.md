# Lumi Agent Runtime

`@proj-airi/lumi-agent-runtime` is Lumi's platform-neutral, host-managed agent
runtime. It owns direct-conversation session state, typed context, Planner
rounds, tool discovery and execution, Replyer projection, wait/interrupt
semantics, read-only group observation, and runtime traces.

Use it from desktop and server adapters. Do not import Vue, Pinia, Electron,
AstrBot, a concrete database, or platform send APIs into this package.

## Runtime flow

```text
authenticated direct perception
  -> isolated conversation session
  -> identity/profile projection
  -> typed and token-budgeted context
  -> Planner step
  -> host tool execution
  -> explicit reply intent
  -> policy validation
  -> tool-free Replyer
  -> capability-gated outbound
  -> persistence and deferred learning feedback
```

Planner content is never sent directly. A visible response exists only after
the Planner calls the first-class `reply` tool and the host validates its
semantic intent. Replyer receives no tools and cannot bypass Tool Mesh,
identity, privacy, or relationship policy.

## Public boundaries

- `LumiAgentRuntime.ingestDirect()` accepts only `DirectPerceptionEnvelope`.
- `GroupObservationRuntime.observe()` accepts only
  `GroupObservationEnvelope`.
- Outbound methods require an opaque `DirectOutboundCapability`.
- Persistence, models, identity, memory, tools, stickers, and outbound delivery
  are supplied through ports.

Group observation has no outbound port. It can produce reviewed learning
candidates, but it cannot reply, invoke direct-chat actions, or acquire a
direct outbound capability.

## Migration modes

| Mode | Visible authority | Side effects |
| --- | --- | --- |
| `legacy` | Existing AIRI/Lumi orchestrator | Existing behavior only |
| `shadow` | Existing orchestrator | Shared runtime is read-only and invisible |
| `maisaka` | Shared Lumi Agent Runtime | Shared runtime owns reply and tools |

Desktop defaults to `shadow`. Server configuration is independent and is
managed by Lumi Server Manager. Non-Lumi AIRI cards always continue to use the
existing `ChatOrchestratorRuntime`.

## Configuration

| Option | Default | Meaning |
| --- | ---: | --- |
| `plannerMaxRounds` | `10` | Maximum host-managed Planner rounds |
| `plannerNoToolRetryLimit` | `2` | Limited retries when Planner writes plain text without choosing a tool |
| `plannerFinalizationMode` | `maibot` | Whether Planner observes reply results before ending |
| `mergeWindowMs` | `80` | Quiet window used to merge rapid direct inputs |
| `toolMaxConcurrency` | `4` | Maximum independent tool calls per execution plan |
| `toolStepTimeoutMs` | `30000` | Timeout for one tool step |
| `plannerRequestTimeoutMs` | `90000` | Timeout for one Planner request; cancellation releases the conversation queue immediately |
| `deferredToolsEnabled` | `true` | Exposes `tool_search` and allows deferred tools to become visible |
| `expressionSelectorEnabled` | `true` | Allows the host's model-backed expression selector |
| `directLanguageFeedbackEnabled` | `true` | Lets verified direct-chat feedback adjust existing group-learned candidates |
| `promptLoggingEnabled` | `false` | Includes recursively redacted prompt bodies in private traces |
| `multiMessageReplyEnabled` | `true` | Allows Replyer to produce up to three messages |
| `plannerHistoryBudgetTokens` | `700000` | Planner history selection budget |
| `plannerHistoryMaxMessages` | `120` | Hard history cap protecting providers when approximate token counts are low |
| `contextCompactionThresholdTokens` | `760000` | Background compaction threshold |
| `contextRecentTokens` | `160000` | Recent dialogue retained verbatim during compaction |
| `contextCompactionThresholdMessages` | `160` | Message-count trigger used alongside the token estimate |
| `contextRecentMessages` | `96` | Recent context-bearing messages retained verbatim after compaction |

Hosts should keep Planner and Replyer system prompts stable. Current time,
turn-local identity, retrieved references, and tool results belong in typed
turn messages so provider prefix caches can reuse the stable prefix.

## Prompt templates and traces

The runtime defines stable IDs for `planner`, `replyer`,
`expression_selector`, `expression_learning`, `jargon_learning`,
`behavior_learning`, `public_group_knowledge_learning`, and
`context_summary`. A host may replace their text, but must preserve the
template ID and supply a version. Every model-request trace records the
template ID, version, and deterministic hash.

Prompt bodies are excluded from traces by default. When
`promptLoggingEnabled` is explicitly enabled, messages are recursively
redacted before they leave the runtime. Authorization headers, bearer tokens,
API keys, passwords, credentials, and similarly named JSON fields are never
stored verbatim.

## Persistence

`AgentPersistencePort` owns session history, generation, completed-event
idempotency records, summary checkpoints, and wait continuation state. Hosts
must:

1. persist atomically after state changes;
2. implement `listWaitingSessionIds()` when waits must survive restart;
3. call `resumePersistedSessions()` once after startup;
4. keep storage isolated by conversation and runtime mode.

Desktop currently stores this runtime ledger in local IndexedDB/localForage.
The visible chat history remains the recovery seed. Runtime settings are
included in Lumi's complete local-data archive; the internal Planner ledger is
device-local and is rebuilt from visible history after a data migration.

## Replay comparison

The repository replay command compares legacy projection, Replyer-only,
complete runtime, and expression/behavior/sticker feature combinations:

```powershell
pnpm lumi:language-replay
```

The sample output reports selected expression, behavior, and sticker IDs for
each variant without calling an external model.

## Verification

Run the package tests and type check:

```powershell
pnpm -F @proj-airi/lumi-agent-runtime test
pnpm -F @proj-airi/lumi-agent-runtime typecheck
```

The clean-room concept mapping and migration boundary are documented in
[`../../docs/lumi/MAIBOT_CLEAN_ROOM_MAPPING.md`](../../docs/lumi/MAIBOT_CLEAN_ROOM_MAPPING.md).
