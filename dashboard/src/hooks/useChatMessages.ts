import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  mergeChatMessages,
  mapEngineHistoryMessage,
  mergeOrAppend,
  prependChatMessages,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages';
import { sessionApi } from '../services/api';

export type MessagesQueryKey = readonly ['messages', string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return ['messages', sessionId, chatId] as const;
}

// Sibling cache key holding just the DB `total` (full-history row count) for a chat, so Chats.tsx can
// decide whether a "Load older" control should render without disturbing the messages slice. Kept
// separate so the array-shaped messages cache (and all WS writers through useChatMessagesActions)
// stay unchanged — zero churn on the realtime path.
export type MessagesTotalQueryKey = readonly ['messages-total', string, string];

export function messagesTotalQueryKey(sessionId: string, chatId: string): MessagesTotalQueryKey {
  return ['messages-total', sessionId, chatId] as const;
}

/**
 * Fetch messages for one (sessionId, chatId) and keep them cached (staleTime: Infinity); realtime
 * updates flow through useChatMessagesActions, not refetches. Engine history is fetched WITHOUT media
 * to keep the cache small — a single 50 MiB message would otherwise sit in heap as base64 (held twice
 * as a `data:` URI). Recent media still renders from the DB copy (which wins in mergeChatMessages);
 * older history media shows the omitted placeholder. Cache eviction happens 5 min after the chat stops
 * being observed (gcTime), so browsing several media-rich chats doesn't accumulate large slices.
 */
export function useChatMessages(sessionId: string, chatId: string | null): UseQueryResult<ChatMessageView[], Error> {
  const qc = useQueryClient();
  return useQuery<ChatMessageView[], Error>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => {
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, 100),
        sessionApi.getChatHistory(sessionId, chatId!, 100, false),
      ]);
      if (dbRes.status === 'rejected' && historyRes.status === 'rejected') throw dbRes.reason;
      const dbMessages = dbRes.status === 'fulfilled' ? dbRes.value.messages : [];
      // Hydrate the sibling total cache from the DB response we already fetched, so the "Load older"
      // control knows `hasOlder` without an extra round-trip in the common case. The dedicated
      // useChatMessagesTotal query (below) stays as the fallback/refresh path for load-older updates.
      if (dbRes.status === 'fulfilled') {
        qc.setQueryData(messagesTotalQueryKey(sessionId, chatId ?? ''), dbRes.value.total);
      }
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      return mergeChatMessages(dbMessages, history);
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Total row count for a chat's full history in the DB (the `total` field of the messages endpoint).
 * Drives the "Load older" control visibility: `hasOlder = loadedCount < total`. Cheap limit=1 fetch
 * when not already hydrated by useChatMessages; refreshed from the load-older response so the
 * control hides once everything is loaded. staleTime: Infinity — paging must not auto-refetch.
 */
export function useChatMessagesTotal(sessionId: string, chatId: string | null): UseQueryResult<number, Error> {
  return useQuery<number, Error>({
    queryKey: messagesTotalQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => (await sessionApi.getChatMessages(sessionId, chatId!, 1, 0)).total,
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Load one older page of DB history (100 rows) and PREPEND it onto the messages cache. Does NOT touch
 * the engine-history endpoint (no offset/total, 501s under Baileys) and does NOT reset the slice —
 * it only prepends via `prependChatMessages` (dedup by `waMessageId ?? id`, existing wins), keeping
 * staleTime: Infinity and realtime WS appends intact. Also refreshes the total cache from the
 * response so the "Load older" control hides once the whole thread is loaded. `offset` is the
 * number of already-loaded rows (messages.length) — pass that from the caller.
 */
export function useLoadOlderMessages(sessionId: string, chatId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (offset: number) =>
      sessionApi.getChatMessages(sessionId, chatId!, 100, offset),
    onSuccess: res => {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId ?? ''), old =>
        prependChatMessages(old ?? [], res.messages),
      );
      qc.setQueryData(messagesTotalQueryKey(sessionId, chatId ?? ''), res.total);
    },
  });
}

/**
 * Mutation helpers that write directly to the React Query cache. Use these
 * from the WebSocket subscriber, the optimistic-send flow, and ACK handlers
 * instead of calling setMessages locally.
 */
export function useChatMessagesActions() {
  const qc = useQueryClient();

  return {
    appendMessage(sessionId: string, chatId: string, msg: ChatMessageView) {
      // Only append to a slice that already exists (a chat that has been opened). Do NOT seed a slice
      // for a never-opened chat: with staleTime: Infinity that phantom slice would be "fresh", so
      // opening the chat would skip the full-history queryFn and show only this one message (truncated
      // history). Returning undefined from the updater is a no-op when there is no cached data.
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), old =>
        old === undefined ? undefined : mergeOrAppend(old, msg),
      );
    },
    updateMessage(sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) =>
        updateMessageById(old, id, patch),
      );
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) => removeMessageById(old, id));
    },
  };
}
