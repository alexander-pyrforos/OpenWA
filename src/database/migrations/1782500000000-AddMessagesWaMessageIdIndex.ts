import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Standalone index on messages."waMessageId" for the session-less lookup path
 * (GET /api/messages/:waMessageId, message-lookup.controller.ts). The existing
 * UQ_messages_sessionId_waMessageId leads with sessionId, so any query filtered by
 * waMessageId alone (exact match, or the LIKE '<prefix>%' fallback) seq-scans the
 * whole table.
 *
 * On Postgres the index uses varchar_pattern_ops so LIKE 'prefix%' can use it under a
 * non-C collation (plain btree opclasses only serve LIKE in the C locale). pattern_ops
 * also serves `=` comparisons, so the same index covers the exact-match path too.
 * Hand-authored because synchronize is off for the 'data' connection (app.module.ts).
 *
 * Non-CONCURRENTLY on PG: TypeORM's MigrationExecutor forbids per-migration transaction
 * overrides in its default "all" mode (ForbiddenTransactionModeOverrideError), and
 * CONCURRENTLY cannot run inside the wrapper transaction, so a concurrent build would
 * require flipping the global migrationsTransactionMode. Same tradeoff as
 * AddMessagesFts: a one-time blocking build instead. Deploys are the maintenance window
 * (the API container is restarting and sessions start disconnected, so messages sees no
 * writes while the index builds); SHARE-lock blocking is limited to that window.
 */
export class AddMessagesWaMessageIdIndex1782500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      // Runtime pool sets statement_timeout (app.module.ts, default 30s), too tight for a
      // 102 GB table. Lift it for this transaction only; SET LOCAL needs no cleanup.
      await queryRunner.query('SET LOCAL statement_timeout = 0');
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_messages_waMessageId" ON "messages" ("waMessageId" varchar_pattern_ops)`,
      );
      return;
    }

    if (await queryRunner.hasTable('messages')) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_messages_waMessageId" ON "messages" ("waMessageId")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_waMessageId"');
      return;
    }

    if (await queryRunner.hasTable('messages')) {
      await queryRunner.query('DROP INDEX IF EXISTS "IDX_messages_waMessageId"');
    }
  }
}