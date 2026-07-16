import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { nextReconnectState } from '../utils/reconnectState';
import {
  Search,
  Send,
  ArrowLeft,
  Loader2,
  User,
  Users,
  AlertCircle,
  MessageSquare,
  Paperclip,
  Smile,
  X,
  CornerUpLeft,
  Trash2,
} from 'lucide-react';
import {
  sessionApi,
  messageApi,
  asMessageType,
  fetchMessageMedia,
  type Session,
  type Chat,
  type MessageType,
  type SearchHit,
} from '../services/api';
import { mergeDeliveryStatus, type ChatMessageView } from '../utils/chatMessages';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  useChatMessages,
  useChatMessagesActions,
  useChatMessagesTotal,
  useLoadOlderMessages,
  messagesQueryKey,
} from '../hooks/useChatMessages';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import MessageBody from '../components/chats/MessageBody';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';
import { highlightSearchMatch, clearSearchHighlights } from '../utils/highlightSearchHit';
import './Chats.css';

type MessageMedia = { mimetype: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };

// mergeDeliveryStatus (forward-only delivery-tick merge) is shared with mergeOrAppend in utils/chatMessages
// so the WS append path and the ack path apply the exact same rule.

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe?: boolean;
  author?: string;
  isGroup?: boolean;
  contact?: { id?: string; number?: string; name?: string; pushName?: string; shortName?: string };
  senderPhone?: string | null;
  media?: MessageMedia;
  quotedMessage?: { id: string; body: string };
  // The backend emits `call` as a top-level field on the live `message.received` event (it's only
  // folded into `metadata` on the persisted/history path), so declare it here to carry it through.
  call?: { video: boolean; missed: boolean };
  metadata?: ChatMessageView['metadata'];
}

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  // `blob:` URLs (created by fetchMessageMedia for on-demand history media) pass through unchanged,
  // alongside the existing `data:`/`http(s):` cases, so they don't get re-wrapped as base64.
  if (
    media.data.startsWith('data:') ||
    media.data.startsWith('http://') ||
    media.data.startsWith('https://') ||
    media.data.startsWith('blob:')
  ) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { canWrite } = useRole();
  const { error: showErrorToast, warning: showWarningToast } = useToast();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Sidebar search mode: 'chats' filters the chat list by name/id; 'messages' swaps the chat list for
  // GlobalSearch results. The component lives inside the sidebar so its results scroll in the same
  // region as the chat list — its CSS assumes a `flex:1` sibling slot and inflates the page header
  // when mounted there instead.
  const [searchMode, setSearchMode] = useState<'chats' | 'messages'>('chats');

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
  } = useChatMessages(selectedSessionId, activeChat?.id ?? null);
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  // Full-history row count + load-older pagination (B). `total` is the DB's full row count for this
  // chat; the messages slice only holds the newest 100 (plus anything prepended). `hasOlder` decides
  // whether the "Load older" control renders. Both use staleTime: Infinity so paging never refetches
  // the whole slice — useLoadOlderMessages only prepends older pages onto the cached array.
  const { data: total } = useChatMessagesTotal(selectedSessionId, activeChat?.id ?? null);
  const { mutate: loadOlder, isPending: loadingOlder } = useLoadOlderMessages(
    selectedSessionId,
    activeChat?.id ?? null,
  );
  const hasOlder = messages.length < (total ?? messages.length);

  // D3 — click-to-load media: history media arrives as an omitted placeholder. On click we fetch the
  // bytes from the media endpoint, turn the Blob into an object URL, and cache it per message id so
  // the normal renderMedia branches render it. Per-message loading/failed flags drive the button
  // state. Blob URLs are document-scoped and must be revoked to avoid leaks (chat-switch + unmount).
  const [loadedMediaUrls, setLoadedMediaUrls] = useState<Record<string, string>>({});
  const [mediaLoading, setMediaLoading] = useState<Record<string, boolean>>({});
  const [mediaLoadFailed, setMediaLoadFailed] = useState<Record<string, boolean>>({});
  // Mirror for the unmount cleanup (the state closure would otherwise be stale).
  const loadedMediaUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    loadedMediaUrlsRef.current = loadedMediaUrls;
  }, [loadedMediaUrls]);

  const handleLoadMedia = useCallback(
    async (msg: ChatMessageView) => {
      const mediaId = msg.waMessageId ?? msg.id;
      if (!mediaId) return;
      setMediaLoading(prev => ({ ...prev, [msg.id]: true }));
      setMediaLoadFailed(prev => ({ ...prev, [msg.id]: false }));
      try {
        const blob = await fetchMessageMedia(selectedSessionId, mediaId);
        const url = URL.createObjectURL(blob);
        setLoadedMediaUrls(prev => {
          // Revoke any previous URL for this message before replacing (retry / re-fetch case).
          const old = prev[msg.id];
          if (old) URL.revokeObjectURL(old);
          return { ...prev, [msg.id]: url };
        });
      } catch (err) {
        setMediaLoadFailed(prev => ({ ...prev, [msg.id]: true }));
        showErrorToast(t('chats.media.loadMediaFailed'), err instanceof Error ? err.message : undefined);
      } finally {
        setMediaLoading(prev => ({ ...prev, [msg.id]: false }));
      }
    },
    [selectedSessionId, t, showErrorToast],
  );

  // Revoke blob URLs when leaving a chat (the per-message map is chat-scoped) and on page unmount.
  // Chat switch clears the maps so stale URLs from the previous chat don't leak and don't accidentally
  // match a different message that reused the same row id.
  useEffect(() => {
    setLoadedMediaUrls(prev => {
      for (const url of Object.values(prev)) URL.revokeObjectURL(url);
      return {};
    });
    setMediaLoading({});
    setMediaLoadFailed({});
  }, [activeChat?.id]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(loadedMediaUrlsRef.current)) URL.revokeObjectURL(url);
    };
  }, []);

  // Lightbox state for media viewer
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // File attachments
  const [attachment, setAttachment] = useState<{
    file: File;
    base64: string;
    mimetype: string;
    filename: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);

  // References
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);

  // Per-chat scroll-position memory + auto-scroll heuristic.
  // Pass `messages.length > 0` as the loaded signal: it stays stable once the
  // chat has any message (doesn't toggle per append) and covers both the
  // first-fetch resolution and a WS-driven first message on a previously-empty
  // chat. `loadingMessages` alone would miss the latter case.
  const { containerRef: messagesContainerRef, onMessageAppended } =
    useChatScrollPosition(activeChat?.id ?? null, messages.length > 0);

  // Popular emojis
  const popularEmojis = ['😀', '😂', '👍', '❤️', '🔥', '👏', '🙏', '🎉', '💡', '🤔', '😅', '😍', '😊', '😭', '😎', '😜', '🚀', '✨'];

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        const readySessions = list.filter(s => s.status === 'ready');
        setSessions(readySessions);
        if (readySessions.length > 0) {
          setSelectedSessionId(readySessions[0].id);
        }
      } catch (err) {
        showErrorToast(t('chats.errors.loadSessions'), err instanceof Error ? err.message : undefined);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [t, showErrorToast]);

  // 2. Fetch chats when active session changes
  const loadChats = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      try {
        setLoadingChats(true);
        const data = await sessionApi.getChats(sessionId);
        const sorted = [...data].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setChats(sorted);
      } catch (err) {
        showErrorToast(t('chats.errors.loadChats'), err instanceof Error ? err.message : undefined);
        setChats([]);
      } finally {
        setLoadingChats(false);
      }
    },
    [t, showErrorToast],
  );

  useEffect(() => {
    if (selectedSessionId) {
      void loadChats(selectedSessionId);
      setActiveChat(null);
      setAttachment(null);
      setPreviewUrl(null);
    }
  }, [selectedSessionId, loadChats]);

  // Revoke the object URL created for an image-attachment preview once it is replaced, cleared, or
  // the page unmounts. The cleanup runs with the previous value on every change, so this single
  // effect covers all paths (new file, remove, session switch) — otherwise each preview leaks a
  // blob held for the lifetime of the document.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const markChatRead = useCallback(
    (chatId: string) => {
      void sessionApi.markChatRead(selectedSessionId, chatId).catch(err => {
        showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
      });
    },
    [selectedSessionId, t, showWarningToast],
  );

  // 3. WebSocket integration for real-time messages
  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (event.sessionId !== selectedSessionId) return;

      const newMsg = event.message as unknown as IncomingWsMessage;

      const mappedMessage: ChatMessageView = {
        id: newMsg.id,
        waMessageId: newMsg.id,
        chatId: newMsg.chatId,
        from: newMsg.from,
        to: newMsg.to,
        body: newMsg.body,
        type: asMessageType(newMsg.type),
        direction: newMsg.fromMe ? 'outgoing' : 'incoming',
        status: 'sent',
        timestamp: newMsg.timestamp,
        createdAt: new Date(newMsg.timestamp * 1000).toISOString(),
        metadata: {
          ...(newMsg.metadata || {}),
          media: newMsg.metadata?.media ?? newMsg.media,
          quotedMessage: newMsg.metadata?.quotedMessage ?? newMsg.quotedMessage,
          call: newMsg.metadata?.call ?? newMsg.call,
          // Carry per-sender info from the WS payload so the bubble can render author name/phone.
          // For groups `from` is the *chat* JID, not the sender — `author` carries the real sender.
          author: newMsg.author,
          isGroup: newMsg.isGroup,
          contact: newMsg.contact,
          senderPhone: newMsg.senderPhone,
        },
      };

      // Always write to the React Query cache for this message's session — keeps non-active chats
      // up to date so re-opening them shows fresh data without a refetch.
      appendMessage(event.sessionId, newMsg.chatId, mappedMessage);

      // If the message belongs to the currently visible chat, mark-as-read and run the scroll heuristic.
      if (activeChat && newMsg.chatId === activeChat.id) {
        markChatRead(activeChat.id);
        if (!newMsg.fromMe) onMessageAppended('incoming');
      }

      // Update sidebar chat list
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === newMsg.chatId);
        if (chatIndex === -1) {
          // A message for a chat not in the sidebar. Suppress the refetch ONLY for an outgoing echo
          // addressed as `@lid`: a LID-migrated contact echoes back `@lid` while the user sent to
          // `@c.us`, and the sent bubble is already reconciled in the active chat, so refetching on
          // every such send just churns the chat list (#583 R2). Incoming messages and ordinary
          // outgoing sends to a genuinely new chat still refetch so the sidebar stays complete.
          const isMigratedEcho = newMsg.fromMe && (newMsg.chatId?.endsWith('@lid') ?? false);
          if (!isMigratedEcho) {
            void loadChats(selectedSessionId);
          }
          return prevChats;
        }

        const updatedChats = [...prevChats];
        const targetChat = { ...updatedChats[chatIndex] };
        // A location message's body is the (multi-KB) base64 map thumbnail; show a label instead.
        targetChat.lastMessage = newMsg.type === 'location' ? `📍 ${t('chats.media.location')}` : newMsg.body;
        targetChat.timestamp = newMsg.timestamp;

        if (!newMsg.fromMe && (!activeChat || activeChat.id !== targetChat.id)) {
          targetChat.unreadCount = (targetChat.unreadCount || 0) + 1;
        }

        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(targetChat);
        return updatedChats;
      });
    },
    [selectedSessionId, activeChat, loadChats, markChatRead, appendMessage, onMessageAppended, t],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; status: ChatMessageView['status'] }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Acks can arrive for any cached chat under this session. Walk every cache entry under
      // ['messages', event.sessionId, *] and apply the forward-only delivery merge in place.
      const caches = queryClient.getQueriesData<ChatMessageView[]>({
        queryKey: ['messages', event.sessionId],
      });
      for (const [key, list] of caches) {
        if (!list) continue;
        const idx = list.findIndex(
          m => m.id === event.messageId || m.waMessageId === event.messageId,
        );
        if (idx === -1) continue;
        const target = list[idx];
        // Backend now sends the neutral delivery status directly (no engine-specific ack codes).
        // Merge forward-only so an out-of-order/replayed lower ack can't downgrade the tick.
        const nextStatus = mergeDeliveryStatus(target.status, event.status) ?? target.status;
        const next = list.slice();
        next[idx] = { ...target, status: nextStatus };
        queryClient.setQueryData(key, next);
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions: Record<string, string> }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Reactions update `metadata.reactions` while preserving `metadata.media` / `metadata.quotedMessage`,
      // so we must read the prior message and deep-merge — `updateMessage`'s shallow merge would clobber
      // the rest of metadata.
      const caches = queryClient.getQueriesData<ChatMessageView[]>({
        queryKey: ['messages', event.sessionId],
      });
      for (const [key, list] of caches) {
        if (!list) continue;
        const idx = list.findIndex(
          m => m.id === event.messageId || m.waMessageId === event.messageId,
        );
        if (idx === -1) continue;
        const target = list[idx];
        const next = list.slice();
        next[idx] = {
          ...target,
          metadata: { ...(target.metadata || {}), reactions: event.reactions },
        };
        queryClient.setQueryData(key, next);
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; type: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Walk every cached chat under this session, find the message by id or waMessageId and zero it
      // — the backend emits an empty body; the localized "deleted" label is rendered below.
      const caches = queryClient.getQueriesData<ChatMessageView[]>({
        queryKey: ['messages', event.sessionId],
      });
      for (const [key, list] of caches) {
        if (!list) continue;
        const idx = list.findIndex(m => m.id === event.id || m.waMessageId === event.id);
        if (idx === -1) continue;
        const target = list[idx];
        const next = list.slice();
        next[idx] = { ...target, body: '', type: asMessageType(event.type) };
        queryClient.setQueryData(key, next);
      }
    },
    [selectedSessionId, queryClient],
  );

  const { isConnected, connectionFailed, reconnect, subscribe, unsubscribe } = useWebSocket({
    onMessage: handleIncomingMessage,
    onMessageAck: handleIncomingMessageAck,
    onMessageReaction: handleIncomingMessageReaction,
    onMessageRevoked: handleIncomingMessageRevoked,
  });

  // A transient WebSocket gap means message.received/ack/revoke events were missed, and the chat
  // cache uses staleTime: Infinity so it won't refetch on its own. On a reconnect (isConnected
  // false→true after a prior connect), invalidate the active session's messages so the thread the
  // gap left stale refreshes. The transition logic is unit-tested in utils/reconnectState.
  const reconnectHadConnected = useRef(false);
  const reconnectWasDisconnected = useRef(false);
  useEffect(() => {
    const decision = nextReconnectState({
      isConnected,
      hadConnected: reconnectHadConnected.current,
      wasDisconnected: reconnectWasDisconnected.current,
    });
    reconnectHadConnected.current = decision.hadConnected;
    reconnectWasDisconnected.current = decision.wasDisconnected;
    if (decision.invalidate) {
      queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
    }
  }, [isConnected, selectedSessionId, queryClient]);

  useEffect(() => {
    if (selectedSessionId && isConnected) {
      subscribe(selectedSessionId, [
        'message.received',
        'message.sent',
        'message.ack',
        'message.reaction',
        'message.revoked',
      ]);
      return () => {
        unsubscribe(selectedSessionId);
      };
    }
  }, [selectedSessionId, isConnected, subscribe, unsubscribe]);

  // 4. Message history is fetched by useChatMessages (React Query). The active-chat side effects
  // (mark-as-read + clear sidebar unread badge) live in a small effect below.

  const handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
    if (!selectedSessionId || !activeChat) return;

    const msgId = msg.waMessageId || msg.id;
    const currentReactions = msg.metadata?.reactions || {};
    const sessionPhone = sessions.find(s => s.id === selectedSessionId)?.phone || 'me';

    let alreadyReacted = false;
    for (const [sender, emo] of Object.entries(currentReactions)) {
      if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
        alreadyReacted = true;
        break;
      }
    }

    const emojiToSend = alreadyReacted ? '' : emoji;

    try {
      await messageApi.react(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        emoji: emojiToSend,
      });

      // Deep-merge metadata.reactions so existing media / quotedMessage on metadata survive.
      const key = messagesQueryKey(selectedSessionId, activeChat.id);
      queryClient.setQueryData<ChatMessageView[]>(key, (old = []) =>
        old.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            const metadata = m.metadata || {};
            const reactions = { ...(metadata.reactions || {}) };
            if (emojiToSend === '') {
              delete reactions['me'];
            } else {
              reactions['me'] = emojiToSend;
            }
            return { ...m, metadata: { ...metadata, reactions } };
          }
          return m;
        }),
      );
    } catch (err) {
      showErrorToast(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      updateMessage(selectedSessionId, activeChat.id, msg.id, { body: '', type: 'revoked' });
    } catch (err) {
      showErrorToast(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

  // Side effects when the active chat changes: mark-as-read on the gateway + clear sidebar unread badge.
  // The message-history fetch is driven by useChatMessages; scroll restoration is driven by
  // useChatScrollPosition (both keyed off activeChat?.id). Deliberately keying off `activeChat?.id`
  // (not the whole object) so a sidebar reshuffle that mutates the activeChat instance doesn't re-fire
  // the mark-as-read RPC for the same chat.
  useEffect(() => {
    if (!activeChat) return;
    markChatRead(activeChat.id);
    setChats(prev => prev.map(c => (c.id === activeChat.id ? { ...c, unreadCount: 0 } : c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, markChatRead]);

  // --- Global search: jump to a hit's chat + scroll to the message + highlight it ---
  // searchHitTarget carries the intent across the multi-step async flow:
  //   1. cross-session hit → setSelectedSessionId reloads chats list (effect 1 picks the chat)
  //   2. messages may not include the hit's waMessageId yet (the first 100 don't always cover it)
  //      → the resolver effect triggers useLoadOlderMessages, which prepends pages one at a time
  //      → re-runs on every messages change until the hit is in the slice, then scrolls + highlights
  //   3. if even the full DB history has no match (race with retention, deleted, etc.) we give up
  //      gracefully — the user is still in the right chat.
  // `highlightedHitId` is a separate state because the highlight only applies after the DOM element
  // actually exists and we want the visual class to outlive the scroll effect (CSS animation fades it).
  const [searchHitTarget, setSearchHitTarget] = useState<{
    chatId: string;
    waMessageId: string;
    matchStart: number;
    matchLength: number;
  } | null>(null);
  const [highlightedHitId, setHighlightedHitId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Load-older scroll anchor (B) ---
  // Prepending older messages grows scrollHeight above the viewport; without anchoring, the view
  // jumps. Before calling loadOlder we snapshot the geometry of the currently-first message element
  // (its DOM node + offsetTop) and the current scrollTop. Once the older page renders, that same DOM
  // node (kept by React via its `key`) has shifted down by exactly the prepended height; we restore
  // scrollTop by that delta so the viewport stays on the same content. The "first message changed"
  // check distinguishes a real prepend from a failed load or a bottom WS append (which don't move the
  // first message), so this never disturbs useChatScrollPosition's restore or onMessageAppended.
  // Shared between the user-driven "Load older" path and the search-jump auto-load-older path —
  // the search-jump path sets `forSearchJump` so the anchor effect skips the scroll restoration
  // (it will scroll to the hit via scrollIntoView instead).
  const prependAnchorRef = useRef<{
    firstEl: HTMLElement | null;
    firstTop: number;
    prevScrollTop: number;
    forSearchJump: boolean;
  } | null>(null);

  const handleSearchHit = useCallback(
    (hit: SearchHit) => {
      // Reset any prior highlight before starting the new jump.
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      setHighlightedHitId(null);
      // matchStart/length tell the resolver where in `body` the matched substring lives so it can
      // scroll to the exact line + wrap it in <mark>. The built-in FTS provider always populates
      // them; an older plugin or a stemming match that the body doesn't contain verbatim yields
      // (-1, -1) and the resolver falls back to the whole-message scroll + message-level highlight.
      setSearchHitTarget({
        chatId: hit.chatId,
        waMessageId: hit.waMessageId,
        matchStart: hit.matchStart,
        matchLength: hit.matchLength,
      });
      if (hit.sessionId !== selectedSessionId) {
        // Switching session triggers loadChats; the effect below selects the chat once the list lands.
        setSelectedSessionId(hit.sessionId);
      } else {
        const chat = chats.find(c => c.id === hit.chatId);
        if (chat) setActiveChat(chat);
        // If the chat isn't in the list yet, the post-chats effect will pick it up.
      }
    },
    [selectedSessionId, chats],
  );

  // After a session switch (or first mount) the chats list reloads — pick up the pending chat once it
  // appears. Once active, scroll-into-view kicks in (next effect).
  useEffect(() => {
    const target = searchHitTarget;
    if (!target || activeChat?.id === target.chatId) return;
    const chat = chats.find(c => c.id === target.chatId);
    if (chat) setActiveChat(chat);
  }, [chats, activeChat, searchHitTarget]);

  // Scroll-into-view + auto-load-older resolver. Runs whenever the active chat, its messages, or the
  // total change, and keeps loading older pages until the hit is in the slice or we exhaust the DB.
  // Safety cap (LOAD_OLDER_MAX_PAGES) prevents a runaway if the hit's waMessageId is wrong or the row
  // was deleted. Uses the same scroll-anchor ref the manual "Load older" path uses, so each prepend
  // preserves the user's current scroll position when they're not searching.
  //
  // Note: `selectedSessionId` and `activeChat?.id` are guaranteed non-null at this point — the
  // effect's first two guards (`!activeChat`, `activeChat.id !== target.chatId`) ensure the right
  // chat is active. We coerce to assert that to the TS checker without changing behavior.
  const LOAD_OLDER_MAX_PAGES = 20;
  const loadedOlderPagesRef = useRef(0);
  // Destructure mutate + isPending from the mutation hook so the effect's deps are stable; depending
  // on the whole object (which has a new identity every render) would re-fire the effect every render
  // and create a mutation loop. Renamed to loadOlderForSearch to avoid colliding with the user-driven
  // "Load older" mutation defined above.
  const sessionIdForSearch = activeChat ? selectedSessionId : '';
  const chatIdForSearch = activeChat?.id ?? '';
  const { mutate: loadOlderForSearch, isPending: loadOlderForSearchPending } = useLoadOlderMessages(
    sessionIdForSearch,
    chatIdForSearch,
  );
  useLayoutEffect(() => {
    const target = searchHitTarget;
    if (!target || !activeChat || activeChat.id !== target.chatId) return;
    if (loadingMessages || messages.length === 0) return;
    const container = messagesContainerRef.current;
    if (!container) return;

    const found = messages.find(m => m.waMessageId === target.waMessageId);
    if (!found) {
      // Not in the loaded slice. Load another older page if we still have rows in the DB and haven't
      // hit the cap. Snapshot the scroll anchor BEFORE the prepend runs, so the position is preserved
      // when the hit is still not on-screen (otherwise the page jumps to the bottom of the new oldest
      // row, and we'd never see the hit even after more pages load).
      if (loadOlderForSearchPending) return;
      if (loadedOlderPagesRef.current >= LOAD_OLDER_MAX_PAGES) {
        // Give up: DB doesn't have it, or it's been too long. Clear the target so we stop retrying.
        setSearchHitTarget(null);
        loadedOlderPagesRef.current = 0;
        return;
      }
      if (messages.length < (total || 0)) {
        loadedOlderPagesRef.current += 1;
        const anchor = messagesContainerRef.current?.querySelector<HTMLElement>('.message-bubble-wrapper');
        if (anchor) {
          prependAnchorRef.current = {
            firstEl: anchor,
            firstTop: anchor.offsetTop,
            prevScrollTop: messagesContainerRef.current!.scrollTop,
            // Flag so the manual anchor effect below skips its scroll restoration — the resolver
            // will scroll to the hit via scrollIntoView on the next render instead.
            forSearchJump: true,
          };
        }
        loadOlderForSearch(messages.length);
      } else {
        // No more rows to load — give up gracefully.
        setSearchHitTarget(null);
        loadedOlderPagesRef.current = 0;
      }
      return;
    }

    // Hit is in the slice. Find its DOM element, scroll the matched LINE (not the whole message)
    // into view, then wrap the matched substring in a <mark class="is-search-match"> so the user
    // can see exactly which word/phrase the search returned. Falls back to the whole-message
    // scroll + message-level highlight when the inline match can't be located (body edited since
    // indexing, the body is empty/revoked, or the rendered text splits the substring across nodes).
    try {
      const wrapper = container.querySelector<HTMLElement>(
        `[data-wa-message-id="${CSS.escape(target.waMessageId)}"]`,
      );
      if (wrapper) {
        // First clear any prior highlights across the whole container so a stale <mark> from an
        // earlier search doesn't survive the new jump.
        clearSearchHighlights(container);

        // Wait for React to commit this render before walking the DOM — useLayoutEffect runs
        // synchronously after the commit so the wrapper is mounted, but if a prepend was just
        // applied we need one more frame for the new rows to settle.
        requestAnimationFrame(() => {
          const w = messagesContainerRef.current?.querySelector<HTMLElement>(
            `[data-wa-message-id="${CSS.escape(target.waMessageId)}"]`,
          );
          if (!w) return;
          // Re-locate the wrapper inside the rAF (it might have been replaced by React's
          // reconciliation when the prepend committed).
          const bodyEl =
            w.querySelector<HTMLElement>('.message-text') ||
            w.querySelector<HTMLElement>('.message-bubble') ||
            w;

          const hasMatchPosition = target.matchStart >= 0 && target.matchLength > 0;
          // Pull the rendered body text once: even if the DOM split the matched substring across
          // multiple text nodes, the substring itself is recoverable from the raw `body` (it was
          // indexed verbatim by FTS). Fall back to the wrapper scroll when the substring isn't in
          // the rendered text.
          const rendered = bodyEl.textContent ?? '';
          const matchedText = hasMatchPosition
            ? found.body?.slice(target.matchStart, target.matchStart + target.matchLength) ?? ''
            : '';
          const mark = hasMatchPosition && matchedText && rendered.includes(matchedText)
            ? highlightSearchMatch(bodyEl, matchedText)
            : null;

          if (mark) {
            // Scroll the actual <mark> into view (not the whole message) so the matched line lands
            // centered when the message is taller than the viewport (multi-line messages).
            mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } else {
            // Fallback: scroll the whole message wrapper. Still applies the message-level pulse.
            w.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        });

        setHighlightedHitId(target.waMessageId);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => {
          // Strip the <mark> wrappers so the DOM returns to its original state, then drop the
          // message-level highlight class via setState.
          const c = messagesContainerRef.current;
          if (c) clearSearchHighlights(c);
          setHighlightedHitId(null);
          highlightTimerRef.current = null;
        }, 4000);
      }
    } catch {
      // waMessageId contained unexpected characters — ignore.
    }
    setSearchHitTarget(null);
    loadedOlderPagesRef.current = 0;
  }, [
    activeChat,
    loadingMessages,
    messages,
    total,
    messagesContainerRef,
    searchHitTarget,
    loadOlderForSearch,
    loadOlderForSearchPending,
  ]);

  // Clean up the highlight timer on unmount.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  // When the active chat changes, any leftover <mark class="is-search-match"> in the old chat's
  // DOM is already gone (the messages list unmounted), but the React state (highlightedHitId) and
  // the pending timer can still be live. Clear both so the pulse doesn't flash on the new chat's
  // top row and a stale timer doesn't blank the next highlight prematurely.
  useEffect(() => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedHitId(null);
  }, [activeChat?.id]);

  // --- Load-older scroll anchor effect (B) ---
  // (The prependAnchorRef itself is declared near the top of the component, alongside searchHitTarget,
  // so the search-jump resolver effect can also set it without a forward reference.)
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    // The search-jump resolver path sets this flag — it will scroll to the hit via scrollIntoView
    // on the next render, so we don't want to restore the previous scroll position here (it would
    // fight the scrollIntoView and land the viewport somewhere random).
    if (anchor.forSearchJump) return;
    const el = messagesContainerRef.current;
    if (!el || !anchor.firstEl) return;
    // Only adjust when a prepend actually happened: the previously-first message is no longer the
    // first .message-bubble-wrapper (older rows were inserted above it). A failed load or a WS
    // append leaves the first message unchanged → no-op.
    const currentFirst = el.querySelector<HTMLElement>('.message-bubble-wrapper');
    if (currentFirst === anchor.firstEl) return;
    el.scrollTop = anchor.prevScrollTop + (anchor.firstEl.offsetTop - anchor.firstTop);
  }, [messages.length, messagesContainerRef]);

  const handleLoadOlder = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) {
      loadOlder(messages.length);
      return;
    }
    const firstMsg = el.querySelector<HTMLElement>('.message-bubble-wrapper');
    prependAnchorRef.current = {
      firstEl: firstMsg,
      firstTop: firstMsg?.offsetTop ?? 0,
      prevScrollTop: el.scrollTop,
      forSearchJump: false,
    };
    loadOlder(messages.length);
  }, [loadOlder, messages.length, messagesContainerRef]);

  // 5. Handle file selection & base64 conversion
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleEmojiClick = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  // 7. Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: attachment
        ? attachment.mimetype.startsWith('image/') ||
          attachment.mimetype.startsWith('video/') ||
          attachment.mimetype.startsWith('audio/')
          ? textToSend
          : attachment.filename
        : textToSend,
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: attachment
        ? {
            media: {
              mimetype: attachment.mimetype,
              filename: attachment.filename,
              data: attachment.base64,
            },
          }
        : replyingTo
          ? {
              quotedMessage: {
                id: replyingTo.waMessageId || replyingTo.id,
                body: replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body,
              },
            }
          : undefined,
    };

    appendMessage(selectedSessionId, activeChat.id, tempMessage);
    onMessageAppended('outgoing');

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        result = await messageApi.sendMedia(selectedSessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      // Race guard: the realtime `message.sent` echo can arrive before this response and already
      // append the message by its real WA id (the dedup at receive time misses because the
      // optimistic placeholder still carries the temp id). If so, drop the placeholder instead of
      // renaming it — otherwise both the echo and the renamed temp render as duplicate bubbles.
      const sendKey = messagesQueryKey(selectedSessionId, activeChat.id);
      queryClient.setQueryData<ChatMessageView[]>(sendKey, (prev = []) => {
        const echoAlreadyAdded = prev.some(
          m => m.id === result.messageId || m.waMessageId === result.messageId,
        );
        if (echoAlreadyAdded) {
          return prev.filter(m => m.id !== tempId);
        }
        return prev.map(m =>
          m.id === tempId
            ? { ...m, id: result.messageId, waMessageId: result.messageId, status: 'sent' }
            : m,
        );
      });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === activeChat.id);
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment
          ? `[${currentAttachment.mimetype.split('/')[0]}]`
          : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
    } finally {
      setSending(false);
    }
  };

  // Helper formats
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatLastMessageSnippet = (chat: Chat) => chat.lastMessage || '';

  const formatChatTime = useCallback(
    (timestamp?: number) => {
      if (!timestamp) return '';
      const date = new Date(timestamp * 1000);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) {
        return t('chats.yesterday');
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    [t],
  );

  const filteredChats = chats.filter(
    c =>
      c.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.id.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Image media items for the lightbox, in render order. `getMediaSrc` reconstructs a usable src
  // from either a base64 payload or a URL — the ChatMessageView shape stores both in `data`. A
  // click-loaded history image (omitted placeholder) contributes its blob URL from loadedMediaUrls.
  const imageMedia = useMemo<LightboxItem[]>(
    () =>
      messages
        .filter(m => {
          if (m.type !== 'image') return false;
          const loadedUrl = m.metadata?.media?.omitted ? loadedMediaUrls[m.id] : undefined;
          return loadedUrl ? true : Boolean(getMediaSrc(m.metadata?.media));
        })
        .map(m => {
          const loadedUrl = m.metadata?.media?.omitted ? loadedMediaUrls[m.id] : undefined;
          return {
            id: m.id,
            url: loadedUrl || getMediaSrc(m.metadata?.media),
            alt: m.body || m.metadata?.media?.filename || '',
            senderName: undefined,
            timestamp: formatChatTime(m.timestamp || Math.floor(new Date(m.createdAt).getTime() / 1000)),
          };
        }),
    [messages, formatChatTime, loadedMediaUrls],
  );

  return (
    <div className="chats-page">
      <PageHeader title={t('nav.chats')} subtitle={t('chats.subtitle')} />

      {/* Real-time connection permanently dropped — let the user re-establish it instead of
          silently showing stale chats. */}
      {connectionFailed && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>{t('common.disconnected')}</span>
          <button className="btn-secondary" onClick={reconnect}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {loadingSessions ? (
        <div className="chats-loading-container">
          <Loader2 className="animate-spin" size={32} />
          <p>{t('common.loading')}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="chats-error-state">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.noSessionsTitle')}</h3>
          <p>
            <Trans i18nKey="chats.noSessionsDesc">
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat
              feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div className={`chats-layout ${activeChat ? 'has-active-chat' : ''}`}>
          {/* LEFT SIDEBAR: session & chat rooms */}
          <aside className="chats-sidebar">
            <div className="sidebar-header-box">
              {/* Session selector */}
              <div className="session-select-group">
                <label className="form-label">{t('chats.sessionLabel')}</label>
                <select
                  value={selectedSessionId}
                  onChange={e => setSelectedSessionId(e.target.value)}
                  className="session-selector"
                >
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.phone || t('chats.noPhone')})
                    </option>
                  ))}
                </select>
              </div>

              {/* Search mode toggle + (chats-mode) name/id filter input. Messages mode renders
                  GlobalSearch as a flex:1 sibling below — see below. */}
              <div className="sidebar-search-modes" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={searchMode === 'chats'}
                  className={`sidebar-search-mode ${searchMode === 'chats' ? 'active' : ''}`}
                  onClick={() => setSearchMode('chats')}
                >
                  {t('chats.searchMode.chats', 'Chats')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={searchMode === 'messages'}
                  className={`sidebar-search-mode ${searchMode === 'messages' ? 'active' : ''}`}
                  onClick={() => setSearchMode('messages')}
                >
                  {t('chats.searchMode.messages', 'Messages')}
                </button>
              </div>

              {searchMode === 'chats' && (
                <div className="chat-search-input">
                  <Search size={18} />
                  <input
                    type="text"
                    placeholder={t('chats.searchPlaceholder')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Chat list (chats mode) OR global message search panel (messages mode). Both share
                the same .chats-list / .global-search `flex:1; overflow-y: auto` geometry so they
                fill the sidebar's remaining height identically. */}
            {searchMode === 'chats' ? (
              <div className="chats-list">
              {loadingChats ? (
                <div className="chats-list-loading">
                  <Loader2 className="animate-spin" size={24} />
                  <span>{t('chats.loadingChats')}</span>
                </div>
              ) : filteredChats.length === 0 ? (
                <div className="chats-list-empty">
                  <span>{t('chats.empty')}</span>
                </div>
              ) : (
                filteredChats.map(chat => {
                  const isActive = activeChat?.id === chat.id;
                  return (
                    <div
                      key={chat.id}
                      className={`chat-item-card ${isActive ? 'active' : ''}`}
                      onClick={() => setActiveChat(chat)}
                    >
                      <div className="chat-avatar">
                        {chat.isGroup ? <Users size={20} /> : <User size={20} />}
                      </div>

                      <div className="chat-item-info">
                        <div className="chat-item-top">
                          <span className="chat-item-name" title={chat.name || chat.id}>
                            {chat.name || chat.id.split('@')[0]}
                          </span>
                          {chat.timestamp && (
                            <span className="chat-item-time">{formatChatTime(chat.timestamp)}</span>
                          )}
                        </div>
                        <div className="chat-item-bottom">
                          <span className="chat-item-snippet" title={formatLastMessageSnippet(chat)}>
                            {formatLastMessageSnippet(chat) || (
                              <span className="no-message">{t('chats.noMessageYet')}</span>
                            )}
                          </span>
                          {chat.unreadCount > 0 && (
                            <span className="chat-unread-badge">{chat.unreadCount}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            ) : (
              <GlobalSearch sessionId={selectedSessionId} onResultClick={handleSearchHit} />
            )}
          </aside>

          {/* RIGHT VIEW: active chat room */}
          <main className="chats-room">
            {activeChat ? (
              <div className="room-container">
                {/* Room header */}
                <header className="room-header">
                  <button className="room-back" onClick={() => setActiveChat(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  <div className="room-avatar">
                    {activeChat.isGroup ? <Users size={20} /> : <User size={20} />}
                  </div>
                  <div className="room-contact-info">
                    <h3>{activeChat.name || activeChat.id.split('@')[0]}</h3>
                    <span>{activeChat.id}</span>
                  </div>
                </header>

                {/* Messages body */}
                <div className="room-messages" ref={messagesContainerRef}>
                  {loadingMessages ? (
                    <div className="messages-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>{t('chats.loadingMessages')}</span>
                    </div>
                  ) : messagesError ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.loadMessagesError')}</span>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.noMessagesInChat')}</span>
                    </div>
                  ) : (
                    <>
                      {/* B — Load older: prepend an older DB page on click. Only render while the
                          loaded slice is shorter than the DB's full row count (total). The scroll
                          anchor (handleLoadOlder + prependAnchorRef) keeps the viewport from jumping
                          when older rows are inserted above the current scroll position. */}
                      {hasOlder && (
                        <div className="load-older-control">
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={loadingOlder}
                            onClick={handleLoadOlder}
                          >
                            {loadingOlder ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <ArrowLeft size={14} />
                            )}
                            {loadingOlder ? t('chats.loadingOlder') : t('chats.loadOlder')}
                          </button>
                        </div>
                      )}
                      {messages.map(msg => {
                      const isMe = msg.direction === 'outgoing';
                      const formattedTime = formatTime(
                        msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000),
                      );

                      const isMediaMessage = msg.type !== 'text';
                      const mediaInfo = msg.metadata?.media;

                      const renderMedia = () => {
                        if (msg.type === 'revoked') return null;
                        // location/call have no downloadable media payload — render them before the
                        // mediaInfo gate. The raw body (a base64 thumbnail / empty token) is suppressed below.
                        if (msg.type === 'location') {
                          // WhatsApp location messages carry a base64 JPEG map-preview thumbnail in `body`.
                          const thumb = msg.body && msg.body.length > 100 ? `data:image/jpeg;base64,${msg.body}` : '';
                          return (
                            <div className="message-location">
                              {thumb && (
                                <img
                                  src={thumb}
                                  alt=""
                                  style={{ maxWidth: 220, borderRadius: 8, display: 'block', marginBottom: 4 }}
                                />
                              )}
                              <span className="message-media-omitted">📍 {t('chats.media.location')}</span>
                            </div>
                          );
                        }
                        if (msg.type === 'call') {
                          const call = msg.metadata?.call;
                          const callKey = call?.video
                            ? call.missed
                              ? 'callVideoMissed'
                              : 'callVideo'
                            : call?.missed
                              ? 'callMissed'
                              : 'call';
                          return (
                            <div className="message-media-omitted">
                              {`${call?.video ? '📹' : '📞'} ${t(`chats.media.${callKey}`)}`}
                            </div>
                          );
                        }
                        if (!mediaInfo) return null;
                        // D3: an omitted history-media row arrives as a placeholder. If we've already
                        // fetched its bytes (loadedMediaUrls), fall through with the blob URL as `data`
                        // so the normal image/video/audio/document branches render it. Otherwise show a
                        // click-to-load button (only when the row carries a waMessageId — history media
                        // always does; without one there's nothing to fetch, so keep the static label).
                        const loadedUrl = mediaInfo.omitted ? loadedMediaUrls[msg.id] : undefined;
                        const effectiveMedia: MessageMedia | undefined = loadedUrl
                          ? { ...mediaInfo, omitted: false, data: loadedUrl }
                          : mediaInfo;
                        if (mediaInfo.omitted && !loadedUrl) {
                          const mediaId = msg.waMessageId ?? msg.id;
                          if (!mediaId) {
                            return <div className="message-media-omitted">📎 {t('chats.media.omitted')}</div>;
                          }
                          const isLoading = mediaLoading[msg.id];
                          const failed = mediaLoadFailed[msg.id];
                          return (
                            <button
                              type="button"
                              className="btn-secondary message-media-load-btn"
                              disabled={isLoading}
                              onClick={() => handleLoadMedia(msg)}
                            >
                              {isLoading ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Paperclip size={14} />
                              )}
                              {failed ? t('chats.media.loadMediaFailed') : t('chats.media.loadMedia')}
                            </button>
                          );
                        }
                        const mediaSrc = getMediaSrc(effectiveMedia);
                        if (!mediaSrc) return null;

                        switch (msg.type) {
                          case 'image':
                          case 'sticker':
                            return (
                              <div className="message-media-image">
                                <img
                                  src={mediaSrc}
                                  alt={effectiveMedia.filename || t('chats.media.image')}
                                  className="chat-image-media"
                                  onClick={() => {
                                    const idx = imageMedia.findIndex(x => x.id === msg.id);
                                    if (idx >= 0) setLightboxIndex(idx);
                                  }}
                                />
                              </div>
                            );
                          case 'video':
                            return (
                              <div className="message-media-video">
                                <video src={mediaSrc} controls className="chat-video-media" />
                              </div>
                            );
                          case 'audio':
                          case 'voice':
                            return (
                              <div className="message-media-audio">
                                <audio src={mediaSrc} controls className="chat-audio-media" />
                              </div>
                            );
                          case 'document':
                          default:
                            return (
                              <div className="message-media-document">
                                <a
                                  href={mediaSrc}
                                  download={effectiveMedia.filename || 'document'}
                                  className="chat-document-media"
                                >
                                  📎 {effectiveMedia.filename || t('chats.downloadDocument')}
                                </a>
                              </div>
                            );
                        }
                      };

                      const reactions = msg.metadata?.reactions || {};
                      const hasReactions = Object.keys(reactions).length > 0;
                      const isRevoked = msg.type === 'revoked';
                      const isMasked = msg.type === 'masked';

                      // Resolve sender info for incoming messages. In 1:1 chats the chat header
                      // already identifies the contact, so the per-message label is most useful in
                      // groups (multiple senders, `from` is the chat JID, not the author). The label
                      // is also shown for any incoming message that the engine attached a contact
                      // record to (pushName / phone) — that gives the per-message bubble the same
                      // contact identity the chat header carries.
                      // Priority: pushName, then contact.name, then a real E.164 phone, then LID/JID
                      // fallback. Always show name · phone (or just phone/LID when no name).
                      const meta = msg.metadata;
                      const c = meta?.contact;
                      const isGroupMessage = !!meta?.isGroup;
                      const senderInfo = !isMe && (isGroupMessage || meta?.author || c)
                        ? (() => {
                            const phone = meta?.senderPhone || c?.number;
                            const rawJid = meta?.author || msg.from;
                            const rawId = rawJid?.split('@')[0] ?? '';
                            const jidSuffix = rawJid?.split('@')[1] ?? '';
                            const pushName = c?.pushName;
                            const name = c?.name;
                            const isLid = jidSuffix === 'lid';
                            const isGroupJid = jidSuffix === 'g.us';
                            // Only treat `phone` as a real phone if it differs from the raw JID user-part
                            // (otherwise the engine just handed us the LID digits as if they were a phone).
                            const realPhone = phone && phone.replace(/^\+/, '') !== rawId
                              ? (phone.startsWith('+') ? phone : `+${phone}`)
                              : null;
                            const parts: string[] = [];
                            if (pushName) parts.push(pushName);
                            if (name && name !== realPhone && name !== `+${rawId}` && name !== pushName) {
                              parts.push(name);
                            }
                            if (realPhone) {
                              parts.push(realPhone);
                            } else if (isLid) {
                              parts.push(`LID:${rawId}`);
                            } else if (!isGroupJid && rawId) {
                              parts.push(`+${rawId}`);
                            }
                            return parts.length > 0 ? parts.join(' · ') : undefined;
                          })()
                        : undefined;

                      return (
                        <div
                          key={msg.id}
                          className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'}${
                            highlightedHitId && msg.waMessageId === highlightedHitId ? ' is-search-hit' : ''
                          }`}
                          data-wa-message-id={msg.waMessageId}
                        >
                          <div className="message-bubble-container">
                            <div
                              className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
                                isMediaMessage ? 'media-type' : ''
                              } ${isRevoked ? 'revoked-type' : ''}`}
                            >
                              {/* Sender name/phone in incoming messages (mainly groups) */}
                              {senderInfo && (
                                <div className="message-sender-name">{senderInfo}</div>
                              )}
                              {/* Quoted message display */}
                              {msg.metadata?.quotedMessage && (
                                <div className="message-quote-box">
                                  <MessageBody
                                    text={msg.metadata.quotedMessage.body}
                                    className="quote-body"
                                  />
                                </div>
                              )}

                              {renderMedia()}

                              {isRevoked ? (
                                <div className="message-text">{t('chats.messageDeleted')}</div>
                              ) : isMasked ? (
                                <div className="message-text message-masked">{t('chats.messageMasked')}</div>
                              ) : (
                                msg.body &&
                                (!mediaInfo || msg.body !== mediaInfo.filename) &&
                                msg.type !== 'location' &&
                                msg.type !== 'call' && (
                                  <MessageBody text={msg.body} className="message-text" />
                                )
                              )}

                              <div className="message-meta">
                                <span className="message-time">{formattedTime}</span>
                                {isMe && (
                                  <span className={`message-status-icon ${msg.status}`}>
                                    {msg.status === 'pending' && '🕒'}
                                    {msg.status === 'sent' && '✓'}
                                    {msg.status === 'delivered' && '✓✓'}
                                    {msg.status === 'read' && '✓✓'}
                                    {msg.status === 'failed' && '⚠️'}
                                  </span>
                                )}
                              </div>

                              {/* Reactions display */}
                              {hasReactions && (
                                <div className="message-reactions-badge">
                                  {Object.values(reactions)
                                    .slice(0, 3)
                                    .map((emoji, idx) => (
                                      <span key={idx} className="reaction-emoji-span">
                                        {emoji}
                                      </span>
                                    ))}
                                  {Object.keys(reactions).length > 1 && (
                                    <span className="reactions-count-span">
                                      {Object.keys(reactions).length}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Message actions menu (hover) */}
                            {!isRevoked && (
                              <div className="message-actions-menu">
                                <button
                                  type="button"
                                  className="action-btn"
                                  onClick={() => setReplyingTo(msg)}
                                  title={t('chats.actions.reply')}
                                >
                                  <CornerUpLeft size={14} />
                                </button>

                                <div className="reaction-trigger-wrapper">
                                  <button
                                    type="button"
                                    className="action-btn reaction-btn"
                                    title={t('chats.actions.react')}
                                  >
                                    <Smile size={14} />
                                  </button>
                                  <div className="reaction-quick-popover">
                                    {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                                      <button
                                        key={emoji}
                                        type="button"
                                        onClick={() => handleReactMessage(msg, emoji)}
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {isMe && msg.status !== 'pending' && (
                                  <button
                                    type="button"
                                    className="action-btn delete-btn"
                                    onClick={() => handleDeleteMessage(msg)}
                                    title={t('chats.actions.delete')}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    </>
                  )}
                </div>

                {/* Attachment preview banner */}
                {attachment && (
                  <div className="attachment-preview-banner">
                    {previewUrl ? (
                      <img src={previewUrl} alt={attachment.filename} className="preview-thumbnail" />
                    ) : (
                      <div className="preview-file-icon">📎</div>
                    )}
                    <div className="preview-file-info">
                      <span className="preview-filename">{attachment.filename}</span>
                      <span className="preview-filesize">({(attachment.file.size / 1024).toFixed(1)} KB)</span>
                    </div>
                    <button className="btn-remove-attachment" onClick={handleRemoveAttachment}>
                      <X size={18} />
                    </button>
                  </div>
                )}

                {/* Popular emojis panel */}
                {showEmojiPicker && (
                  <div className="chats-emoji-picker">
                    <div className="emoji-grid">
                      {popularEmojis.map(emoji => (
                        <button
                          key={emoji}
                          type="button"
                          className="emoji-btn"
                          onClick={() => handleEmojiClick(emoji)}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Replying preview banner */}
                {replyingTo && (
                  <div className="replying-preview-banner">
                    <div className="replying-preview-content">
                      <div className="replying-to-title">
                        {t('chats.replyingTo', {
                          name:
                            replyingTo.direction === 'outgoing'
                              ? t('chats.you')
                              : activeChat.name || activeChat.id.split('@')[0],
                        })}
                      </div>
                      <div className="replying-to-body">
                        {replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body}
                      </div>
                    </div>
                    <button className="btn-close-reply" onClick={() => setReplyingTo(null)}>
                      <X size={18} />
                    </button>
                  </div>
                )}

                {/* Message input bar */}
                <footer className="room-input-footer">
                  <form onSubmit={handleSend} className="input-form">
                    <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />

                    <button
                      type="button"
                      onClick={triggerFileSelect}
                      disabled={!canWrite || sending}
                      className="btn-input-accessory"
                      title={t('chats.attachTitle')}
                    >
                      <Paperclip size={20} />
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      disabled={!canWrite || sending}
                      className={`btn-input-accessory ${showEmojiPicker ? 'active' : ''}`}
                      title={t('chats.emojiTitle')}
                    >
                      <Smile size={20} />
                    </button>

                    <input
                      type="text"
                      placeholder={
                        canWrite
                          ? attachment
                            ? t('chats.captionPlaceholder')
                            : t('chats.messagePlaceholder')
                          : t('chats.noPermission')
                      }
                      value={messageInput}
                      onChange={e => setMessageInput(e.target.value)}
                      disabled={!canWrite || sending}
                      className="message-text-input"
                    />
                    <button
                      type="submit"
                      disabled={!canWrite || (!messageInput.trim() && !attachment) || sending}
                      className="btn-send-message"
                      aria-label={t('chats.send')}
                    >
                      {sending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                    </button>
                  </form>
                </footer>
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <MessageSquare size={80} className="placeholder-icon" />
                <h2>{t('chats.placeholderTitle')}</h2>
                <p>{t('chats.placeholderDesc')}</p>
              </div>
            )}
          </main>
        </div>
      )}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />
    </div>
  );
}
