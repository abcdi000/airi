# Lumi Multi-User Identity

## Invariants

- A Lumi user is a person, not a login, device profile, channel, nickname, or provider account.
- Every user-owned read and write carries an immutable internal `userId`.
- External identities such as a QQ number map to an internal user and never replace it.
- A conversation and a message actor are separate. Group conversations may contain multiple actors.
- Raw chats, profiles, short-term state, and relationship state never cross user boundaries.
- Long-term memory is disclosed by an explicit scope and audience; a creator or storage row owner is not automatically allowed to widen that audience.
- Lumi-owned diary and private notes are global, but user-facing chat cannot read another user's raw data through them.
- User-facing chat cannot directly search, read, list, open, or write Lumi's raw diary, private notes, decision logs, or runtime logs. Internal hidden scheduler turns retain this access.
- Desktop `activeUserId` is a UI adapter only. Channel integrations pass an explicit interaction identity per request.
- An identity switch aborts or waits for active work, flushes the previous user, invalidates stale async work, clears scoped caches, then hydrates the next user.

## Seed Users

- Existing pre-multi-user data belongs to the first user, Doggy.
- Moussy is Doggy's girlfriend. Doggy usually calls her "宝宝" and she calls Doggy "狗".
- Doggy and Moussy often play games together.
- Moussy is Lumi's friend. Her relationship with Lumi starts independently and does not inherit Doggy's profile or relationship state.

## Data Ownership

| Data | Scope |
| --- | --- |
| Chat messages and visible history | conversation + actor; direct desktop chat is user-scoped |
| User profile and impressions | user + Lumi persona |
| Lumi self facts, such as Lumi's birthday | Lumi-global |
| Long-term relationship memory | relationship; one user + Lumi persona |
| Shareable daily events and moods | shared; all known Lumi users, normal sensitivity only |
| Group experiences | group conversation + explicit participants |
| Sensitive user memory | private; explicit user audience only |
| Short-term continuation state | user + Lumi persona |
| Trust, familiarity, conflict, boundaries | user + Lumi persona |
| Lumi mood and autonomous self-state | Lumi-global |
| Diary and private notes | Lumi-private, with provenance and disclosure metadata |
| Provider, MCP, model, and device settings | application-global |

## Memory Scopes

| Scope | Owner | Read audience | Examples |
| --- | --- | --- | --- |
| `global` | Lumi persona | Every authenticated Lumi interaction, unless marked private | Lumi's birthday and stable self facts |
| `shared` | Source user | Every authenticated Lumi interaction, normal sensitivity only | Ordinary daily events and moods that are safe to tell friends |
| `relationship` | One user | That user and Lumi | Personal preferences, impressions, one-to-one experiences |
| `group` | Conversation | Explicit conversation participants | A game session shared by Doggy, Moussy, and Lumi |
| `private` | One user or Lumi | Explicitly listed audience only | Secrets and information the user forbids Lumi to share |

Only an explicit `persona_fact` tagged `lumi_self` may become `global`. A model labeling an ordinary user fact as a persona fact is insufficient. Only normal-sensitivity `shared_event` and `emotional_echo` candidates may become `shared`; private content is forcibly downgraded to relationship/private visibility. Group retrieval requires both participant membership and matching conversation context; it must never be simulated by concatenating users' private chat histories.

The host reclassifies every curator proposal before persistence. Stored memories carry `sourceActorId`, `sourceConversationType`, `classificationReason`, and `disclosureReason` so an operator can audit why a candidate received its scope without trusting model output. Imports normalize legacy records and preserve these fields; relationship/private records restored into an explicit user archive are rebound to that archive user.

Model recall and raw inspection are separate permissions. A normal-sensitivity `shared` memory may be retrieved by Lumi in another user's direct conversation, but its raw content is not listed in that user's memory settings. The inspector lists Lumi-global self facts, memories owned by the active user, and memories belonging to groups that include that user. Group turns can retrieve global/shared memories and memories owned by that exact group, but never a participant's relationship or private memory.

Legacy relationship memories are never widened automatically. The memory settings page derives an operator review queue by re-running host policy against active records owned by the selected user. Only explicit `lumi_self` persona facts/preferences and normal-sensitivity `shared_event`/`emotional_echo` records can appear. Private records, ordinary user facts, inactive records, and anything sourced from a group are excluded. Each promotion is revalidated at execution time, recorded as a `promote` audit event, persisted with its updated disclosure metadata, and projected into already-loaded user snapshots without requiring an identity switch.

## External Identity Key

