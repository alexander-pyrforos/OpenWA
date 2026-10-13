import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesWaMessageIdIndex1782500000000 } from '../1782500000000-AddMessagesWaMessageIdIndex';

/**
 * SQLite in-memory coverage for the AddMessagesWaMessageIdIndex migration:
 *  - the index is created and serves the session-less exact-match lookup;
 *  - re-running up() is a no-op (IF NOT EXISTS);
 *  - down() drops the index;
 *  - down() then up() round-trips cleanly.
 *
 * Postgres runs CONCURRENTLY-less DDL with varchar_pattern_ops that sqlite cannot parse, so
 * the PG branch is exercised here via a stub that pins the query sequence (SET LOCAL timeout
 * lift, then the guarded CREATE); runtime PG coverage follows the DATABASE_TYPE=postgres CI
 * harness (see AddMessagesFts.pg.spec.ts).
 */
describe('AddMessagesWaMessageIdIndex migration (sqlite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
      migrations: [],
    });
    await ds.initialize();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("messages")`);
    return rows.map(r => r.name).sort();
  };

  it('creates the index and serves the session-less waMessageId exact match', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessagesWaMessageIdIndex1782500000000().up(runner);
    await runner.release();

    expect(await indexNames()).toContain('IDX_messages_waMessageId');

    const repo = ds.getRepository(Message);
    await repo.insert({
      sessionId: 's1',
      waMessageId: 'false_120363400287378579@g.us_ABCDEF_2',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'b@c.us',
      body: 'hi',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1,
    });

    // The exact-match shape MessageService.getMessageByWaMessageId runs when unscoped.
    const found = await repo.findOne({ where: { waMessageId: 'false_120363400287378579@g.us_ABCDEF_2' } });
    expect(found?.chatId).toBe('c1');
  });

  it('is idempotent: re-running up() is a no-op', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesWaMessageIdIndex1782500000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
    await runner.release();

    // Still exactly one index of that name.
    const names = await indexNames();
    expect(names.filter(n => n === 'IDX_messages_waMessageId')).toHaveLength(1);
  });

  it('down() drops the index and down→up round-trips cleanly', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesWaMessageIdIndex1782500000000();
    await migration.up(runner);
    await migration.down(runner);
    expect(await indexNames()).not.toContain('IDX_messages_waMessageId');

    await migration.up(runner);
    expect(await indexNames()).toContain('IDX_messages_waMessageId');
    await runner.release();
  });

  it('does not create anything when the messages table is missing (hasTable guard)', async () => {
    const calls: string[] = [];
    const stub = {
      connection: { options: { type: 'sqlite' as const } },
      query: jest.fn((stmt: string) => {
        calls.push(stmt);
        throw new Error(`unexpected query on the missing-table path: ${stmt}`);
      }),
      hasTable: jest.fn().mockResolvedValue(false),
    } as unknown as QueryRunner;

    await expect(new AddMessagesWaMessageIdIndex1782500000000().up(stub)).resolves.toBeUndefined();
    expect(stub.hasTable).toHaveBeenCalledWith('messages');
    expect(calls).toHaveLength(0);
  });
});

describe('AddMessagesWaMessageIdIndex migration (postgres branch, stubbed)', () => {
  const makePgStub = () => {
    const calls: string[] = [];
    const stub = {
      connection: { options: { type: 'postgres' as const } },
      query: jest.fn((stmt: string) => {
        calls.push(stmt);
        return [];
      }),
      hasTable: jest.fn(),
    } as unknown as QueryRunner;
    return { stub, calls };
  };

  it('up() lifts the runtime statement_timeout for the transaction, then builds with varchar_pattern_ops', async () => {
    const { stub, calls } = makePgStub();
    await new AddMessagesWaMessageIdIndex1782500000000().up(stub);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('SET LOCAL statement_timeout = 0');
    expect(calls[1]).toContain('CREATE INDEX IF NOT EXISTS "IDX_messages_waMessageId"');
    expect(calls[1]).toContain('ON "messages" ("waMessageId" varchar_pattern_ops)');
    // hasTable guard must not run on PG (the table is guaranteed by earlier migrations).
    expect((stub as unknown as { hasTable: jest.Mock }).hasTable).not.toHaveBeenCalled();
  });

  it('down() drops the index', async () => {
    const { stub, calls } = makePgStub();
    await new AddMessagesWaMessageIdIndex1782500000000().down(stub);

    expect(calls).toEqual(['DROP INDEX IF EXISTS "IDX_messages_waMessageId"']);
  });
});