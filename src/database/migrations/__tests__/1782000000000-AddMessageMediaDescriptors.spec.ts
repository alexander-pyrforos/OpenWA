import { DataSource } from 'typeorm';
import { AddMessageMediaDescriptors1782000000000 } from '../1782000000000-AddMessageMediaDescriptors';

describe('AddMessageMediaDescriptors migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    // A `sessions` table must exist for the FK; create a minimal stand-in.
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** Index names for a table, read straight from sqlite_master (QueryRunner index APIs vary by
   *  driver version; this is stable across TypeORM releases). */
  const indexNames = async (table: string): Promise<string[]> => {
    // ds.query returns `any`; annotate the binding (not a cast — `any` is assignable to the target)
    // so `.map` is type-safe without tripping no-unnecessary-type-assertion.
    const rows: { name: string }[] = await ds.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      [table],
    );
    return rows.map(r => r.name);
  };

  it('creates and drops the table + unique index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessageMediaDescriptors1782000000000();

    await migration.up(runner);
    expect(await runner.hasTable('message_media_descriptors')).toBe(true);
    expect(await indexNames('message_media_descriptors')).toContain('UQ_message_media_descriptors_session_wamsg');

    await migration.down(runner);
    expect(await runner.hasTable('message_media_descriptors')).toBe(false);

    await runner.release();
  });

  it('does NOT create a (sessionId, createdAt) eviction-ordering index (non-evicting store)', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessageMediaDescriptors1782000000000().up(runner);
    const names = await indexNames('message_media_descriptors');
    // The baileys_stored_messages migration creates IDX_..._session_created; this one must NOT.
    expect(names.find(n => n.includes('session_created'))).toBeUndefined();
    await runner.release();
  });

  it('up() is idempotent (a second run is a no-op when the table already exists)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessageMediaDescriptors1782000000000();
    await migration.up(runner);
    // A second up() must not throw (hasTable early-return).
    await expect(migration.up(runner)).resolves.toBeUndefined();
    expect(await runner.hasTable('message_media_descriptors')).toBe(true);
    await runner.release();
  });

  it('down() does not throw when the named index was never created (synchronize-bootstrapped DB)', async () => {
    const runner = ds.createQueryRunner();
    // No up(): the named index never existed (a synchronize-built schema uses hash-named ones).
    await expect(new AddMessageMediaDescriptors1782000000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