External accounts use the tuple `(provider, providerInstanceId, externalUserId)`. For QQ this means the protocol/provider, the connected bot account or deployment, and the sender QQ number. Unknown external identities remain isolated guests until explicitly linked.

## Migration

The first migration is copy-then-verify:

1. Create the identity database and seed Doggy and Moussy.
2. Record the previous local identity as Doggy.
3. Assign legacy `local` chat/profile/state/emotion data and migrated Lumi memories to Doggy.
4. Create only Moussy's confirmed seed profile facts.
5. Verify row counts and ownership before marking the migration complete.
6. Keep the previous data readable until the migration marker and verification both succeed.

Development and installed desktop builds may use different Electron `userData` directories. The development database under `@proj-airi/stage-tamagotchi` is not an automatic mirror of the installed `lumi` database. Cross-directory transfer must use the trusted archive/import flow or an explicit verified migration; the runtime must not silently merge databases.

## Concurrency

Core services accept an explicit interaction identity and must not read a mutable desktop active user. The desktop UI may serialize identity switching, while future QQ or other channel adapters can run multiple user interactions concurrently with independent request contexts.

The core sender owns one FIFO queue per execution lane, so unrelated conversations can progress concurrently and `sending` remains true until every active turn settles. Prompt contexts, memory tools, traces, user profile state, and short-term state are bound to the immutable actor captured for the turn. Direct conversations use `lumi-user:<actorId>` lanes, while group conversations use `lumi-conversation:<sessionId>` lanes. This preserves order within one person's direct relationship and within one group timeline without globally serializing Doggy and Moussy.

## Conversation Runtime

- `ChatSessionMeta.userId` remains the creator/storage owner; it is not the current speaker.
- `conversationType` distinguishes direct and group timelines.
- `participantUserIds` defines the human audience of the conversation.
- Every authored message persists `actorId` and, when known, `actorDisplayName`.
- Every send captures an immutable `ChatInteractionContext` before it enters the runtime queue.
- Provider-facing group history receives speaker labels, while internal actor metadata is removed before the provider API call.
- Legacy direct sessions are normalized to one participant and legacy messages receive deterministic actor provenance.

Group context contains only the shared group timeline. It never concatenates Doggy's and Moussy's direct histories. Global Lumi facts and memories owned by the exact group conversation may be retrieved; relationship and private memories remain outside that prompt.

Group turns do not inject a participant's direct profile, short-term state, or relationship emotion state. They also do not update those direct-user stores after the turn. Until a dedicated group-state domain exists, group continuity is represented by the shared group timeline and group-scoped long-term memories.

Tool isolation is enforced after all builtin, plugin, and MCP tools are merged. Tool Mesh plans receive the immutable interaction context for the turn. Group plans reject direct-user profile/state tools and every user-facing turn rejects Lumi-private diary, note, decision-log, and runtime-log tools. The model-facing `lumi_diary_*` plugin tools are removed from visible user turns and remain available only to hidden internal scheduler work.

Shareable experiences cross relationships only through memories classified as `global`, `shared`, or the exact current `group`. Lumi must never use a diary or private-note search as a shortcut around memory disclosure policy.

## Remote Actor Resolution

- Remote text and voice inputs may carry only an external actor claim: `provider`, `providerInstanceId`, and `externalUserId`.
- A client cannot submit an internal Lumi `userId` directly.
- The host resolves the exact external identity tuple to an active Lumi user and rejects unknown or inactive mappings.
- A requested direct session must belong to that actor; a requested group session must list that actor as a participant.
- Remote input creates or loads a detached per-user direct timeline without changing the desktop `activeUserId`.

Reliable Lumi room traffic additionally requires a per-device credential. The server overwrites `metadata.auth` with its own authenticated connection identity before routing. A room actor claim is accepted only when its provider tuple and requested conversation exactly match the credential claims, so a client cannot authenticate as one device and self-report another user or room. Remote turns receive only tools matching the credential's explicit memory, web, Minecraft, and native computer-control scopes. Unknown and newly added tool classes are denied by default; trusted local desktop turns retain the complete local tool set.

## Reliable Room Delivery

- The client owns a stable `messageId` and `idempotencyKey` for each send and persists unacknowledged sends locally.
- The host authorizes identity and conversation membership before accepting a send, then allocates a monotonic sequence in that conversation's persistent room ledger.
- Retrying an unacknowledged send reuses both identifiers. The host returns the existing receipt and never appends a second user event or starts a second model turn.
- Accepted sends are not automatically retried. After reconnect, the client requests replay from its last host cursor so a delayed or completed response is recovered without duplicating model work.
- ACKs distinguish `inputSequence` from `outputSequence`; completion, rejection, and failure are retained as bounded audit receipts.
- ACK, live model output, and replay are routed only to the originating connection. They are not broadcast to every authenticated peer.
- The host retains the newest 5,000 room events and 10,000 delivery receipts per conversation. A replay response marks `truncated` when the requested cursor predates retained history.
- Room ledgers are included in Lumi archive v3 and later export, import, and full-data deletion.

