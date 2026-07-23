/**
 * Live state of an in-process history backfill job (POST /sessions/:id/backfill-history). The run
 * happens inside the live API process so it can use the running engine; it outlives the HTTP
 * request that started it, so the controller hands back this snapshot and GET /backfill-history
 * re-reads it for progress. One job per session at a time (SessionService guards with a Map).
 */
export interface BackfillJobState {
  status: 'running' | 'completed' | 'failed';
  batchSize: number;
  rateMs: number;
  includeMedia: boolean;
  chatsTotal: number;
  processed: number;
  chatsFailed: number;
  lastChat: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}