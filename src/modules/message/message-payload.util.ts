import { Message } from './entities/message.entity';

/**
 * Lean, JSON-safe representation of a persisted message, emitted on the `message:persisted` hook.
 * Search-agnostic: any plugin (indexer, metrics, audit) can consume it. `createdAt` is an ISO string
 * because `Date` is not safe across the sandbox worker_thread IPC boundary. Heavy media base64 is
 * intentionally NOT included — only the `hasMedia` flag — so the payload stays small for IPC.
 */
export interface MessagePersistedPayload {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  chatName: string | null;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  status: string;
  hasMedia: boolean;
  timestamp: number | null;
  createdAt: string;
}

export function toMessagePersistedPayload(message: Message): MessagePersistedPayload {
  const metadata = message.metadata as Record<string, unknown> | null;
  const media = metadata && (metadata.media as Record<string, unknown> | undefined);
  const hasMedia = !!(media && typeof media === 'object');
  return {
    id: message.id,
    sessionId: message.sessionId,
    waMessageId: message.waMessageId,
    chatId: message.chatId,
    chatName: message.chatName ?? null,
    from: message.from,
    to: message.to,
    body: message.body,
    type: message.type,
    direction: message.direction,
    status: message.status,
    hasMedia,
    timestamp: message.timestamp,
    createdAt: message.createdAt.toISOString(),
  };
}