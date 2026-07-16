# Handoff: wwebjs history backfill → Baileys steady state

## Context

A previous session (2026-07-16) implemented per-message sender labels in the
dashboard. The backend now persists `author` / `isGroup` / `contact` /
`senderPhone` into `messages.metadata` on every new inbound message (commit
`e4a832d`), and the bubble renders the name + phone above the body. This
works for new messages.

**The gap:** 1.85M historical messages on prod (across `analytics-wa` and
`boutique-client-wa`) have no `author` info. The user truncated them
intentionally on 2026-07-16 hoping Baileys would re-send `messaging-history.set`
on re-socket. It did not — WhatsApp's server-side sync cache marks the
account as "already synced" and only sends a `RECENT` delta on subsequent
connects, never a full `INITIAL_BOOTSTRAP` replay
(`@whiskeysockets/baileys/lib/Socket/chats.js:1072`,
`historySyncStatus.initialBootstrapComplete`).

**boutique-client-wa** is currently `qr_ready` (no auth state — creds dir
empty). The user explicitly approved a hybrid approach: link under
whatsapp-web.js, run `getChatHistory` per chat to populate `messages` with
`author`, then unlink wwebjs and re-link under Baileys for steady state.

This handoff is for that work.

## What's already done (do NOT redo)

- Backend persist for `author` / `isGroup` / `contact` / `senderPhone` →
  `messages.metadata`: `src/modules/session/session.service.ts:795-820`
- `ChatMessage.metadata` type: `dashboard/src/services/api.ts:174-187`
- `ChatMessageView.metadata` type: `dashboard/src/utils/chatMessages.ts:69-79`
- `IncomingWsMessage` carries the fields + WS handler copies them into
  `mappedMessage.metadata`: `dashboard/src/pages/Chats.tsx:55-71, 297-323`
- `senderInfo` render block: `dashboard/src/pages/Chats.tsx:1387-1428`
- CSS: `dashboard/src/pages/Chats.css` `.message-sender-name`
- Commit `0e71fa7`: backend `SearchHit.matchStart` / `matchLength`
- Commit `e4a832d`: inline search highlight + sender label

All deployed to prod as of 2026-07-16 14:25. Live messages on
`analytics-wa` (currently `ready`) now write `author` / `contact` etc.
to `metadata` on arrival. `boutique-client-wa` is `qr_ready`.

## The plan: wwebjs history backfill

### Why wwebjs (not Baileys)

Baileys only sends `messaging-history.set` ONCE per account. There is no
"re-fetch history" API. The Baileys adapter deliberately gates
`getChatHistory` to `EngineNotSupportedError` (returns 501 to the API)
at `src/engine/adapters/baileys.adapter.ts:874-875`. The user's
`analytics-wa` is already past its one-shot sync, so even a full
re-link+resync on Baileys would not guarantee a complete pull.

`whatsapp-web-js` uses a real Chromium + DOM scroll. `getChatHistory`
works for ANY chat at ANY time — it just calls
`client.getChatById(chatId).fetchMessages({ limit })` and walks the
result. Each `IncomingMessage` returned already has `author` populated
for group messages (via `buildIncomingMessageBase` in
`src/engine/adapters/message-mapper.ts`).

### Architecture

Single CLI script run inside the API container (or via `docker exec`).
Sequence per session:

1. **Set `ENGINE_TYPE=whatsapp-web.js`** in container env, restart API.
   The wwebjs plugin is already shipped under `src/plugins/engines/whatsapp-web-js/`
   with a `manifest.json` — `EngineFactory` will pick it up.
2. **Start the session** via `POST /api/sessions/:id/start` → engine
   opens, wwebjs shows QR. Operator scans from phone (manual step —
   surface QR via `GET /api/sessions/:id/qr`).
3. **Wait for `status=ready`** (poll `GET /api/sessions/:id` or
   subscribe to WS `session:status` event).
4. **Run backfill script** (TBD — see "Deliverables" below):
   - List all chats via `engine.getChats()` (already exposed via
     `GET /api/sessions/:id/chats` or directly via
     `sessionService.getChats`).
   - For each chat: call `engine.getChatHistory(chatId, limit, false)` in
     batches. Throttle — `sleep(1500ms)` between chats to avoid
     WhatsApp rate limits.
   - For each `IncomingMessage` returned, call
     `messageService.create(sessionId, ...)` (or hit the engine's
     onMessage callback path so the existing persist logic at
     `session.service.ts:773-883` runs end-to-end and writes
     `metadata.author` / `isGroup` / `contact` / `senderPhone`). The
     existing `captureHistoryMessages` in
     `baileys.adapter.ts:1387-1448` is Baileys-specific (calls
     `mapHistoryMessage`) — wwebjs needs its own equivalent.
