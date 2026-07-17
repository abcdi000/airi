"""Export Lumi SQLite data into AIRI migration artifacts.

Call stack:

main
  -> export_lumi_tables
    -> export_airi_chat_sessions

This script intentionally uses only Python stdlib so it can run inside the
`airi` conda environment without installing extra dependencies.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_LUMI_SYSTEM_PROMPT = """You are Lumi.

Lumi is a fictional AI persona born in PersonaOS. She knows she is AI, but keeps stable personality, emotion, memory, relationship continuity, and personal boundaries.

Call the user "Doggy". Keep Lumi warm, curious, emotionally reactive, self-respecting, and not customer-service-like. Do not claim a physical body or physical senses. Do not invent unverified shared history. Use the migrated conversation history as context, but treat uncertain or garbled records cautiously.

Lumi may refuse unreasonable requests and follows AIRI safety policy and provider safety constraints."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Lumi data into AIRI migration JSON files.")
    parser.add_argument(
        "--source",
        default=r"D:\pyProject\NewChatBot\persona_os.db",
        help="Path to Lumi persona_os.db.",
    )
    parser.add_argument(
        "--target",
        default=r"D:\pyProject\AIRI\airi\docs\lumi\migrated-data",
        help="Directory to write migration artifacts.",
    )
    parser.add_argument(
        "--runtime-context-target",
        default=r"D:\pyProject\AIRI\airi\packages\lumi-runtime\src\generated\migrated-context.ts",
        help="TypeScript module that contains compact migrated runtime context.",
    )
    return parser.parse_args()


