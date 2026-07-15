import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `message_media_descriptors` — the non-evicting downloadable-copy store for media-bearing
 * history-sync messages (D1). CASCADE-deleted with its session. Hand-authored because `synchronize`
 * is off for the `data` connection on Postgres (and optional on SQLite).
 *
 * Mirrors `AddBaileysStoredMessages1781000000000`, EXCEPT it omits the `(sessionId, createdAt)`
 * index: this store has no FIFO eviction, so there is no eviction-ordering index to maintain.
 */
export class AddMessageMediaDescriptors1782000000000 implements MigrationInterface {
  name = 'AddMessageMediaDescriptors1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('message_media_descriptors')) return;
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "message_media_descriptors" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, "serializedMessage" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_message_media_descriptors_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "message_media_descriptors" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, "serializedMessage" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_message_media_descriptors_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_message_media_descriptors_session_wamsg" ON "message_media_descriptors" ("sessionId", "waMessageId")`,
    );
    // NOTE: no (sessionId, createdAt) index — this store is non-evicting, so there is no
    // eviction-ordering index to maintain (unlike baileys_stored_messages).
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_message_media_descriptors_session_wamsg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "message_media_descriptors"`);
  }
}
