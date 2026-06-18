import { DataSource, Repository } from 'typeorm';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStoreService } from './baileys-message-store.service';

describe('BaileysMessageStoreService', () => {
  let ds: DataSource;
  let repo: Repository<BaileysStoredMessage>;
  let service: BaileysMessageStoreService;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [BaileysStoredMessage], synchronize: true });
    await ds.initialize();
    repo = ds.getRepository(BaileysStoredMessage);
    service = new BaileysMessageStoreService(repo);
  });

  afterEach(async () => {
    await ds.destroy();
    delete process.env.BAILEYS_MESSAGE_STORE_LIMIT;
  });

  // Partial WAMessage fixture — cast through unknown so strict checks don't fire on the incomplete shape.
  const msg = (id: string) =>
    ({
      key: { id, remoteJid: '1@s.whatsapp.net', fromMe: false },
      message: { conversation: id },
    }) as unknown as Parameters<BaileysMessageStoreService['put']>[1];

  it('round-trips a WAMessage through BufferJSON', async () => {
    await service.put('s1', msg('M1'));
    const got = await service.getMessage('s1', 'M1');
    expect(got?.key?.id).toBe('M1');
    expect(got?.message?.conversation).toBe('M1');
  });

  it('returns null for an unknown id and is session-scoped', async () => {
    await service.put('s1', msg('M1'));
    expect(await service.getMessage('s1', 'NOPE')).toBeNull();
    expect(await service.getMessage('s2', 'M1')).toBeNull();
  });

  it('is idempotent on (sessionId, waMessageId)', async () => {
    await service.put('s1', msg('M1'));
    await service.put('s1', msg('M1'));
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(1);
  });

  it('evicts oldest beyond the per-session cap', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '2';
    const s = new BaileysMessageStoreService(repo);
    // Use distinct createdAt values so ordering is deterministic regardless of UUID tiebreaker.
    const t0 = new Date('2024-01-01T00:00:00.000Z');
    const t1 = new Date('2024-01-01T00:00:01.000Z');
    const t2 = new Date('2024-01-01T00:00:02.000Z');
    for (const [waMessageId, createdAt] of [
      ['M1', t0],
      ['M2', t1],
      ['M3', t2],
    ] as [string, Date][]) {
      await repo.save(repo.create({ sessionId: 's1', waMessageId, serializedMessage: '{}', createdAt }));
    }
    // Trigger eviction: put M3 again (idempotent upsert) so enforceLimit runs with 3 rows and cap=2.
    await s.put('s1', msg('M3'));
    expect(await s.getMessage('s1', 'M1')).toBeNull(); // oldest (t0) evicted
    expect(await s.getMessage('s1', 'M2')).not.toBeNull();
    expect(await s.getMessage('s1', 'M3')).not.toBeNull();
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(2);
  });

  it('keeps exactly limit rows when multiple share the same createdAt (tiebreaker via id)', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '2';
    const s = new BaileysMessageStoreService(repo);
    // Insert 3 rows with identical createdAt to stress the (createdAt, id) tiebreaker.
    // With UUID primary keys, id ordering is lexicographic — we can only assert count, not which survive.
    const sharedTs = new Date('2024-01-01T00:00:00.000Z');
    for (const waMessageId of ['T1', 'T2', 'T3']) {
      await repo.save(repo.create({ sessionId: 's2', waMessageId, serializedMessage: '{}', createdAt: sharedTs }));
    }
    // Trigger eviction: put a 4th message (distinct, newer ts) through the service.
    await s.put('s2', msg('T4'));
    // Exactly limit rows must remain — no over- or under-deletion.
    expect(await repo.count({ where: { sessionId: 's2' } })).toBe(2);
    // T4 is the newest (distinct createdAt = now) and must survive.
    expect(await s.getMessage('s2', 'T4')).not.toBeNull();
  });

  it('clearSession removes only that session', async () => {
    await service.put('s1', msg('M1'));
    await service.put('s2', msg('M2'));
    await service.clearSession('s1');
    expect(await service.getMessage('s1', 'M1')).toBeNull();
    expect(await service.getMessage('s2', 'M2')).not.toBeNull();
  });
});
