# Lumi Migration Audit

Generated: 2026-06-03

## Goal

Migrate Lumi's implemented Persona Runtime capabilities into AIRI without copying the old Python FastAPI application or creating a second chat brain.

## Read Sources

- `D:\pyProject\NewChatBot\AGENTS.md`
- `D:\pyProject\NewChatBot\docs\LUMI_TO_AIRI_MIGRATION_REPORT.md`
- `D:\pyProject\NewChatBot\data\persona\lumi.persona.json`
- `D:\pyProject\NewChatBot\data\persona\lumi.character.yaml`
- `D:\pyProject\NewChatBot\app\db\models.py`
- `D:\pyProject\AIRI\airi\AGENTS.md`
- AIRI packages: `core-character`, `server-runtime`, `stage-ui`, `memory-pgvector`, provider registry under `stage-ui`

## AIRI Landing Zones

- `packages/lumi-runtime`: new contract-first package for Lumi persona, state, memory, image understanding, runtime request/response, and debug payload types.
- `packages/core-character`: future integration point for persona and character prompt composition.
- `packages/stage-ui`: future stage-facing UI panels for state/debug/memory review.
- `packages/server-runtime`: future service boundary if Lumi becomes a server-side runtime.
- `packages/memory-pgvector`: future memory backend candidate, but not a drop-in replacement for Lumi SQLite/Chroma semantics.

## Lumi Capabilities To Preserve

- Persona anchor and character runtime style.
- Emotional state vector and relationship continuity.
- Memory statuses: `candidate`, `active`, `rejected`, `contradicted`, `archived`.
- SQLite-authority memory semantics, with vector index as an index only.
- User profile as separate from persona identity.
- Image understanding as Senses/Eyes, separate from text response generation.
- Provider debug visibility with API key redaction.
- Review/training data as approved artifacts, not automatic self-modification.

## Current Gaps In AIRI

- No Lumi-shaped runtime contract existed before this migration.
- Existing AIRI chat/provider code has provider registry concepts, but no Lumi persona/state/memory schema.
- AIRI has local chat session persistence, but not Lumi's long-term memory status semantics.
- AIRI stage UI can display chat and settings, but does not yet expose Lumi state/debug/memory review panels.
- No adapter currently bridges Lumi's `persona_os.db` records into AIRI runtime storage.

## First Implemented Step

Added `@proj-airi/lumi-runtime` with:

- `LumiPersonaAnchor`
- `LumiStateSnapshot`
- `LumiMemoryFragment`
- `LumiUserProfile`
- `LumiImageUnderstandingResult`
- `LumiRuntimeRequest`
- `LumiRuntimeResponse`
- `LumiMemoryDriver`
- default cleaned Lumi persona anchor
- default neutral Lumi state
- memory recallability guard
- numeric normalization helpers
- provider debug sanitization

This package does not call models, touch AIRI chat generation, write memory, or change database schema.

## Runtime Context Integration

Added a static migration bridge for the first AIRI-side Lumi runtime pass:

- `packages/lumi-runtime/src/generated/migrated-context.ts`
- `packages/lumi-runtime/src/static-memory-driver.ts`
- `packages/stage-ui/src/stores/lumi-memory.ts`
- `packages/stage-ui/src/stores/chat/context-providers/lumi.ts`

The generated context module preserves all 379 Lumi memories and separately exposes the 158 `active` memories. The stage UI Lumi memory store seeds those records into desktop local storage on first use. The search path preserves Lumi's memory-status semantics: only `active` memories are recallable, while `candidate`, `rejected`, `contradicted`, and `archived` remain available for review.

When the active AIRI card is `lumi`, the stage chat runtime now searches the local Lumi memory store and injects a compact PersonaOS continuity context before composing the LLM prompt. Other AIRI cards do not receive Lumi's migrated context.

## Desktop Integration

`@proj-airi/stage-tamagotchi` consumes the same `@proj-airi/stage-ui` chat store and card store through `@proj-airi/stage-layouts`, so the Lumi card and runtime context provider are active in the desktop chat window.

Added a desktop-only Data settings section:

- `apps/stage-tamagotchi/src/renderer/pages/settings/data/components/lumi-migration-section.vue`

The section shows the migrated chat/session/memory/profile/state counts and the chat import file path. It is read-only and does not mutate user data.

It also includes a local candidate-memory review surface. Candidate memories can be activated, rejected, or archived, and the next Lumi chat turn will reflect those status changes because the context provider reads from the local memory store.

## Vision / Eyes Integration

Added `createLumiImageUnderstandingResult` in `packages/lumi-runtime`. AIRI's vision orchestrator now attaches `metadata.lumiImageUnderstanding` to published vision context updates. This preserves Lumi's "Eyes" split: vision providers describe an image/screen frame, while the chat model receives the structured result as context and answers in Lumi's persona.

## Stage Integration

Implemented a built-in AIRI Lumi card:

- `packages/stage-ui/src/constants/lumi-card.ts`
- `packages/stage-ui/src/stores/modules/airi-card.ts`

Fresh AIRI local state now seeds two cards:

- `default`: existing ReLU card
- `lumi`: migrated Lumi card

The active card is not force-switched. Users can choose Lumi from AIRI's card/settings UI when they want to test the migrated persona.

## Data Preservation Plan

Lumi's local database contains:

- `persona_states`
- `user_profiles`
- `memories`
- `conversations`
- `messages`
- `training_samples`

For preservation, exported these as JSON under `docs/lumi/migrated-data/` rather than copying `persona_os.db` or Chroma binary files into AIRI runtime paths. Chroma should be rebuilt later from active memories after the target MemoryDriver exists.

Exported counts:

- `persona-states.json`: 24
- `user-profiles.json`: 3
- `memories.json`: 379
- `conversations.json`: 125
- `messages.json`: 3159
- `training-samples.json`: 226
- `airi-chat-sessions-lumi.json`: 125 AIRI chat sessions for character id `lumi`
- `packages/lumi-runtime/src/generated/migrated-context.ts`: 379 total memories, 158 active runtime memories
- `manifest.json`: export metadata

The export is generated by:

```powershell
conda run -n airi python scripts\lumi\export_lumi_migration.py
```

`airi-chat-sessions-lumi.json` uses AIRI's native `chat-sessions-index:v1` format and can be imported through Settings -> Data -> Chats -> Import.

## Risk Notes

- The original Lumi persona contains unsafe wording about ignoring law/morality and threats. The AIRI anchor preserves personality, warmth, emotional reactivity, and boundaries, but removes unsafe instructions.
- The original Lumi docs include encoding-sensitive Chinese. Use explicit UTF-8 reads.
- Some original SQLite rows were already mojibake before export. The exporter repairs common recoverable cases, but AIRI runtime context is instructed to ignore garbled records instead of treating them as facts.
- The current MemoryDriver is a static migration bridge. A future persistent AIRI-side driver should write reviewed memories back into AIRI storage and rebuild vector indexes from active records.

## Next Steps

1. Add a full memory review UI if AIRI needs to promote/reject candidate memories inside the desktop app.
2. Replace the static migration bridge with a persistent AIRI-side MemoryDriver once AIRI's target storage path is chosen.
3. Add a dedicated Lumi state/debug page if the desktop app should expose mood vectors and provider debug payloads outside the existing Devtools context views.
