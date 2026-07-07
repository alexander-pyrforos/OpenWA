# OpenWA Meilisearch Indexer (plugin)

Indexes every persisted message into Meilisearch for global search. Listens to the host's
`message:persisted` hook; writes via the sandboxed `ctx.net.fetch` (SSRF-guarded).

## Setup

1. Run Meilisearch, e.g. `docker run -d --name meilisearch -p 7700:7700 getmeili/meilisearch:latest`.
2. Enable the host's search (set `MEILISEARCH_URL=http://localhost:7700`) — the query API + bulk
   reindex live in core and read this env var.
3. Enable this plugin and set its config:
   - `meilisearchUrl` — **must match the host's `MEILISEARCH_URL`**. The plugin and the query API
     must talk to the same instance, or search will return stale/empty results.
   - `meilisearchApiKey` — only if your Meilisearch requires a key.
   - `indexPrefix` — **must match the host's `MEILISEARCH_INDEX_PREFIX`** (default `openwa_`).

## Localhost / SSRF note

`ctx.net.fetch` is SSRF-guarded, so it blocks loopback/internal IPs unless the host allowlists them.
If Meilisearch runs on `localhost`/`127.0.0.1`, set on the host:
```
SSRF_ALLOWED_HOSTS=localhost,127.0.0.1
```
The plugin's `net.allowConfigHosts: ["meilisearchUrl"]` admits the host you configure here; the
SSRF guard still vetoes the resolved IP unless it's in `SSRF_ALLOWED_HOSTS`. For a remote Meilisearch
(public host), no SSRF env is needed.

## http vs https — host allowlist

`net.allowConfigHosts` only auto-admits **https** config URLs (credentialed or non-https values are
ignored, and the SSRF guard still blocks private IPs at connect). If your `meilisearchUrl` is
`http://...` (e.g. a local Meilisearch), add its `host:port` to `net.allow` in the manifest instead,
e.g. `"net": { "allow": ["localhost:7700"], "allowConfigHosts": ["meilisearchUrl"] }`. For production,
prefer an https Meilisearch endpoint so `allowConfigHosts` covers it.

## Backfill

Run the core bulk reindex once after enabling: `POST /api/messages/search/reindex` with an ADMIN key.
The plugin indexes new messages in real time thereafter.