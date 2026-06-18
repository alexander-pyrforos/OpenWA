import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStore } from '../types/baileys.types';

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class BaileysMessageStoreService implements BaileysMessageStore {
  constructor(
    @InjectRepository(BaileysStoredMessage, 'data')
    private readonly repo: Repository<BaileysStoredMessage>,
  ) {}

  async put(sessionId: string, msg: WAMessage): Promise<void> {
    const waMessageId = msg.key?.id;
    if (!waMessageId) {
      return;
    }
    const serializedMessage = JSON.stringify(msg, BufferJSON.replacer);
    // Idempotent: the same message arrives from the send return AND the messages.upsert echo.
    await this.repo.upsert({ sessionId, waMessageId, serializedMessage }, ['sessionId', 'waMessageId']);
    await this.enforceLimit(sessionId);
  }

  async getMessage(sessionId: string, messageId: string): Promise<WAMessage | null> {
    const row = await this.repo.findOne({ where: { sessionId, waMessageId: messageId } });
    if (!row) {
      return null;
    }
    return JSON.parse(row.serializedMessage, BufferJSON.reviver) as WAMessage;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  /** Per-session row cap: keep the newest N, delete the rest. Deterministic via (createdAt, id). */
  private async enforceLimit(sessionId: string): Promise<void> {
    const limit = positiveIntFromEnv('BAILEYS_MESSAGE_STORE_LIMIT', 5000);
    const cutoff = await this.repo.find({
      where: { sessionId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: limit,
      take: 1,
      select: ['id', 'createdAt'],
    });
    if (cutoff.length === 0) {
      return; // under the cap — nothing to evict
    }
    const { id, createdAt } = cutoff[0];
    await this.repo
      .createQueryBuilder()
      .delete()
      .where('sessionId = :sessionId', { sessionId })
      .andWhere('(createdAt < :createdAt OR (createdAt = :createdAt AND id <= :id))', { createdAt, id })
      .execute();
  }
}
