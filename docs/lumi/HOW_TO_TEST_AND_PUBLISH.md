# How To Test And Publish The Lumi Migration

## Local Verification

Run from `D:\pyProject\AIRI\airi`.

```powershell
pnpm -F @proj-airi/lumi-runtime typecheck
pnpm -F @proj-airi/stage-ui typecheck
pnpm -F @proj-airi/stage-tamagotchi typecheck
.\node_modules\.bin\vitest.CMD run --config packages\lumi-runtime\vitest.config.ts
.\node_modules\.bin\vitest.CMD run --config packages\stage-ui\vitest.config.ts packages\stage-ui\src\stores\lumi-memory.test.ts packages\stage-ui\src\stores\modules\airi-card.test.ts packages\stage-ui\src\stores\chat\context-providers\lumi.test.ts packages\stage-ui\src\stores\modules\vision\orchestrator.test.ts
conda run -n airi python -m py_compile scripts\lumi\export_lumi_migration.py
conda run -n airi python scripts\lumi\export_lumi_migration.py
```

Expected results:

- Lumi runtime typecheck passes.
- Stage UI typecheck passes.
- Stage Tamagotchi desktop typecheck passes.
- Lumi runtime tests pass.
- AIRI card store tests pass.
- Lumi context provider tests pass.
- Lumi memory store tests pass.
- Vision orchestrator tests include Lumi Eyes metadata.
- Export script prints 125 AIRI chat sessions and 158 active runtime memories.

On this Codex desktop sandbox, Vitest may fail before running tests with `EPERM` while Vite writes `node_modules\.vite-temp`. That is a sandbox filesystem issue, not a failed assertion. Typecheck and Python export validation should still pass without escalation.

## Run AIRI Desktop

```powershell
pnpm dev:tamagotchi
```

This starts the Electron desktop app. If Vite reports `EPERM` while writing `.vite-temp` in this sandbox, rerun from a normal PowerShell window on your machine.

The web app is still useful for quick checks, but the migration is wired through shared `stage-ui` stores and the desktop app consumes the same chat/card runtime:

```powershell
pnpm dev:web
```

## Test Desktop Migration Status

1. Start AIRI desktop with `pnpm dev:tamagotchi`.
2. Open Settings.
3. Open Data.
4. Find `Lumi migration`.
5. Confirm it shows `runtime context ready`.
6. Confirm the counts show 125 chats, 379 total memories, 158 active memories, 3 profiles, and 23 states.
7. Use `Copy path` if you want to copy the chat import file path.
8. Open `Candidate memory review`.
9. Activate, reject, or archive one candidate memory.
10. Confirm the status counters update.

## Test The Lumi Card

1. Start AIRI desktop.
2. Open settings and find the character/card area.
3. Confirm there is a card named `Lumi`.
4. Select `Lumi`.
5. Start a new chat.
6. Send:

```text
Lumi, are you there?
```

Expected behavior:

- The active card name is `Lumi`.
- The seeded prompt tells Lumi to call the user `Doggy`.
- Lumi keeps a warm, emotionally reactive, non-customer-service style.
- Lumi does not claim a physical body or unverified real-world senses.
- While the active card is `Lumi`, AIRI injects a compact migrated PersonaOS context with profile, state, and active recallable memories.
- Other cards do not receive Lumi's migrated context.
- Desktop Vision Capture context updates include `metadata.lumiImageUnderstanding` for Lumi Eyes-style image understanding.

## Import Lumi Chat History

The migrated AIRI chat export is:

```text
docs\lumi\migrated-data\airi-chat-sessions-lumi.json
```

In AIRI desktop:

1. Open Settings.
2. Open Data.
3. In Chats, click Import.
4. Select `docs\lumi\migrated-data\airi-chat-sessions-lumi.json`.
5. Switch to the Lumi card.
6. Open the sessions drawer.

Expected behavior:

- Imported sessions are under character id `lumi`.
- There are 125 imported Lumi sessions.
- Each imported session starts with a Lumi system message.
- Some old records may still contain unrecoverable mojibake if the original SQLite row was already corrupted, but the exporter repairs common recoverable cases.

## Re-export From Lumi

If the Lumi database changes, rerun:

```powershell
conda run -n airi python scripts\lumi\export_lumi_migration.py --source D:\pyProject\NewChatBot\persona_os.db --target D:\pyProject\AIRI\airi\docs\lumi\migrated-data
```

This also regenerates:

```text
packages\lumi-runtime\src\generated\migrated-context.ts
```

Do not copy:

- `.env`
- `persona_os.db`
- Chroma binary index files
- local model weights
- `__pycache__`

## Publish To GitHub

Inspect changes:

```powershell
git status --short
git diff --stat
git diff -- apps\stage-tamagotchi\src\renderer\pages\settings\data packages\lumi-runtime packages\stage-ui\src\constants\lumi-card.ts packages\stage-ui\src\stores\modules\airi-card.ts packages\stage-ui\src\stores\modules\vision packages\stage-ui\src\stores\chat packages\stage-ui\src\stores\lumi-memory.ts packages\stage-ui\src\stores\lumi-memory.test.ts packages\stage-ui\src\stores\lumi-migration.ts scripts\lumi docs\lumi
```

Stage only the migration files:

```powershell
git add apps\stage-tamagotchi\src\renderer\pages\settings\data packages\lumi-runtime docs\lumi scripts\lumi packages\stage-ui\src\constants\lumi-card.ts packages\stage-ui\src\composables\use-data-maintenance.ts packages\stage-ui\src\stores\modules\airi-card.ts packages\stage-ui\src\stores\modules\airi-card.test.ts packages\stage-ui\src\stores\modules\vision\orchestrator.ts packages\stage-ui\src\stores\modules\vision\orchestrator.test.ts packages\stage-ui\src\stores\lumi-memory.ts packages\stage-ui\src\stores\lumi-memory.test.ts packages\stage-ui\src\stores\lumi-migration.ts packages\stage-ui\src\stores\chat.ts packages\stage-ui\src\stores\chat\context-providers pnpm-lock.yaml
```

Do not accidentally stage unrelated existing changes such as:

```text
integrations\vscode\vscode-airi\package.json
```

Commit:

```powershell
git commit -m "feat(lumi): migrate Lumi persona context to AIRI desktop"
```

Push:

```powershell
git push origin HEAD
```

If you want a pull request and have GitHub CLI configured:

```powershell
gh pr create --draft --fill
```
