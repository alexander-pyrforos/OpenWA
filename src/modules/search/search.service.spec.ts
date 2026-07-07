import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { FindManyOptions } from 'typeorm';
import { SearchService } from './search.service';
import { MeilisearchClient, MeilisearchDocument, MeilisearchSearchResponse } from './meilisearch.client';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';

/** Writable, fully-typed stand-in for the bits of MeilisearchClient SearchService touches. */
interface MeilisearchClientMock {
  available: boolean;
  addDocuments: jest.Mock<Promise<void>, [MeilisearchDocument[]]>;
  deleteAllDocuments: jest.Mock<Promise<void>, []>;
  search: jest.Mock<
    Promise<MeilisearchSearchResponse>,
    [string, Record<string, string | boolean>, number, number]
  >;
}

/** Stand-in for the Message repository methods SearchService uses (reindexAll's batched find,
 * indexMessageByWaId's lookup). */
interface MessageRepositoryMock {
  find: jest.Mock<Promise<Message[]>, [FindManyOptions<Message>]>;
  findOne: jest.Mock<Promise<Message | null>, [{ where: { sessionId: string; waMessageId: string } }]>;
}

/** makeMessage overrides — `metadata` is a nullable column, so allow null here. */
type MessageOverrides = Partial<Omit<Message, 'metadata'>> & {
  metadata?: Record<string, unknown> | null;
};

/** Build a fully-populated Message entity for tests. */
function makeMessage(overrides: MessageOverrides = {}): Message {
  return {
    id: 'msg-uuid-1',
    sessionId: 'sess-1',
    waMessageId: 'wa-msg-1',
    chatId: '628123456789@c.us',
    chatName: 'Alice',
    from: '628123456789@c.us',
    to: 'me@s.whatsapp.net',
    body: 'Hello world',
    type: 'text',
    direction: MessageDirection.INCOMING,
    timestamp: 1706868000,
    metadata: null,
    status: MessageStatus.SENT,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    ...overrides,
  } as Message;
}

/** A minimal search response — enough to satisfy the fields SearchService reads. */
function makeSearchResponse(
  hits: MeilisearchDocument[],
  estimatedTotalHits = hits.length,
): MeilisearchSearchResponse {
  return { hits, estimatedTotalHits };
}

