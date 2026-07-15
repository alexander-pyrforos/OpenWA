import { DataSource, Repository } from 'typeorm';
import { MediaDescriptor } from './media-descriptor.entity';
import { MediaDescriptorService } from './media-descriptor.service';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';

describe('MediaDescriptorService', () => {
  let ds: DataSource;
  let repo: Repository<MediaDescriptor>;
  let service: MediaDescriptorService;

  // Seed a sessions row so FK constraints (if SQLite enables them) resolve correctly.
  const seedSession = async (id: string): Promise<void> => {
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      // Session must be present so the @ManyToOne relation metadata resolves and synchronize
      // can emit the CASCADE FK on the message_media_descriptors table.
      entities: [MediaDescriptor, Session],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(MediaDescriptor);
    service = new MediaDescriptorService(repo);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  // Partial WAMessage fixture — cast through unknown so strict checks don't fire on the incomplete
  // shape. Carries an image sub-message so it mirrors a real media-bearing history row.
  const msg = (id: string) =>
    ({
      key: { id, remoteJid: '1@s.whatsapp.net', fromMe: false },
      message: {
        imageMessage: { mimetype: 'image/jpeg', fileLength: '12345' },
      },
    }) as unknown as Parameters<MediaDescriptorService['put']>[2];

  it('round-trips a media-bearing WAMessage through BufferJSON', async () => {
    await seedSession('s1');
    await service.put('s1', 'M1', msg('M1'));
    const got = await service.getMessage('s1', 'M1');
    expect(got?.key?.id).toBe('M1');
    expect(got?.message?.imageMessage?.mimetype).toBe('image/jpeg');
  });

  it('returns null for an unknown id and is session-scoped', async () => {
    await seedSession('s1');
    await service.put('s1', 'M1', msg('M1'));
    expect(await service.getMessage('s1', 'NOPE')).toBeNull();
    expect(await service.getMessage('s2', 'M1')).toBeNull();
  });

  it('is idempotent on (sessionId, waMessageId)', async () => {
    await seedSession('s1');
    await service.put('s1', 'M1', msg('M1'));
    await service.put('s1', 'M1', msg('M1'));
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(1);
  });

  // Mirrors the #319 orphan handling the live message store has: a descriptor write under a
  // sessionId whose parent row is gone must skip (warn-once) instead of throwing per message, so the
  // history hot path can't be broken by reconnect churn.
  it('skips persisting (no throw) when the parent session row is absent (orphaned adapter; #319)', async () => {
    await ds.query('PRAGMA foreign_keys = ON'); // faithfully reproduce production FK enforcement
    // No seedSession('orphan') — the parent is gone.
    await expect(service.put('orphan', 'M1', msg('M1'))).resolves.toBeUndefined();
    expect(await repo.count({ where: { sessionId: 'orphan' } })).toBe(0);
  });

  it('still rethrows a non-FK persistence error (does not swallow real failures)', async () => {
    await seedSession('s1');
    const boom = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(boom);
    await expect(service.put('s1', 'M1', msg('M1'))).rejects.toThrow('disk full');
  });
});
