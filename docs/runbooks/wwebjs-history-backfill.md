# Runbook: wwebjs history backfill

> **When to use:** A session has historical messages in the `messages` table that are missing the
> per-sender `author` / `contact` / `senderPhone` metadata (the bubble shows no name/phone above the
> body for group messages). The live Baileys engine never re-sends `messaging-history.set`, so the
> only way to enrich old messages is a one-shot backfill under `whatsapp-web.js`.
>
> **Cost:** ~5–10 minutes of operator work + 1–3 hours of script runtime, depending on chat count.
> Linked device shows as "OpenWA" on the phone during the backfill.
>
> **Caveats — read first:**
> - The script runs inside the API container (`docker exec`) so it shares the same Nest DI graph as
>   the live process. Run it from the host, not from inside a `bash -lc` chain.
> - Linked Devices cap: WhatsApp limits an account to ~5 (sometimes 10) linked devices. Check the
>   phone before linking a fresh wwebjs device.
> - The script is **idempotent** thanks to `messages.UQ_messages_sessionId_waMessageId`. Re-running
>   over the same chats is safe and only lands the gaps. `--resume-from` is a convenience, not a
>   correctness requirement.
> - Puppeteer spawns Chromium, which wants ~500MB–1GB RAM. Verify the container has headroom with
>   `docker stats openwa-api` before starting.
> - The script persists messages with `author` enrichment but does **not** re-fetch media. The
>   2026-07-16 truncation of `message_media_descriptors` is a separate, irreversible data loss.

## When you should NOT run this

- The session is already under Baileys and shows `author` labels correctly on new messages. The
  dashboard `Chats.tsx:1387-1428` render block already gates on `metadata.author || isGroup`, so
  missing labels on OLD messages is the only symptom that warrants this runbook.
- The session is `qr_ready` (no auth state) and you haven't yet decided whether wwebjs or Baileys
  will be the steady-state engine. Pick the engine first; if Baileys, the `INITIAL_BOOTSTRAP` sync
  on first link will populate `author` natively — no backfill needed.

## Pre-flight

1. Identify the target session id and its current state:
   ```bash
   docker exec openwa-api \
     curl -sS "http://127.0.0.1:3000/api/sessions" \
     -H "X-API-Key: $(docker exec openwa-api sh -c 'cat /app/data/.api-key')" \
     | jq '.data[] | {id, name, status, engine}'
   ```
2. Confirm the target's `status` is either `qr_ready` (no auth state) or `ready` under Baileys.
   - If `ready` under Baileys with messages you want to enrich: the backfill will unlink the
     Baileys device when you stop the session, so plan to re-link under Baileys after.
3. Pick a low-traffic window. The script throttles at 1500ms/chat by default; expect 1–3 hours
   for ~75 chats.
4. Snapshot the DB before starting (defensive — the script never deletes, but rollback is cheap):
   ```bash
   docker exec openwa-postgres pg_dump -U openwa -d openwa --table=messages \
     > ~/openwa-deploy/messages-pre-backfill-$(date +%Y%m%d-%H%M).sql
   ```

## Step 1 — switch engine to wwebjs

Edit `~/openwa-deploy/.env` (or `docker-compose.override.yml` if the value is pinned there):
```bash
sed -i 's/^ENGINE_TYPE=baileys/ENGINE_TYPE=whatsapp-web.js/' ~/openwa-deploy/.env
# or, if not set:
echo 'ENGINE_TYPE=whatsapp-web.js' >> ~/openwa-deploy/.env
```

Restart the API:
```bash
cd ~/openwa-deploy && docker compose up -d --no-deps --force-recreate openwa-api
```

Confirm the boot log shows `Engine plugin enabled: whatsapp-web.js`:
```bash
docker logs openwa-api 2>&1 | grep -i "engine plugin enabled"
```

## Step 2 — link the session

```bash
KEY=$(docker exec openwa-api sh -c 'cat /app/data/.api-key')
SID="<target-session-uuid>"

# Start the session (wwebjs will show a QR)
docker exec openwa-api \
  curl -sS -X POST "http://127.0.0.1:3000/api/sessions/${SID}/start" \
  -H "X-API-Key: $KEY"

# Fetch the QR, decode it, save to a file
docker exec openwa-api \
  curl -sS "http://127.0.0.1:3000/api/sessions/${SID}/qr" \
  -H "X-API-Key: $KEY" \
  | jq -r .qrCode | base64 -d > /tmp/qr.png
# Open /tmp/qr.png on a screen, scan from phone → Linked Devices
```