## Device Credentials

- The desktop host stores a stable host instance ID and one record per paired device.
- A device is bound to one internal user by the external tuple `(lumi-lan, hostInstanceId, deviceId)` and to one host-issued group conversation.
- Device tokens contain 256 bits of random secret material, are shown only at creation, and are persisted only as SHA-256 digests.
- Each device receives `lumi:chat` and `lumi:tool:memory`. Web/Playwright, Minecraft, and native Windows computer control are independent optional scopes.
- Chat-only credentials may announce their connection, send text, and request room replay; unrelated protocol and control events are rejected before control-event handling or routing.
- Revocation preserves audit metadata and restarts the channel server so already-authenticated sockets are disconnected immediately.
- Text sends and room replay requests are limited per device with structured retry guidance; accepted, rejected, authentication, disconnect, creation, and revocation decisions are recorded without message content or token material.
- Exclusive remote Playwright/browser, Minecraft, and Windows-control calls publish content-free resource leases containing only the resource, tool, device, actor, conversation, and timestamps. The host settings page refreshes this ownership view every two seconds.
- Operator termination closes the MCP session that owns the lease and then attempts to restore non-manual servers. The logical resource lock remains held until the interrupted call actually settles, so termination cannot create overlapping physical control.
- Resource start, finish, and operator termination are included in the bounded device audit without tool arguments, page contents, screenshots, or chat text.
- The group creator can add or remove active users. Removed users lose their session index reference, and stale clients receive an access-revoked event that purges cached room history and pending sends.
- The dedicated `lumi:channel-device` QR payload carries reachable URLs, the one-device token, the bound actor tuple, and the assigned conversation. It does not expose the legacy shared host token.
- Lumi archive v6 preserves the host ID, typed device scopes, device metadata, token hashes, and bounded device audit history so trusted full-backup restoration does not invalidate every paired device. Import migrates v5 device snapshots and legacy `lumi:tools` credentials to the explicit scope set.

## LAN Roadmap

Implemented foundations:

- Host-side external identity resolution and conversation membership authorization.
- Immutable actor context for remote input, model turns, memory, profiles, short-term state, and tracing.
- Independent direct-user lanes and serialized group-conversation lanes.
- Existing authenticated WebSocket transport remains host-authoritative for model providers, MCP credentials, databases, and memory retrieval.
- Persistent host room sequence, idempotent ingestion receipts, targeted ACKs, reconnect cursors, and bounded replay.
- A persistent client outbox that retries only never-acknowledged sends and merges replay by host sequence.
- Per-device high-entropy credentials, user binding, fine-grained tool scopes, immediate revocation, and dedicated pairing QR payloads.
- Desktop room selection and one-action creation of a shared Doggy, Moussy, and Lumi group before credential issuance.
- Pocket pairing that atomically replaces connection credentials, persists the room subscription, and opens the assigned room.
- A Pocket room surface with connection state, cursor replay, host-sequenced history, failed-send retry, and reconnect recovery.
- Archive v6 coverage for room ledgers, delivery audit receipts, typed device scopes, and the device credential registry, with migration from earlier formats.
- Creator-only group membership editing with participant-index updates and access-revocation signaling.
- Per-device text/replay rate limits plus operator-visible, content-free connection and authorization audit diagnostics.
- Final model-facing tool filtering after builtin and custom tools are merged, so a remote credential cannot recover denied builtin MCP proxy tools.
- Non-queuing host resource locks for Playwright/browser, Minecraft, and native computer-control actions across concurrent remote turns.
- Operator-visible exclusive resource leases with double-confirmed MCP session termination and automatic non-manual server recovery.
- Turn-owned TTS sessions with one ordered playback queue, preventing concurrent conversations from cancelling or cross-feeding each other's speech.
- Reliable room voice delivery with bounded WAV payloads, host-owned transcription, persistent client retry data, payload fingerprinting, cancellation, and exactly-once chat ingestion.

Remaining work before internet tunneling:

1. Define a public-tunnel deployment profile with origin restrictions, transport encryption, credential rotation, and stricter connection-level limits.

Do not expose the current development server through public internet tunneling until the remaining rate-limit and client hardening work is complete.
