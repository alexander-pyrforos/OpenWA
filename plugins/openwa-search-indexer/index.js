/**
 * OpenWA Meilisearch indexer plugin (sandboxed, EXTENSION, sessionScoped:false).
 *
 * Subscribes to the `message:persisted` hook and upserts each message into the Meilisearch
 * `openwa_messages` index via ctx.net.fetch (SSRF-guarded outbound HTTP). Stateless: the index
 * IS the state. The document shape MUST match the core MeilisearchDocument (the bulk reindex in
 * core writes the same shape) — keep them in lockstep.
 *
 * CJS so the sandbox worker-bootstrap's `require(mainPath)` + `mod.default ?? mod` resolves the
 * class with no compile step. `module.exports = X` makes `mod` the class; `module.exports.default = X`
 * also satisfies loaders that prefer `mod.default`.
 *
 * NOTE: the plugin SDK (@openwa/plugin-sdk) is not yet published, so types are not imported here;
 * the shapes are inline-documented. The ctx.* surface is the live runtime contract from
 * src/core/plugins/plugin.interfaces.ts and src/core/plugins/sandbox/worker-capability.ts.
 *
 * Manifest `hooks` is declarative metadata only (dashboard-facing); the loader does NOT auto-register
 * from it. Registration is explicit via ctx.registerHook('message:persisted', ...) in onLoad, which
 * the sandbox worker-hook registry forwards to the host as a `hook-subscribe` message.
 */

const INDEX_UID = 'messages';

class SearchIndexerPlugin {
  async onLoad(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config || {};
    this.url = String(cfg.meilisearchUrl || '').replace(/\/+$/, '');
    this.apiKey = cfg.meilisearchApiKey ? String(cfg.meilisearchApiKey) : undefined;
    this.indexUid = `${cfg.indexPrefix || 'openwa_'}${INDEX_UID}`;

    if (!this.url) {
      ctx.logger.warn('Search indexer plugin enabled without meilisearchUrl — indexing disabled.');
      return;
    }

    try {
      await this._ensureIndex();
      await this._configureIndex();
      ctx.logger.log(`Search indexer connected to ${this.url}, index: ${this.indexUid}`);
    } catch (err) {
      ctx.logger.error('Search indexer could not reach Meilisearch', err);
      // Still register the hook so a later Meilisearch restart is picked up; each fetch will retry.
    }

    ctx.registerHook('message:persisted', async (hookCtx) => {
      const { data } = hookCtx;
      if (!data || !data.id) return { continue: true };
      try {
        await this._addDocument(this._toDocument(data));
      } catch (err) {
        ctx.logger.warn(`Failed to index message ${data.id}: ${err && err.message ? err.message : String(err)}`);
      }
      return { continue: true }; // fire-and-forget notification: never block the chain
    });
  }

  // Map the hook payload (MessagePersistedPayload) to the Meilisearch document shape.
  // MUST stay in lockstep with MeilisearchDocument in src/modules/search/meilisearch.client.ts:
  //   id, sessionId, waMessageId, chatId, chatName, from, to, body, type, direction, status,
  //   hasMedia, timestamp, createdAt
  _toDocument(p) {
    return {
      id: p.id,
      sessionId: p.sessionId,
      waMessageId: p.waMessageId ?? null,
      chatId: p.chatId,
      chatName: p.chatName ?? null,
      from: p.from,
      to: p.to,
      body: p.body ?? null,
      type: p.type,
      direction: p.direction,
      status: p.status,
      hasMedia: !!p.hasMedia,
      timestamp: p.timestamp ?? null,
      createdAt: p.createdAt,
    };
  }

  async _fetch(path, init) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.ctx.net.fetch(`${this.url}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Meilisearch ${init && init.method ? init.method : 'GET'} ${path} → ${res.status} ${body}`);
    }
    // DELETE/POST may return a task envelope; callers that need the body parse it.
    return res;
  }

  async _ensureIndex() {
    try {
      await this._fetch(`/indexes/${this.indexUid}`, { method: 'GET' });
    } catch (e) {
      await this._fetch('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: this.indexUid, primaryKey: 'id' }),
      });
    }
  }

  async _configureIndex() {
    try {
      await this._fetch(`/indexes/${this.indexUid}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          searchableAttributes: ['body'],
          filterableAttributes: ['sessionId', 'chatId', 'from', 'to', 'type', 'direction', 'status', 'hasMedia'],
          sortableAttributes: ['timestamp', 'createdAt'],
        }),
      });
    } catch (e) {
      this.ctx.logger.warn(`Search indexer: failed to configure index: ${e && e.message ? e.message : String(e)}`);
    }
  }

  async _addDocument(doc) {
    // Meilisearch POST /indexes/{uid}/documents?primaryKey=id accepts an array of documents and
    // upserts each (matched on primaryKey `id`). Mirrors MeilisearchClient.addDocuments([doc]).
    await this._fetch(`/indexes/${this.indexUid}/documents?primaryKey=id`, {
      method: 'POST',
      body: JSON.stringify([doc]),
    });
  }
}

module.exports = SearchIndexerPlugin;
module.exports.default = SearchIndexerPlugin;