5. **Stop the wwebjs session** via `POST /api/sessions/:id/stop`. This
   calls `engine.logout()` which unlinks the device on the phone.
6. **Set `ENGINE_TYPE=baileys`**, restart API.
7. **Start the session under Baileys**, scan QR again.
8. Live activity resumes under Baileys; history rows already in DB keep
   the `author` from step 4.

### Deliverables (in order)

#### D1 — `scripts/wwebjs-history-backfill.ts` (CLI command)

Standalone Nest standalone application or plain `ts-node` script. Reads
from CLI args (or env):
- `--session-id <uuid>` (required) — which session to backfill
- `--rate-ms <ms>` (default 1500) — sleep between chats
- `--batch-size <n>` (default 50) — `getChatHistory(chatId, limit)`
- `--include-media` (default false) — pass true to wwebjs (heavier)
- `--chat-id <jid>` (optional, repeatable) — restrict to a subset
  (handy for testing on a single chat first)
- `--resume-from <chatId>` (optional) — skip chats before this one
  (alpha sort) for resume after a crash

Loads `AppModule` from `src/app.module.ts` via `NestFactory.createApplicationContext`
so it can use `SessionService` + `MessageService` directly. NOT a
background job — runs to completion or Ctrl-C, then exits.

Pseudo-flow:
```
ctx = await NestFactory.createApplicationContext(AppModule);
session = await ctx.get(SessionService).findOne(sessionId);
if (session.status !== 'ready') throw new Error('session not ready');

engine = await ctx.get(SessionService).getEngine(sessionId);
chats = await engine.getChats();
for chat in sortedById(chats):
  history = await engine.getChatHistory(chat.id, batchSize, includeMedia);
  for msg in history:
    await persistHistoryMessage(ctx, sessionId, msg);  // see D2
  sleep(rateMs);
  log progress;
await ctx.close();
```

#### D2 — `persistHistoryMessage` in `message.service.ts` (or new method on `SessionService`)

Reuse the same write path the live `onMessage` handler uses at
`src/modules/session/session.service.ts:786-821`. Two options:

- **A. Extract a private method** on `SessionService` that takes
  `IncomingMessage` and does the full persist (resolve senderPhone for
  LID, build metadata, create DB row, dispatch webhook, emit WS).
  Call it from both `onMessage` and the new backfill script.
  Cleanest, no duplication.

- **B. Add `wwebjs.adapter.ts:onHistoryMessages` callback** that calls
  the same persist. Wwebjs adapter does NOT currently have
  `onHistoryMessages` like Baileys does (see
  `baileys.adapter.ts:1387`). The wwebjs client uses a polling model
  (`chat.fetchMessages`), not a push, so this is really just the
  same code as A but scoped to the wwebjs flow.

Pick A — reuse the existing code. Backfill just calls
`sessionService.persistIncomingMessage(sessionId, incoming)` which
already does senderPhone resolution for LID senders and writes
`metadata.author` / `isGroup` / `contact` / `senderPhone`.

#### D3 — `package.json` script

```json
"backfill:history:wwebjs": "ts-node -r tsconfig-paths/register scripts/wwebjs-history-backfill.ts"
```

#### D4 — `npm run` integration with docker entrypoint

The `docker-entrypoint.sh` should accept an env var
`OPENWA_BACKFILL_SESSION=<uuid>` and, if set, run the backfill script
once after API boot, then keep the API process running. Useful for the
prod deploy — flip engine → start API with backfill env → script runs
inside the container → done. Document this in the runbook section below.

Alternative (simpler): keep the script standalone, run via
`docker exec openwa-api npm run backfill:history:wwebjs -- --session-id <uuid>`
from the host. No entrypoint changes.

**Recommended: standalone. No entrypoint change.** Operator runs the
script via `docker exec` after each phase.

#### D5 — Idempotency

`messages.UQ_messages_sessionId_waMessageId` already exists
(`@Unique(['sessionId', 'waMessageId'])`). The live `onMessage` handler
dedupes at the source with a `findOne` + `skip if exists` before
insert. Reuse that exact logic in `persistIncomingMessage`:
- Query for existing row with `(sessionId, waMessageId)`. If found,
  skip (or `ON CONFLICT DO NOTHING`).