Wait for `status=ready`:
```bash
until [ "$(docker exec openwa-api curl -sS "http://127.0.0.1:3000/api/sessions/${SID}" -H "X-API-Key: $KEY" | jq -r .data.status)" = "ready" ]; do
  sleep 2
done
```

## Step 3 — test on one chat first (optional but recommended)

If you have a chatId handy, smoke-test the script on a single chat:
```bash
docker exec openwa-api npm run backfill:history:wwebjs -- \
  --session-id "$SID" \
  --rate-ms 1500 \
  --batch-size 50 \
  --chat-id "<single-chat-jid>"
```

Verify a group message got `author` populated in metadata:
```bash
docker exec openwa-postgres psql -U openwa -d openwa -tAc \
  "select metadata->'author', metadata->'contact'->>'pushName' \
   from messages where \"sessionId\"='$SID' and \"chatId\" like '%@g.us' \
   and metadata ? 'author' limit 1"
```
Expected: a row with the author's JID and pushName.

## Step 4 — full backfill

```bash
docker exec openwa-api npm run backfill:history:wwebjs -- \
  --session-id "$SID" \
  --rate-ms 1500 \
  --batch-size 50
```

The script logs one line per chat (`[N/M] <chatId> history=K`) and a final summary
(`Done. chats=M processed=K chatsFailed=F elapsed=Ns`).

Mid-run resume: if the script is killed (Ctrl-C, container restart, OOM), re-run with
`--resume-from <chatId>` to skip already-processed chats. Pick a chatId alphabetically after the
last `[N/M]` line you saw in the log. The script is idempotent on `waMessageId` so even without
`--resume-from` a re-run only re-processes the current chat.

## Step 5 — unlink wwebjs and re-link under Baileys

```bash
# Stop the wwebjs session (unlinks the device on the phone)
docker exec openwa-api \
  curl -sS -X POST "http://127.0.0.1:3000/api/sessions/${SID}/stop" \
  -H "X-API-Key: $KEY"

# Switch engine back to Baileys
sed -i 's/^ENGINE_TYPE=whatsapp-web.js/ENGINE_TYPE=baileys/' ~/openwa-deploy/.env
cd ~/openwa-deploy && docker compose up -d --no-deps --force-recreate openwa-api

# Start the session under Baileys and scan the new QR
docker exec openwa-api \
  curl -sS -X POST "http://127.0.0.1:3000/api/sessions/${SID}/start" \
  -H "X-API-Key: $KEY"
# (Scan QR again from the phone — the wwebjs device was unlinked on stop)
```

## Step 6 — verify

1. Open the dashboard, navigate to a chat you backfilled, scroll to an old group message. The
   bubble should now show the sender's pushName and phone number above the body.
2. Spot-check the DB count: `author`-enriched rows should be > 0 for any group chat in the
   session:
   ```bash
   docker exec openwa-postgres psql -U openwa -d openwa -tAc \
     "select count(*) from messages where \"sessionId\"='$SID' and metadata ? 'author'"
   ```
3. Confirm new inbound messages still get `author` metadata (Baileys steady state). Send a
   message to a group from another phone; the new row's `metadata` should have `author`.

## Rollback

The script only ever inserts. To roll back a bad backfill, restore from the pre-flight snapshot:
```bash
docker exec -i openwa-postgres psql -U openwa -d openwa < \
  ~/openwa-deploy/messages-pre-backfill-<timestamp>.sql
```
This drops all rows inserted after the snapshot. The new-message flow is unaffected.

## Known issues

- **WhatsApp rate limit (429):** the script retries each chat 3 times with 5s/15s/45s backoff. If a
  chat fails all 3, it's logged and the run continues with the next chat. Inspect the log for
  `Chat <chatId> failed after retries` and re-run with `--chat-id <chatId>` after a few minutes.
- **Linked Devices cap hit:** `start` returns an error. Delete another device on the phone and
  retry. There is no in-app workaround.
- **Container OOM:** wwebjs + Chromium plus the API can exceed a 2GB container limit. Bump
  `mem_limit` in `docker-compose.override.yml` to 4GB or run on a less-loaded host.
