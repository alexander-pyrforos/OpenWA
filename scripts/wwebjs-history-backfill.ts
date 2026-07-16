// One-shot history backfill for sessions previously under Baileys: walks every chat via the
// wwebjs engine, persists each historical message through `SessionService.persistIncomingMessage`
// (so the `author` / `isGroup` / `contact` / `senderPhone` metadata is written to the `messages`
// table just like live inbound), then exits. The script never fires webhooks or WS emits
// (dispatch=false) — history pre-dates the live session and must not re-trigger consumers.
//
// Why wwebjs: Baileys only sends `messaging-history.set` ONCE per account and there is no API to
// re-fetch. whatsapp-web.js calls `chat.fetchMessages({ limit })` per chat on demand, so it can
// backfill ANY chat at ANY time with full sender info.
//
// Usage (inside the API container, so the Nest DI graph is wired the same way as the live process):
//   npm run backfill:history:wwebjs -- --session-id <uuid> [--rate-ms 1500] [--batch-size 50]
//                                          [--include-media] [--chat-id <jid> ...]
//                                          [--resume-from <chatId>]
//
// Idempotency: `messages.UQ_messages_sessionId_waMessageId` makes the insert the dedup oracle.
// Re-running over the same chats is safe — the existing rows are skipped, only the gaps land.
// The script exits 0 on success, non-zero only on a setup error (no session id, session not
// ready, etc.). Throttle errors per chat (rate-limit / network blip) are logged and skipped so a
// single bad chat cannot abort a multi-hour run.
//
// Prerequisite: the operator must have already switched ENGINE_TYPE to whatsapp-web.js and linked
// the session via QR (runbook in docs/runbooks/wwebjs-history-backfill.md). The script does not
// start the engine — it reads from the engine already in this SessionService's registry.
import '../src/config/load-env';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/modules/session/session.service';
import { SessionStatus } from '../src/modules/session/entities/session.entity';
import { IWhatsAppEngine, IncomingMessage } from '../src/engine/interfaces/whatsapp-engine.interface';

// Pin a hermetic env BEFORE AppModule is imported — same pattern as scripts/export-openapi.ts. The
// script is an operator-driven tool, not the live API, so we explicitly disable the side-effecting
// modules and never auto-start sessions.
process.env.QUEUE_ENABLED = 'false';
process.env.MCP_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';

interface CliArgs {
  sessionId: string;
  rateMs: number;
  batchSize: number;
  includeMedia: boolean;
  chatIds: Set<string> | null; // null = all chats
  resumeFrom: string | null; // skip chats sorting strictly before this id
}

const USAGE = `Usage: npm run backfill:history:wwebjs -- --session-id <uuid>
                    [--rate-ms <ms>] [--batch-size <n>] [--include-media]
                    [--chat-id <jid> (repeatable)] [--resume-from <chatId>]`;

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    return argv[i + 1];
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]);
    }
    return out;
  };
  const sessionId = get('--session-id');
  if (!sessionId) {
    process.stderr.write(`${USAGE}\n\n--session-id is required\n`);
    process.exit(2);
  }
  const numArg = (flag: string, def: number): number => {
    const raw = get(flag);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`${USAGE}\n\n--${flag} must be a positive number, got: ${raw}\n`);
      process.exit(2);
    }
    return n;
  };
  const chatIds = getAll('--chat-id');
  return {
    sessionId,
    rateMs: numArg('--rate-ms', 1500),
    batchSize: Math.min(numArg('--batch-size', 50), 1000), // engine caps internally; clamp to sane upper bound
    includeMedia: argv.includes('--include-media'),
    chatIds: chatIds.length ? new Set(chatIds) : null,
    resumeFrom: get('--resume-from') ?? null,
  };
}

