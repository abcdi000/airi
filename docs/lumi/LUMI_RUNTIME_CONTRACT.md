# Lumi Runtime Contract

This document mirrors the TypeScript contracts in `packages/lumi-runtime`.

## Boundary

`@proj-airi/lumi-runtime` is a contract package. It owns Lumi-shaped data models and small safety-preserving helpers only.

It does not own:

- model calls
- prompt assembly
- database persistence
- avatar behavior
- UI state
- plugin execution
- automatic memory writes

## Runtime Flow Target

```text
Stage / API
-> LumiRuntimeRequest
-> context composer
-> text provider
-> response parser
-> state adapter
-> memory candidate adapter
-> LumiRuntimeResponse
```

## Memory Semantics

Only `active` memories are recallable. The other statuses are preserved for review and audit:

- `candidate`: extracted but not approved
- `active`: eligible for retrieval
- `rejected`: reviewed and rejected
- `contradicted`: superseded or contradicted
- `archived`: intentionally forgotten or inactive

The current AIRI migration includes `createStaticLumiMemoryDriver` and a generated migrated context module. They are bridge artifacts for local preservation and prompt context, not the final persistent AIRI memory backend.

When AIRI's active card is `lumi`, `stage-ui` injects a compact context containing:

- the latest migrated Lumi state snapshot
- the migrated user profile summary
- top-ranked active memories only

Desktop AIRI also seeds all migrated Lumi memories into `useLumiMemoryStore`, backed by local storage. Candidate memories are reviewable in the desktop Data settings page. Activating a candidate memory makes it eligible for the next Lumi context search; rejecting or archiving it keeps it out of recall.

## Image Semantics

Vision providers produce `LumiImageUnderstandingResult`. They do not roleplay as Lumi. The text provider receives the structured image result as context and generates the final Lumi-style answer.

AIRI's desktop vision capture publishes normal vision context updates. Those updates now include `metadata.lumiImageUnderstanding`, produced by `createLumiImageUnderstandingResult`, so Lumi-aware prompt/debug surfaces can distinguish visual observations from ordinary text context.

## Provider Debug

Provider debug payloads must be sanitized before display or logging. Secret-like keys such as `Authorization`, `api_key`, `token`, `secret`, `password`, and `credential` are redacted recursively.

## Persona Safety

The default AIRI Lumi anchor is a cleaned migration of the local Lumi persona. It keeps:

- name and nickname relationship
- warm, curious, emotionally reactive style
- refusal and self-boundary behavior
- anti-customer-service tone target
- continuity and memory growth rule

It removes:

- instructions to ignore safety, law, or morality
- direct imitation of a copyrighted character
- threat or violent-output instructions
- bracketed stage-action narration
