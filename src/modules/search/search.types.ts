import type { MessageType } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MessageDirection } from '../message/entities/message.entity';

/** A pluggable search backend. Indexing is intentionally NOT part of this interface —
 *  each provider owns how its index stays current (DB-level for built-in, hook-driven for plugin). */
export interface SearchProvider {
  /** Stable id, e.g. 'builtin-fts'. */
  readonly id: string;
  /** Human label for dashboard/config. */
  readonly label: string;
  search(query: SearchQuery): Promise<SearchResults>;
  /** Registry/route use this; 503 when not ok. */
  health(): Promise<SearchHealth>;
}

export interface SearchHealth {
  ok: boolean;
  detail?: string;
}

export interface SearchQuery {
  q: string;
  /** Scoped by SearchService from the caller's API-key allowedSessions (not user-supplied). */
  sessionIds?: string[];
  sessionId?: string;
  chatId?: string;
  direction?: MessageDirection;
  type?: MessageType | MessageType[];
  from?: string;
  dateFrom?: number; // epoch ms
  dateTo?: number; // epoch ms
  limit?: number;
  offset?: number;
  hasMedia?: boolean;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Bounded exact count for pagination. */
  total: number;
  tookMs: number;
  /** Which provider answered (id). */
  provider: string;
}

export interface SearchHit {
  /** Unique DB id — the primary key of the messages row. */
  id: string;
  /** WhatsApp message id (row.waMessageId), present for all WhatsApp-origin messages. */
  waMessageId: string;
  sessionId: string;
  chatId: string;
  /** Best-effort display name for the chat (contact pushName or phone number). Falls back to the JID
   *  local-part when no name is stored. */
  chatName: string | null;
  from: string;
  to: string;
  body: string;
  /** Provider-generated excerpt with `<mark>` highlight markers — safe to render as text. */
  snippet: string;
  /** Epoch-seconds (mirrors the persisted messages.timestamp column). */
  timestamp: number;
  /** ISO-8601 createdAt from the DB row. */
  createdAt: string;
  type: MessageType;
  direction: MessageDirection;
  /** True when the message type is one that typically carries media (image/video/audio/voice/sticker/
   *  document). Used by the dashboard to decide whether to attempt a thumbnail fetch. */
  hasMedia: boolean;
  score?: number;
}