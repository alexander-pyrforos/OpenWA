/**
 * True when a write failed because the parent `sessions` row is absent (a foreign-key violation),
 * as opposed to any other persistence error. Covers SQLite (`SQLITE_CONSTRAINT[_FOREIGNKEY]`) and
 * Postgres (`23503`). TypeORM wraps the driver error in a QueryFailedError, so check both the
 * wrapper and `driverError`.
 *
 * Shared by the Baileys message store and the (non-evicting) media-descriptor store: both persist
 * FK-bound rows under a `sessionId` that can vanish mid-flight when a session is deleted/recreated
 * during reconnect churn, and both must tolerate the orphan (warn-once + drop) instead of throwing
 * per message on the history/upsert hot path (#319).
 */
export function isMissingParentSessionError(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string }; message?: string };
  const code = e?.driverError?.code ?? e?.code;
  if (code === '23503') {
    return true; // Postgres foreign_key_violation
  }
  const message = e?.message ?? '';
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(message);
  }
  return /FOREIGN KEY constraint failed/i.test(message);
}
