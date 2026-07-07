import { toMessagePersistedPayload } from './message-payload.util';
import { Message, MessageDirection } from './entities/message.entity';

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'uuid-1',
    sessionId: 'sess-1',
    waMessageId: 'wa-1',
    chatId: 'c.us',
    chatName: 'Alice',
    from: 'c.us',
    to: 'me',
    body: 'hi',
    type: 'text',
    direction: MessageDirection.INCOMING,
    status: 'sent',
    metadata: null,
    timestamp: 1700000000,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  } as Message;
}

describe('toMessagePersistedPayload', () => {
  it('maps the lean, IPC-safe shape (Date → ISO string)', () => {
    const p = toMessagePersistedPayload(makeMessage());
    expect(p).toEqual({
      id: 'uuid-1', sessionId: 'sess-1', waMessageId: 'wa-1', chatId: 'c.us',
      chatName: 'Alice', from: 'c.us', to: 'me', body: 'hi', type: 'text',
      direction: 'incoming', status: 'sent', hasMedia: false,
      timestamp: 1700000000, createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('derives hasMedia from metadata.media (object present → true)', () => {
    expect(toMessagePersistedPayload(makeMessage({ metadata: { media: { mimetype: 'image/jpeg' } } as unknown } as Message)).hasMedia).toBe(true);
    expect(toMessagePersistedPayload(makeMessage({ metadata: { media: null } as unknown } as Message)).hasMedia).toBe(false);
    expect(toMessagePersistedPayload(makeMessage({ metadata: null })).hasMedia).toBe(false);
  });

  it('strips the heavy media base64 — the payload must be small for the sandbox IPC', () => {
    const p = toMessagePersistedPayload(makeMessage({ metadata: { media: { data: 'VERY-LARGE-BASE64', mimetype: 'image/jpeg' } } as unknown } as Message));
    expect(p.hasMedia).toBe(true);
    expect(JSON.stringify(p)).not.toContain('VERY-LARGE-BASE64');
  });

  it('handles null body / null waMessageId / null chatName', () => {
    const p = toMessagePersistedPayload(makeMessage({ body: null, waMessageId: null, chatName: null }));
    expect(p.body).toBeNull();
    expect(p.waMessageId).toBeNull();
    expect(p.chatName).toBeNull();
  });
});