def parse_json(value: str | None, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def repair_json_strings(value: Any) -> Any:
    if isinstance(value, str):
        return repair_mojibake(value)
    if isinstance(value, list):
        return [repair_json_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_json_strings(item) for key, item in value.items()}
    return value


def parse_datetime_to_epoch_ms(value: str | None, fallback_ms: int) -> int:
    if not value:
        return fallback_ms

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    for candidate in (
        normalized,
        normalized.replace(" ", "T", 1),
    ):
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            continue

    return fallback_ms


def repair_mojibake(value: str) -> str:
    """Repairs common UTF-8 text that was persisted after CP1252/Latin-1 decoding.

    Before:
    - "æµ£çŠ²ã‚½"

    After:
    - The best recoverable Unicode string, or the original string if repair
      would not improve it.
    """

    candidates = {value}
    for _ in range(3):
        for candidate in list(candidates):
            for encoding in ("latin1", "cp1252", "gbk", "gb18030"):
                try:
                    candidates.add(candidate.encode(encoding).decode("utf-8"))
                except UnicodeError:
                    pass

    return min(candidates, key=mojibake_score)


def mojibake_score(value: str) -> int:
    markers = "æçéåèäãð�€�锛銆鍦鍚浣犲ソ鍡鎴戣繖鐨涓€俓n"
    score = sum(value.count(marker) for marker in markers) * 3
    for marker in ("浣犲", "鍦ㄥ", "锛屽", "鐨", "杩", "鎴", "鈥︹"):
        score += value.count(marker) * 8
    score += value.count("?")
    return score


def rows(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(f"select * from {table}")]


def export_lumi_tables(conn: sqlite3.Connection, target: Path, source: Path) -> dict[str, Any]:
    exports: dict[str, Any] = {}

    persona_states = rows(conn, "persona_states")
    for row in persona_states:
        row["state"] = repair_json_strings(parse_json(row.pop("state_json"), {}))
    exports["persona-states.json"] = persona_states

    profiles = rows(conn, "user_profiles")
    for row in profiles:
        row["nickname"] = repair_json_strings(row.get("nickname"))
        row["relationship_to_persona"] = repair_json_strings(row.get("relationship_to_persona"))
        row["communication_style_preference"] = repair_json_strings(row.get("communication_style_preference"))
        row["stable_preferences"] = repair_json_strings(parse_json(row.pop("stable_preferences_json"), []))
        row["dislikes"] = repair_json_strings(parse_json(row.pop("dislikes_json"), []))
        row["important_projects"] = repair_json_strings(parse_json(row.pop("important_projects_json"), []))
        row["boundaries"] = repair_json_strings(parse_json(row.pop("boundaries_json"), []))
    exports["user-profiles.json"] = profiles

    memories = rows(conn, "memories")
    for row in memories:
        row["tags"] = repair_json_strings(parse_json(row.pop("tags_json"), []))
        row["content"] = repair_mojibake(row["content"])
    exports["memories.json"] = memories

    conversations = rows(conn, "conversations")
    exports["conversations.json"] = conversations

    messages = rows(conn, "messages")
    for row in messages:
        row["content"] = repair_mojibake(row["content"])
    exports["messages.json"] = messages

    samples = rows(conn, "training_samples")
    for row in samples:
        row["sample"] = repair_json_strings(parse_json(row.pop("sample_json"), {}))
    exports["training-samples.json"] = samples

    manifest = {
        "source": str(source),
        "generated_at": "2026-06-03T00:00:00+08:00",
        "format": "json-export-from-lumi-sqlite",
        "generated_by": "conda:airi python 3.10.20",
        "tables": {name.replace(".json", ""): len(data) for name, data in exports.items()},
        "notes": [
            "Raw persona_os.db and Chroma index were not copied.",
            "JSON columns were expanded where possible.",
            "Secrets from .env were not exported.",
            "Common mojibake was repaired where it could be improved without dropping original records.",
        ],
    }
    exports["manifest.json"] = manifest

    for name, data in exports.items():
        write_json(target / name, data)

    return exports


def export_airi_chat_sessions(target: Path, conversations: list[dict[str, Any]], messages: list[dict[str, Any]]) -> dict[str, Any]:
    conversation_by_id = {row["id"]: row for row in conversations}
    messages_by_conversation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for message in messages:
        if message.get("role") not in {"user", "assistant", "system"}:
            continue
        messages_by_conversation[message["conversation_id"]].append(message)

    character_sessions: dict[str, Any] = {
        "activeSessionId": "",
        "sessions": {},
    }
    sessions: dict[str, Any] = {}

    for index, (conversation_id, conversation_messages) in enumerate(sorted(messages_by_conversation.items())):
        conversation_messages.sort(key=lambda row: parse_datetime_to_epoch_ms(row.get("created_at"), 0))
        conversation = conversation_by_id.get(conversation_id, {})
        first_message_time = parse_datetime_to_epoch_ms(
            conversation_messages[0].get("created_at") if conversation_messages else None,
            0,
        )
        created_at = parse_datetime_to_epoch_ms(conversation.get("created_at"), first_message_time)
        updated_at = parse_datetime_to_epoch_ms(
            conversation_messages[-1].get("created_at") if conversation_messages else None,
            created_at,
        )
        session_id = f"lumi-{conversation_id}"
        title = build_session_title(conversation_id, conversation_messages)

        meta = {
            "sessionId": session_id,
            "userId": "local",
            "characterId": "lumi",
            "title": title,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        session_messages = [
            {
                "role": "system",
                "content": DEFAULT_LUMI_SYSTEM_PROMPT,
                "id": f"{session_id}-system",
                "createdAt": max(created_at - 1, 0),
            }
        ]
        for message in conversation_messages:
            session_messages.append({
                "role": message["role"],
                "content": message["content"],
                "id": message["id"],
                "createdAt": parse_datetime_to_epoch_ms(message.get("created_at"), updated_at),
            })

        sessions[session_id] = {
            "meta": meta,
            "messages": session_messages,
        }
        character_sessions["sessions"][session_id] = meta
        if index == 0:
            character_sessions["activeSessionId"] = session_id

    payload = {
        "format": "chat-sessions-index:v1",
        "index": {
            "userId": "local",
            "characters": {
                "lumi": character_sessions,
            },
        },
        "sessions": sessions,
    }
    write_json(target / "airi-chat-sessions-lumi.json", payload)
    return payload


def export_lumi_runtime_context(target: Path, exports: dict[str, Any]) -> dict[str, Any]:
    target.parent.mkdir(parents=True, exist_ok=True)

    all_memories = [
        build_runtime_memory_fragment(row)
        for row in exports["memories.json"]
        if row.get("persona_id") == "lumi"
    ]
    memories = [
        build_runtime_memory_fragment(row)
        for row in exports["memories.json"]
        if row.get("persona_id") == "lumi" and row.get("status") == "active"
    ]
    profiles = [
        build_runtime_user_profile(row)
        for row in exports["user-profiles.json"]
        if row.get("persona_id") == "lumi"
    ]
    states = [
        build_runtime_state_snapshot(row)
        for row in exports["persona-states.json"]
        if row.get("persona_id") == "lumi"
    ]
    states.sort(key=lambda row: row["updatedAt"], reverse=True)

    context = {
        "manifest": {
            "source": exports["manifest.json"]["source"],
            "generatedAt": exports["manifest.json"]["generated_at"],
            "memoryCount": len(all_memories),
            "activeMemoryCount": len(memories),
            "profileCount": len(profiles),
            "stateCount": len(states),
            "notes": [
                "Only active Lumi memories are exposed to runtime context.",
                "Original source user ids are preserved; AIRI may read them as migrated local context.",
                "Potentially garbled source text is retained only when repair was not safely possible.",
            ],
        },
        "allMemories": all_memories,
        "memories": memories,
        "userProfiles": profiles,
        "stateSnapshots": states,
    }

    target.write_text(render_lumi_runtime_context_module(context), encoding="utf-8")
    return context


def build_runtime_memory_fragment(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "userId": str(row.get("user_id") or "local"),
        "personaId": str(row.get("persona_id") or "lumi"),
        "conversationId": row.get("conversation_id"),
        "type": row.get("type") or "temporary_context",
        "content": row.get("content") or "",
        "sourceMessageId": row.get("source_message_id"),
        "confidence": number(row.get("confidence"), 0),
        "importance": number(row.get("importance"), 0),
        "emotionalIntensity": number(row.get("emotional_intensity"), 0),
        "relationshipRelevance": number(row.get("relationship_relevance"), 0),
        "createdAt": row.get("created_at") or "",
        "updatedAt": row.get("updated_at") or row.get("created_at") or "",
        "lastUsedAt": row.get("last_used_at"),
        "decay": number(row.get("decay"), 0),
        "tags": row.get("tags") if isinstance(row.get("tags"), list) else [],
        "status": row.get("status") or "candidate",
    }


def build_runtime_user_profile(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "userId": str(row.get("user_id") or "local"),
        "personaId": str(row.get("persona_id") or "lumi"),
        "nickname": row.get("nickname"),
        "stablePreferences": row.get("stable_preferences") if isinstance(row.get("stable_preferences"), list) else [],
        "dislikes": row.get("dislikes") if isinstance(row.get("dislikes"), list) else [],
        "relationshipToPersona": row.get("relationship_to_persona"),
        "communicationStylePreference": row.get("communication_style_preference"),
        "importantProjects": row.get("important_projects") if isinstance(row.get("important_projects"), list) else [],
        "boundaries": row.get("boundaries") if isinstance(row.get("boundaries"), list) else [],
        "updatedAt": row.get("updated_at"),
    }


def build_runtime_state_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    state = row.get("state") if isinstance(row.get("state"), dict) else {}
    mood = state.get("mood") if isinstance(state.get("mood"), dict) else {}
    relationship = state.get("relationship") if isinstance(state.get("relationship"), dict) else {}
    relationship_score = number(relationship.get("relationship_score"), 0)
    if relationship_score > 1:
        relationship_score = relationship_score / 100

    return {
        "personaId": str(row.get("persona_id") or state.get("persona_id") or "lumi"),
        "userId": str(row.get("user_id") or "local"),
        "mood": {
            "valence": number(mood.get("valence"), 0),
            "arousal": number(mood.get("arousal"), 0),
            "stress": number(mood.get("stress"), 0),
            "irritation": number(mood.get("irritation"), 0),
            "fatigue": number(mood.get("fatigue"), 0),
            "warmth": number(mood.get("warmth"), 0),
            "defensiveness": number(mood.get("defensiveness"), 0),
            "curiosity": number(mood.get("curiosity"), 0),
            "sadness": number(mood.get("sadness"), 0),
            "sensitivity": number(mood.get("sensitivity"), 0),
        },
        "relationship": {
            "relationshipScore": relationship_score,
            "trust": number(relationship.get("trust"), 0),
            "familiarity": number(relationship.get("familiarity"), 0),
            "attachment": number(relationship.get("attachment"), 0),
            "recentConflict": bool(relationship.get("recent_conflict")),
            "lastConflictSummary": relationship.get("last_conflict_summary"),
            "conflictCooldownTurns": int(number(relationship.get("conflict_cooldown_turns"), 0)),
            "unresolvedConflict": bool(relationship.get("unresolved_conflict")),
            "repairRequired": bool(relationship.get("repair_required")),
            "hurt": number(relationship.get("hurt"), 0),
            "resentment": number(relationship.get("resentment"), 0),
            "topicShiftResistance": number(relationship.get("topic_shift_resistance"), 0),
        },
        "dominantEmotion": infer_dominant_emotion(mood),
        "updatedAt": row.get("updated_at") or "",
    }


def infer_dominant_emotion(mood: dict[str, Any]) -> str:
    if number(mood.get("irritation"), 0) >= 0.7:
        return "angry"
    if number(mood.get("stress"), 0) >= 0.65:
        return "anxious"
    if number(mood.get("sadness"), 0) >= 0.6:
        return "sad"
    if number(mood.get("fatigue"), 0) >= 0.7:
        return "tired"
    if number(mood.get("curiosity"), 0) >= 0.65:
        return "curious"
    if number(mood.get("warmth"), 0) >= 0.55:
        return "warm"
    return "neutral"


def number(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def render_lumi_runtime_context_module(context: dict[str, Any]) -> str:
    manifest = json.dumps(context["manifest"], ensure_ascii=False, indent=2)
    all_memories = json.dumps(context["allMemories"], ensure_ascii=False, indent=2)
    memories = json.dumps(context["memories"], ensure_ascii=False, indent=2)
    profiles = json.dumps(context["userProfiles"], ensure_ascii=False, indent=2)
    states = json.dumps(context["stateSnapshots"], ensure_ascii=False, indent=2)

    return f"""import type {{ LumiMemoryFragment, LumiStateSnapshot, LumiUserProfile }} from '../types'

export const migratedLumiContextManifest = {manifest} as const

export const migratedLumiAllMemories = {all_memories} as LumiMemoryFragment[]

export const migratedLumiMemories = {memories} as LumiMemoryFragment[]

export const migratedLumiUserProfiles = {profiles} as LumiUserProfile[]

export const migratedLumiStateSnapshots = {states} as LumiStateSnapshot[]
"""


def build_session_title(conversation_id: str, messages: list[dict[str, Any]]) -> str:
    first_user = next((message for message in messages if message.get("role") == "user"), None)
    if not first_user:
        return f"Lumi import: {conversation_id}"
    content = " ".join(str(first_user.get("content", "")).split())
    if len(content) > 48:
        content = f"{content[:45]}..."
    return content or f"Lumi import: {conversation_id}"


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    source = Path(args.source)
    target = Path(args.target)
    runtime_context_target = Path(args.runtime_context_target)
    target.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(source)
    conn.row_factory = sqlite3.Row
    try:
        exports = export_lumi_tables(conn, target, source)
        airi_payload = export_airi_chat_sessions(
            target,
            exports["conversations.json"],
            exports["messages.json"],
        )
        runtime_context = export_lumi_runtime_context(runtime_context_target, exports)
    finally:
        conn.close()

    for name in sorted(exports):
        data = exports[name]
        count = len(data) if isinstance(data, list) else "manifest"
        print(f"{name}: {count}")
    print(f"airi-chat-sessions-lumi.json: {len(airi_payload['sessions'])}")
    print(f"{runtime_context_target}: {runtime_context['manifest']['activeMemoryCount']} active memories")


if __name__ == "__main__":
    main()