// Retry wrapper for the per-chat history fetch. wwebjs can throw on WhatsApp throttle / transient
// network blip; the next chat's throttle window is independent. Three attempts with 5s/15s/45s —
// matches the handoff doc's risk #3 ("script needs a retry-with-backoff (3 attempts, 5s/15s/45s)").
async function fetchHistoryWithRetry(
  engine: IWhatsAppEngine,
  chatId: string,
  limit: number,
  includeMedia: boolean,
  log: Logger,
): Promise<IncomingMessage[]> {
  const backoffs = [0, 5_000, 15_000, 45_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt] > 0) {
      log.warn(`Retry ${attempt}/${backoffs.length - 1} for ${chatId} after ${backoffs[attempt]}ms`);
      await new Promise(r => setTimeout(r, backoffs[attempt]));
    }
    try {
      return await engine.getChatHistory(chatId, limit, includeMedia);
    } catch (err) {
      lastErr = err;
      log.warn(`getChatHistory(${chatId}) attempt ${attempt + 1} failed: ${String(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = new Logger('wwebjs-history-backfill');

  log.log(`Bootstrapping Nest context (session=${args.sessionId}, rateMs=${args.rateMs}, batchSize=${args.batchSize})`);
  // createApplicationContext: no HTTP listener, no init() side effects. AppModule's onApplicationBootstrap
  // hooks (autostart, batch backfills) are still wired but the script controls the lifecycle and
  // closes the context explicitly in finally.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error', 'log'] });
  // Touch the ConfigService so env-validation has run (AppModule already triggers this, but the
  // explicit reference documents the dependency for readers).
  app.get(ConfigService);

  let exitCode = 0;
  try {
    const sessionService = app.get(SessionService);
    const session = await sessionService.findOne(args.sessionId);
    if (!session) {
      process.stderr.write(`Session not found: ${args.sessionId}\n`);
      exitCode = 1;
      return;
    }
    if (session.status !== SessionStatus.READY) {
      process.stderr.write(
        `Session ${args.sessionId} is not ready (status=${session.status}). ` +
          `Switch ENGINE_TYPE=whatsapp-web.js, start the session, scan QR, then re-run.\n`,
      );
      exitCode = 1;
      return;
    }
    const engine = sessionService.getEngine(args.sessionId);
    if (!engine) {
      process.stderr.write(`No live engine for session ${args.sessionId} (was the session started under wwebjs?).\n`);
      exitCode = 1;
      return;
    }

    log.log(`Fetching chat list from wwebjs...`);
    const allChats = await engine.getChats();
    const filtered = allChats
      .filter(c => (args.chatIds ? args.chatIds.has(c.id) : true))
      .sort((a, b) => a.id.localeCompare(b.id));
    const startIdx = args.resumeFrom
      ? filtered.findIndex(c => c.id.localeCompare(args.resumeFrom!) >= 0)
      : 0;
    const chats = startIdx === -1 ? [] : filtered.slice(startIdx);
    log.log(
      `Chats to process: ${chats.length} (of ${allChats.length} total, ${allChats.length - chats.length} skipped by filter)`,
    );

    let totalProcessed = 0;
    let totalFailed = 0;
    const startTime = Date.now();
    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      try {
        const history = await fetchHistoryWithRetry(engine, chat.id, args.batchSize, args.includeMedia, log);
        for (const m of history) {
          // backfillHistoryMessage: dispatch=false (history must not re-fire webhooks) and the
          // dedup oracle is UNIQUE(sessionId, waMessageId), so a re-run over the same chats is safe.
          await sessionService.backfillHistoryMessage(args.sessionId, m);
        }
        totalProcessed += history.length;
        log.log(`[${i + 1}/${chats.length}] ${chat.id} (${chat.name || '<unnamed>'}) — history=${history.length}`);
      } catch (err) {
        totalFailed++;
        log.error(`Chat ${chat.id} failed after retries: ${String(err)}`);
      }
      // Throttle between chats (the only exception: the last chat) so WhatsApp doesn't see
      // getChatHistory as a burst.
      if (i < chats.length - 1) {
        await sleep(args.rateMs);
      }
    }
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    log.log(
      `Done. chats=${chats.length} processed=${totalProcessed} chatsFailed=${totalFailed} elapsed=${elapsedSec}s ` +
        `(idempotent re-runs are safe: duplicates are skipped at insert time by UNIQUE(sessionId, waMessageId))`,
    );
  } catch (err) {
    log.error(`Backfill aborted: ${String(err)}`);
    exitCode = 1;
  } finally {
    await app.close();
  }
  process.exit(exitCode);
}

// SIGINT handler: log progress, close the Nest context cleanly, exit 0. The `in-progress` set is
// implicit (we're in a single `for` loop), so on Ctrl-C the worst case is the current chat's
// `getChatHistory` call is abandoned mid-fetch — the persisted rows up to that point are
// committed (per-message insert is its own DB write) and a re-run with `--resume-from` resumes.
let sigintReceived = false;
process.on('SIGINT', () => {
  if (sigintReceived) {
    // Second Ctrl-C: hard exit. The first handler is still in `main()`; this is the user's
    // "really, kill it" signal.
    process.stderr.write('Force exit (second SIGINT)\n');
    process.exit(130);
  }
  sigintReceived = true;
  process.stderr.write('SIGINT received — finishing current chat, then exiting cleanly. Press Ctrl-C again to force.\n');
});

void main();
