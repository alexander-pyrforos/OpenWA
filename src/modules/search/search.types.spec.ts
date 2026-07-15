import type { SearchProvider, SearchQuery, SearchResults, SearchHealth, SearchHit } from './search.types';
import { MessageDirection } from '../message/entities/message.entity';

describe('search.types', () => {
  it('compiles a valid SearchProvider fixture', () => {
    const query: SearchQuery = { q: 'hi' };
    const provider: SearchProvider = {
      id: 'test',
      label: 'Test',
      search: (): Promise<SearchResults> => Promise.resolve({ hits: [], total: 0, tookMs: 1, provider: 'test' }),
      health: (): Promise<SearchHealth> => Promise.resolve({ ok: true }),
    };
    const hit: SearchHit = {
      id: 'm1',
      waMessageId: 'w1',
      sessionId: 's1',
      chatId: 'c1',
      chatName: null,
      from: 'me@c.us',
      to: 'them@c.us',
      body: 'hi',
      snippet: '<mark>hi</mark>',
      timestamp: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      hasMedia: false,
      score: 1,
    };
    expect(provider.id).toBe('test');
    expect(hit.body).toBe('hi');
    expect(query.q).toBe('hi');
  });
});
