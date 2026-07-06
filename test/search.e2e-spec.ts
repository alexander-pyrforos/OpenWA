// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { MeilisearchClient, MeilisearchDocument } from '../src/modules/search/meilisearch.client';

/**
 * End-to-end coverage for the global-search REST surface — the seam the SearchService unit specs
 * can't reach: the HTTP pipeline (controller → global ValidationPipe → built-in exception filter
 * mapping NotImplementedException to 501), the ApiKeyGuard auth boundary, and the ADMIN role guard
 * on reindex.
 *
 * Two app boots:
 *   1. "disabled" — no MEILISEARCH_URL (the e2e default), real MeilisearchClient self-disables →
 *      endpoints return 501. Exercises the genuine graceful-degradation path.
 *   2. "enabled" — MeilisearchClient is overridden with an in-memory stub (available=true) so the
 *      happy-path responses and role enforcement can be asserted without a live Meilisearch server.
 */
describe('Global search (e2e)', () => {
  describe('when Meilisearch is not configured', () => {
    let app: INestApplication<App>;
    let adminKey: string;

    beforeAll(async () => {
      delete process.env.MEILISEARCH_URL;
      delete process.env.MEILISEARCH_API_KEY;

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.setGlobalPrefix('api');
      // Mirror main.ts: implicit conversion is required for `hasMedia=true` (string → boolean).
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      await app.init();

      adminKey = (await app.get(AuthService).createApiKey({ name: 'e2e-search-admin', role: ApiKeyRole.ADMIN })).rawKey;
    }, 30_000);

    afterAll(async () => {
      try {
        await app?.close();
      } catch {
        /* ignore TypeORM multi-datasource teardown quirk */
      }
    });

    it('GET /api/messages/search without an API key is rejected (401)', () => {
      return request(app.getHttpServer()).get('/api/messages/search?q=hello').expect(401);
    });

    it('GET /api/messages/search returns 501 (Not Implemented) when search is disabled', () => {
      return request(app.getHttpServer()).get('/api/messages/search?q=hello').set('X-API-Key', adminKey).expect(501);
    });

    it('POST /api/messages/search/reindex returns 501 when search is disabled', () => {
      return request(app.getHttpServer()).post('/api/messages/search/reindex').set('X-API-Key', adminKey).expect(501);
    });
  });

  describe('when Meilisearch is available (stubbed client)', () => {
    let app: INestApplication<App>;
    let adminKey: string;
    let viewerKey: string;
    let mockClient: jest.Mocked<Partial<MeilisearchClient>>;

    beforeAll(async () => {
      const hit: MeilisearchDocument = {
        id: 'msg-uuid-1',
        sessionId: 'sess-1',
        waMessageId: 'wa-msg-1',
        chatId: '628123456789@c.us',
        chatName: 'Alice',
        from: '628123456789@c.us',
        to: 'me@s.whatsapp.net',
        body: 'Hello world',
        type: 'text',
        direction: 'incoming',
        status: 'sent',
        hasMedia: false,
        timestamp: 1706868000,
        createdAt: '2026-01-15T10:00:00.000Z',
      };

      mockClient = {
        available: true,
        addDocument: jest.fn().mockResolvedValue(undefined),
        addDocuments: jest.fn().mockResolvedValue(undefined),
        deleteDocument: jest.fn().mockResolvedValue(undefined),
        deleteAllDocuments: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ hits: [hit], estimatedTotalHits: 1 }),
      };

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(MeilisearchClient)
        .useValue(mockClient)
        .compile();

      app = moduleFixture.createNestApplication();
      app.setGlobalPrefix('api');
      // Mirror main.ts: implicit conversion is required for `hasMedia=true` (string → boolean).
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      await app.init();

      const authService = app.get(AuthService);
      adminKey = (await authService.createApiKey({ name: 'e2e-search-admin', role: ApiKeyRole.ADMIN })).rawKey;
      viewerKey = (await authService.createApiKey({ name: 'e2e-search-viewer', role: ApiKeyRole.VIEWER })).rawKey;
    }, 30_000);

    afterAll(async () => {
      try {
        await app?.close();
      } catch {
        /* ignore TypeORM multi-datasource teardown quirk */
      }
    });

    it('GET /api/messages/search?q=hello returns 200 with mapped hits', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/messages/search?q=hello')
        .set('X-API-Key', adminKey)
        .expect(200);

      const body = res.body as { hits: unknown[]; total: number; limit: number; offset: number };
      expect(body.hits).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
      expect((body.hits[0] as { id: string }).id).toBe('msg-uuid-1');
    });

    it('GET /api/messages/search without `q` returns 400 (validation)', () => {
      return request(app.getHttpServer()).get('/api/messages/search').set('X-API-Key', adminKey).expect(400);
    });

    it('GET /api/messages/search forwards filters to the client as a search call', async () => {
      await request(app.getHttpServer())
        .get('/api/messages/search?q=hi&sessionId=sess-1&type=text&hasMedia=true&limit=5&offset=10')
        .set('X-API-Key', adminKey)
        .expect(200);

      expect(mockClient.search).toHaveBeenCalledWith(
        'hi',
        { sessionId: 'sess-1', type: 'text', hasMedia: true },
        5,
        10,
      );
    });

    it('POST /api/messages/search/reindex with a VIEWER key is rejected (403)', () => {
      return request(app.getHttpServer()).post('/api/messages/search/reindex').set('X-API-Key', viewerKey).expect(403);
    });

    it('POST /api/messages/search/reindex with an ADMIN key returns 200 with an indexed count', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/messages/search/reindex')
        .set('X-API-Key', adminKey)
        .expect(200);

      const body = res.body as { indexed: number };
      expect(typeof body.indexed).toBe('number');
      expect(mockClient.deleteAllDocuments).toHaveBeenCalledTimes(1);
    });
  });
});
