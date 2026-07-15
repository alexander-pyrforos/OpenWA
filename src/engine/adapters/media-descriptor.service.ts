import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { MediaDescriptor } from './media-descriptor.entity';
import { createLogger } from '../../common/services/logger.service';
import { isMissingParentSessionError } from './orphan-session-error';

/**
 * Non-evicting store of media-bearing history-sync WAMessages (D1). Each row holds the FULL
 * serialized WAMessage (via `BufferJSON.replacer`, exactly like `baileys-message-store.service.ts`),
 * which carries the download metadata `downloadMediaMessage(msg, 'stream', …)` consumes. The
 * history endpoint (`message.service.getMedia`) pulls a row back, `BufferJSON.reviver`-parses it to
 * a `WAMessage`, and streams the decrypted media on demand.
 *
 * Best-effort on the history hot path: `put` never throws for an orphaned session (warn-once + drop,
 * mirroring `BaileysMessageStoreService.put`), and the adapter fire-and-forgets it so a descriptor
 * write failure can't break the history sync.
 */
@Injectable()
export class MediaDescriptorService {
  private readonly logger = createLogger('MediaDescriptor');
  /** Sessions already warned about a missing parent row — keeps the orphan log to once per session. */
  private readonly orphanWarnedSessions = new Set<string>();

  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first use, not at boot). */
  private baileysLib?: typeof BaileysLib;

  private async loadLib(): Promise<typeof BaileysLib> {
    return (this.baileysLib ??= await import('@whiskeysockets/baileys'));
  }

  constructor(
    @InjectRepository(MediaDescriptor, 'data')
    private readonly repo: Repository<MediaDescriptor>,
  ) {}

  /**
   * Persist (or refresh) the downloadable copy of a media-bearing history message. Idempotent on
   * `(sessionId, waMessageId)`: a re-sync of the same message overwrites the prior descriptor so the
   * freshest download metadata wins. Never throws for an orphaned session — see
   * {@link isMissingParentSessionError}.
   */
  async put(sessionId: string, waMessageId: string, msg: WAMessage): Promise<void> {
    const { BufferJSON } = await this.loadLib();
    const serializedMessage = JSON.stringify(msg, BufferJSON.replacer);
    // createdAt set explicitly for the same millisecond-precision reason as the live message store
    // (keeps the stored value consistent with any future ordering use).
    try {
      await this.repo.upsert({ sessionId, waMessageId, serializedMessage, createdAt: new Date() }, [
        'sessionId',
        'waMessageId',
      ]);
    } catch (err) {
      if (isMissingParentSessionError(err)) {
        // Orphaned adapter: the sessions row was deleted/recreated (reconnect churn) while this
        // adapter kept ingesting history. There is no valid parent to store under, so drop the write
        // instead of throwing the FK error on every history message. Warn once per session so the
        // orphan stays visible without per-message log noise.
        if (!this.orphanWarnedSessions.has(sessionId)) {
          this.orphanWarnedSessions.add(sessionId);
          this.logger.warn(
            `No parent session row for "${sessionId}" — skipping media descriptor store (orphaned/recreated session). ` +
              `On-demand history media download will be unavailable for messages received under this id.`,
          );
        }
        return;
      }
      throw err; // a genuine persistence failure — let the caller's catch surface it
    }
  }

  async getMessage(sessionId: string, waMessageId: string): Promise<WAMessage | null> {
    const row = await this.repo.findOne({ where: { sessionId, waMessageId } });
    if (!row) {
      return null;
    }
    const { BufferJSON } = await this.loadLib();
    return JSON.parse(row.serializedMessage, BufferJSON.reviver) as WAMessage;
  }
}