describe('SearchService', () => {
  let service: SearchService;
  let meilisearchClient: MeilisearchClientMock;
  let repository: MessageRepositoryMock;

  beforeEach(async () => {
    meilisearchClient = {
      available: true,
      addDocuments: jest.fn<Promise<void>, [MeilisearchDocument[]]>().mockResolvedValue(undefined),
      deleteAllDocuments: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      search: jest
        .fn<Promise<MeilisearchSearchResponse>, [string, Record<string, string | boolean>, number, number]>()
        .mockResolvedValue(makeSearchResponse([])),
    };

    repository = {
      find: jest.fn<Promise<Message[]>, [FindManyOptions<Message>]>().mockResolvedValue([]),
      findOne: jest
        .fn<Promise<Message | null>, [{ where: { sessionId: string; waMessageId: string } }]>()
        .mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: MeilisearchClient, useValue: meilisearchClient },
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  // ── isAvailable ───────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('delegates to the Meilisearch client availability flag', () => {
      meilisearchClient.available = true;
      expect(service.isAvailable()).toBe(true);

      meilisearchClient.available = false;
      expect(service.isAvailable()).toBe(false);
    });
  });

  // ── search ────────────────────────────────────────────────────────

  describe('search', () => {
    it('passes the query, limit, and offset through to the client and maps hits', async () => {
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
      meilisearchClient.search.mockResolvedValue(makeSearchResponse([hit], 42));

      const result = await service.search({ q: 'hello', limit: 10, offset: 5 });

      expect(meilisearchClient.search).toHaveBeenCalledWith('hello', {}, 10, 5);
      expect(result).toEqual({
        hits: [{ ...hit, _formatted: undefined }],
        total: 42,
        limit: 10,
        offset: 5,
      });
    });

    it('builds a filter map from the provided filter fields', async () => {
      meilisearchClient.search.mockResolvedValue(makeSearchResponse([]));

      await service.search({
        q: 'hello',
        sessionId: 'sess-1',
        chatId: '628123456789@c.us',
        from: '628123456789@c.us',
        type: 'text',
        direction: 'incoming',
        hasMedia: true,
      });

      expect(meilisearchClient.search).toHaveBeenCalledWith(
        'hello',
        {
          sessionId: 'sess-1',
          chatId: '628123456789@c.us',
          from: '628123456789@c.us',
          type: 'text',
          direction: 'incoming',
          hasMedia: true,
        },
        20,
        0,
      );
    });

    it('omits unset filters from the filter map', async () => {
      meilisearchClient.search.mockResolvedValue(makeSearchResponse([]));

      await service.search({ q: 'hello', type: 'image' });

      expect(meilisearchClient.search).toHaveBeenCalledWith('hello', { type: 'image' }, 20, 0);
    });

    it('applies default limit/offset of 20/0 when not provided', async () => {
      meilisearchClient.search.mockResolvedValue(makeSearchResponse([]));

      await service.search({ q: 'hello' });

      expect(meilisearchClient.search).toHaveBeenCalledWith('hello', {}, 20, 0);
    });

    it('preserves _formatted.body highlight from Meilisearch', async () => {
      const hit = {
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
        _formatted: { body: '<mark>Hello</mark> world' },
      } as MeilisearchDocument & { _formatted: { body: string } };
      meilisearchClient.search.mockResolvedValue(makeSearchResponse([hit]));

      const result = await service.search({ q: 'hello' });

      expect(result.hits[0]._formatted).toEqual({ body: '<mark>Hello</mark> world' });
    });

    it('falls back to hits.length when estimatedTotalHits is absent', async () => {
      const hit: MeilisearchDocument = {
        id: 'msg-uuid-1',
        sessionId: 'sess-1',
        waMessageId: null,
        chatId: '628123456789@c.us',
        chatName: null,
        from: '628123456789@c.us',
        to: 'me@s.whatsapp.net',
        body: 'Hello',
        type: 'text',
        direction: 'incoming',
        status: 'sent',
        hasMedia: false,
        timestamp: 1706868000,
        createdAt: '2026-01-15T10:00:00.000Z',
      };
      // No estimatedTotalHits on the response.
      meilisearchClient.search.mockResolvedValue({ hits: [hit] });

      const result = await service.search({ q: 'hello' });

      expect(result.total).toBe(1);
    });

    it('throws when Meilisearch is not available', async () => {
      meilisearchClient.available = false;

      await expect(service.search({ q: 'hello' })).rejects.toThrow('Meilisearch is not available');
      expect(meilisearchClient.search).not.toHaveBeenCalled();
    });
  });

  // ── reindexAll ────────────────────────────────────────────────────

  describe('reindexAll', () => {
    it('clears the index then batch-indexes all messages in order', async () => {
      const batch = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
      repository.find.mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

      const result = await service.reindexAll();

      expect(meilisearchClient.deleteAllDocuments).toHaveBeenCalledTimes(1);
      // A partial batch (2 < batchSize) triggers the early break, so only one find runs.
      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' }, skip: 0, take: 1000 });
      expect(meilisearchClient.addDocuments).toHaveBeenCalledTimes(1);
      expect(meilisearchClient.addDocuments).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'm1' }),
        expect.objectContaining({ id: 'm2' }),
      ]);
      expect(result).toEqual({ indexed: 2 });
    });

    it('handles multiple full batches and a final partial batch', async () => {
      const fullBatch = Array.from({ length: 1000 }, (_, i) => makeMessage({ id: `m${i}` }));
      const partialBatch = [makeMessage({ id: 'last' })];
      repository.find.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce(partialBatch).mockResolvedValueOnce([]);

      const result = await service.reindexAll();

      expect(meilisearchClient.addDocuments).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ indexed: 1001 });
    });

    it('indexes nothing and returns 0 when the database is empty', async () => {
      repository.find.mockResolvedValue([]);

      const result = await service.reindexAll();

      expect(meilisearchClient.deleteAllDocuments).toHaveBeenCalledTimes(1);
      expect(meilisearchClient.addDocuments).not.toHaveBeenCalled();
      expect(result).toEqual({ indexed: 0 });
    });

    it('throws when Meilisearch is not available', async () => {
      meilisearchClient.available = false;

      await expect(service.reindexAll()).rejects.toThrow('Meilisearch is not available');
      expect(meilisearchClient.deleteAllDocuments).not.toHaveBeenCalled();
      expect(repository.find).not.toHaveBeenCalled();
    });
  });
});
