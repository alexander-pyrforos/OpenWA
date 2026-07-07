const { test } = require('node:test');
const assert = require('node:assert');

function makeCtx() {
  const fetches = [];
  const ctx = {
    config: { meilisearchUrl: 'http://meili:7700', indexPrefix: 'openwa_' },
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    net: {
      fetch: async (url, init) => {
        fetches.push({ url, init });
        // /indexes/{uid} GET → 200 (exists), so ensureIndex is a no-op
        if (init && init.method === 'GET' && url.endsWith('/indexes/openwa_messages')) {
          return { ok: true, text: async () => '{}' };
        }
        return { ok: true, text: async () => '{}' };
      },
    },
    registerHook: (event, handler) => {
      ctx._handler = handler;
    },
  };
  return { ctx, fetches };
}

test('onLoad configures the index and registers message:persisted', async () => {
  const { ctx, fetches } = makeCtx();
  const Plugin = require('./index.js');
  const plugin = new Plugin();
  await plugin.onLoad(ctx);
  assert.strictEqual(typeof ctx._handler, 'function', 'handler registered');
  // ensureIndex (GET) + configureIndex (PATCH /settings)
  const methods = fetches.map((f) => f.init && f.init.method).filter(Boolean);
  assert.ok(methods.includes('PATCH'), 'configured settings');
});

test('the message:persisted handler POSTs a matching document and keeps the chain going', async () => {
  const { ctx, fetches } = makeCtx();
  const Plugin = require('./index.js');
  const plugin = new Plugin();
  await plugin.onLoad(ctx);

  const payload = {
    id: 'uuid-1', sessionId: 'sess-1', waMessageId: 'wa-1', chatId: 'c.us', chatName: 'Alice',
    from: 'c.us', to: 'me', body: 'hello <world>', type: 'text', direction: 'incoming',
    status: 'sent', hasMedia: true, timestamp: 1700, createdAt: '2026-01-01T00:00:00.000Z',
  };
  const result = await ctx._handler({ data: payload });
  assert.deepStrictEqual(result, { continue: true });

  const add = fetches.find((f) => f.url.endsWith('/documents?primaryKey=id'));
  assert.ok(add, 'addDocuments called');
  const body = JSON.parse(add.init.body);
  assert.strictEqual(body[0].id, 'uuid-1');
  assert.strictEqual(body[0].body, 'hello <world>', 'body passed through verbatim (Meilisearch stores, not escapes)');
  assert.strictEqual(body[0].hasMedia, true);
});

test('handler swallows Meilisearch errors and still returns continue:true', async () => {
  const ctx = makeCtx().ctx;
  ctx.net.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const Plugin = require('./index.js');
  const plugin = new Plugin();
  await plugin.onLoad(ctx);
  const result = await ctx._handler({ data: { id: 'x', sessionId: 's', chatId: 'c', from: 'f', to: 't', type: 'text', direction: 'incoming', status: 'sent', hasMedia: false, timestamp: null, createdAt: '2026-01-01T00:00:00.000Z', body: null, waMessageId: null, chatName: null } });
  assert.deepStrictEqual(result, { continue: true }, 'never blocks the chain on error');
});