- This makes the script safely re-runnable. `--resume-from` is a
  convenience, not a correctness requirement.

#### D6 — Tests

- **Unit**: `persistIncomingMessage` in `session.service.spec.ts` —
  verify it writes the `metadata.author` / `isGroup` / `contact` /
  `senderPhone` keys exactly as the live handler does (regression for
  the `e4a832d` fix).
- **Integration**: SQLite-backed test with a mock engine that returns
  a `getChatHistory` payload with author/contact, assert the DB row
  has them in `metadata`.
- **CLI smoke**: the script exits 0 with `--session-id <bogus>` and a
  clear error message (no stack trace). Exits 0 with a real session
  that has 0 chats. Exits 0 on Ctrl-C (SIGINT handler logs progress
  and exits cleanly).

### Files to touch (or create)

- `scripts/wwebjs-history-backfill.ts` — new CLI script
- `src/modules/session/session.service.ts` — extract
  `persistIncomingMessage` private method from `onMessage` body
  (lines ~773-820). Both the live handler and the backfill script
  call it.
- `src/modules/session/session.service.spec.ts` — add tests for
  `persistIncomingMessage` (LID senderPhone resolution,
  metadata.author passthrough, dedup on existing waMessageId)
- `package.json` — add `"backfill:history:wwebjs"` script
- `docs/runbooks/wwebjs-history-backfill.md` — operator runbook
  (created in D7)

### Files to leave alone

- `src/engine/adapters/whatsapp-web-js.adapter.ts` — already has
  working `getChatHistory` at line 1610. Do not modify.
- `src/engine/adapters/baileys.adapter.ts` — leave alone. After
  backfill, this engine will run on the same session. Auth state is
  re-created by the operator's re-link, no migration needed.
- Dashboard — already supports the new fields. No change.
- Migrations — none needed. `metadata` is `text` and free-form.
- `src/plugins/engines/whatsapp-web-js/` — already loaded and
  functional. No change.

### Deploy

After implementation passes CI:

1. Build image locally: `docker compose up -d --build --no-deps
   --force-recreate openwa-api`
2. Save image: `docker save -o /tmp/openwa-api.tar
   openwa-openwa-api:latest`
3. scp to `chrono-dev@192.168.0.15`: `~/openwa-deploy/openwa-api.tar.gz`
4. `docker load -i openwa-api.tar.gz` on prod
5. Keep container at current state (Baileys still running for
   `analytics-wa` — do not touch). The backfill script will be run
   per-session at operator's discretion, not on every deploy.

### Operator runbook (to be saved as `docs/runbooks/wwebjs-history-backfill.md`)

For each session that needs the historical `author` enrichment:

```bash
# On wa-srv (192.168.0.15), in ~/openwa-deploy:

# 1) Switch engine to wwebjs
#    Edit .env or override: ENGINE_TYPE=whatsapp-web.js
#    (Boutique does NOT need this — it's already qr_ready, no
#    auth state. Wwebjs will create a fresh wwebjs_auth/ dir
#    inside BAILEYS_AUTH_DIR/<sessionName>/wwebjs/ or wherever
#    the plugin's sessionDataPath points.)

# 2) Restart the API
docker compose up -d --no-deps --force-recreate openwa-api

# 3) Start the session
KEY=$(cat /app/data/.api-key)
SID="0fe0072d-e216-4221-a1df-b1a396ea14cc"
curl -sS -X POST "http://127.0.0.1:2886/api/sessions/${SID}/start" \
  -H "X-API-Key: $KEY"

# 4) Show QR, scan from phone
curl -sS "http://127.0.0.1:2886/api/sessions/${SID}/qr" \
  -H "X-API-Key: $KEY" | jq -r .qrCode | base64 -d > /tmp/qr.png
# (Open /tmp/qr.png on a screen, scan from phone → Linked Devices)

# 5) Wait for status=ready (poll or use WS)
until [ "$(curl -sS "http://127.0.0.1:2886/api/sessions/${SID}" -H "X-API-Key: $KEY" | jq -r .status)" = "ready" ]; do
  sleep 2
done

# 6) Run the backfill script (inside the container, so it can use
#    the same Nest DI graph as the API)
docker exec openwa-api npm run backfill:history:wwebjs -- \
  --session-id "$SID" \
  --rate-ms 1500 \
  --batch-size 50

# 7) Stop the wwebjs session (unlinks the device on the phone)
curl -sS -X POST "http://127.0.0.1:2886/api/sessions/${SID}/stop" \
  -H "X-API-Key: $KEY"

# 8) Switch engine back to Baileys in .env, restart API
sed -i 's/ENGINE_TYPE=whatsapp-web.js/ENGINE_TYPE=baileys/' .env
docker compose up -d --no-deps --force-recreate openwa-api

# 9) Start the session under Baileys, scan QR again
curl -sS -X POST "http://127.0.0.1:2886/api/sessions/${SID}/start" \
  -H "X-API-Key: $KEY"
# (Scan QR from phone)
```

### Risks & open questions for the next session

1. **Wwebjs `sessionDataPath`** — where does the wwebjs plugin store
   its creds? If it's under `data/plugins/whatsapp-web-js/sessions/<id>/`,
   wiping it for re-link under Baileys later is a no-op (Baileys uses
   a different dir). Need to confirm by reading the plugin's
   `index.ts` and `manifest.json` `configSchema`.
2. **Phone Linked Devices cap** — WhatsApp caps linked devices at ~5
   (sometimes 10). If the user already has 4+ devices, the new
   wwebjs link will fail. Check via `engine.getContacts()` or a
   `whatsapp-web.js` API.
3. **`getChatHistory` rate-limit behavior** — wwebjs's
   `chat.fetchMessages({ limit })` will throw or hang if WA throttles.
   The script needs a retry-with-backoff (3 attempts, 5s/15s/45s).
4. **Mid-chat backfill crash** — script writes to DB transactionally
   per message; a crash mid-chat means re-running will re-process
   the chat from scratch (dedup on `waMessageId` keeps DB consistent,
   but it wastes time). Add `--resume-from <chatId>` to make
   resume-by-chatId practical.
5. **Media descriptors** — `message_media_descriptors` was truncated
   on 2026-07-16. The wwebjs `getChatHistory(includeMedia=true)`
   would re-populate it for messages that have media, but for the
   1.25M descriptors that existed, no recovery path. Out of scope for
   this handoff — note as known data loss.
6. **Container resource usage under wwebjs** — Puppeteer spawns
   Chromium, which wants ~500MB-1GB per session. If the prod
   container has 2GB RAM limit, running wwebjs + the API + Postgres
   + Redis + MinIO is tight. Check `docker stats openwa-api` before
   starting the backfill; if memory is tight, run on a non-prod host
   first or temporarily bump the container's memory limit.
7. **analytics-wa is currently `ready` under Baileys** — DO NOT
   truncate it again. If the user wants the same treatment for
   analytics-wa later, the runbook is the same (steps 1-9 above with
   `analytics-wa`'s session id). The 1.85M lost on 2026-07-16 are
   gone forever; this backfill only helps future activity and any
   rows already in the DB.

### Scope check: is this really one plan?

Yes. Single goal: enrich historical message rows with `author` /
`contact` / `senderPhone` metadata. Single deliverable shape: a CLI
script + an extracted persist method. One operator runbook. No
architectural changes.

If the next session wants to also recover `analytics-wa`'s lost 489k
messages, that's a separate task and would need an explicit
"re-truncate + backfill analytics-wa too" decision from the user.

### Verification (for the next session)

After implementing, on a non-prod session (or on a fresh test session):

1. `npm test` — new spec passes; existing tests untouched
2. `npm run lint` — clean
3. `npm run typecheck` (or `nest build`) — clean
4. Manual smoke: link a test session under wwebjs, run
   `npm run backfill:history:wwebjs -- --session-id <id>
   --chat-id <singleChat>`, verify the DB row for a known group
   message has `metadata.author` populated. Use:
   `docker exec openwa-postgres psql -U openwa -d openwa -tAc \
    "select metadata->'author', metadata->'contact'->>'pushName' \
     from messages where \"sessionId\"='<id>' and \"chatId\" like \
     '%@g.us' limit 1"`
5. Re-run the script on the same chat — verify no duplicates
   (count unchanged, all rows have same `waMessageId`).
6. Deploy to prod, run the runbook for `boutique-client-wa`
   (currently `qr_ready` — easy target). Verify ~75 chats process
   in <1 hour, no rate-limit errors in the log.
