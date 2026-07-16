import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  X,
  Loader2,
  Filter,
  FileText,
  Image,
  Video,
  Music,
  File,
  MapPin,
  StickyNote,
  Phone,
} from 'lucide-react';
import { searchApi, sessionApi, type SearchHit } from '../services/api';
import { escapeHtml, highlightQueryTerm, highlightMatchLine } from './search-highlight';
import { useCurrentEngineQuery } from '../hooks/queries';
import './GlobalSearch.css';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  text: <FileText size={18} />,
  image: <Image size={18} />,
  video: <Video size={18} />,
  audio: <Music size={18} />,
  voice: <Phone size={18} />,
  document: <File size={18} />,
  sticker: <StickyNote size={18} />,
  location: <MapPin size={18} />,
};

const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll'];

// Types that have a visual preview we can lazy-load. Audio/voice/document fall back to a styled tile
// (no frame to render); image/sticker become <img>, video becomes a <video> first-frame preview.
const PREVIEWABLE_TYPES = new Set(['image', 'video', 'sticker']);

// Module-level cache: one history-with-media fetch per (session, chat), shared across result lists
// and remounts. Keyed `${sessionId}::${chatId}` → promise of (waMessageId → dataURL).
const thumbnailCache = new Map<string, Promise<Map<string, string>>>();

// Module-level semaphore: caps concurrent distinct-chat history-with-media fetches at 3 globally,
// shared across all hook instances so a broad search can't saturate the client's bandwidth.
const MAX_CONCURRENT_CHAT_FETCHES = 3;
let inFlight = 0;
const pending: Array<() => void> = [];

function scheduleChatFetch(fn: () => Promise<void>): void {
  const run = () => {
    inFlight++;
    fn().finally(() => {
      inFlight--;
      const next = pending.shift();
      if (next) next();
    });
  };
  if (inFlight < MAX_CONCURRENT_CHAT_FETCHES) run();
  else pending.push(run);
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

/**
 * Lazy-load real image/video/sticker thumbnails for a set of search hits. Instead of fetching every
 * distinct chat's history-with-media up front, a row's chat is fetched only when that row scrolls
 * into view (IntersectionObserver, 200px rootMargin). A module-level semaphore caps concurrent
 * distinct-chat fetches at 3 globally. Each chat fetches at most once — cached per (session, chat)
 * so multiple hits in the same chat share one fetch — and matches by waMessageId. Falls back to a
 * styled tile when the message isn't in the recent history window or the fetch fails.
 */
function useSearchThumbnails(results: SearchHit[]): {
  thumbs: Record<string, string>;
  observe: (id: string) => (el: HTMLElement | null) => void;
} {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Baileys has no on-demand history endpoint (returns 501); skip the per-chat history-with-media
  // fetch entirely so we don't pepper the network tab with 501s for every visible search hit.
  const { data: currentEngine } = useCurrentEngineQuery();
  const engineSupportsHistory = currentEngine?.engineType !== 'baileys';

  // Group previewable media hits by chat so each chat fetches at most once.
  const groups = useMemo(() => {
    if (!engineSupportsHistory) return new Map();
    const m = new Map<string, { sessionId: string; chatId: string; hits: SearchHit[] }>();
    for (const hit of results) {
      if (!hit.hasMedia || !PREVIEWABLE_TYPES.has(hit.type)) continue;
      const key = `${hit.sessionId}::${hit.chatId}`;
      if (!m.has(key)) m.set(key, { sessionId: hit.sessionId, chatId: hit.chatId, hits: [] });
      m.get(key)!.hits.push(hit);
    }
    return m;
  }, [results, engineSupportsHistory]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.hitId;
          if (!id) continue;
          const hit = results.find(h => h.id === id);
          if (!hit) continue;
          const key = `${hit.sessionId}::${hit.chatId}`;
          const group = groups.get(key);
          if (!group) continue;
          scheduleChatFetch(async () => {
            let promise = thumbnailCache.get(key);
            if (!promise) {
              promise = sessionApi
                .getChatHistory(group.sessionId, group.chatId, 50, true)
                .then(history => {
                  const map = new Map<string, string>();
                  for (const m of history) {
                    const media = m.media;
                    if (media?.data) {
                      const dataUrl = media.data.startsWith('data:')
                        ? media.data
                        : `data:${media.mimetype};base64,${media.data}`;
                      // Engine history `id` is the WA message id — matches SearchHit.waMessageId.
                      map.set(m.id, dataUrl);
                    }
                  }
                  return map;
                })
                .catch(() => new Map<string, string>());
              thumbnailCache.set(key, promise);
            }
            const map = await promise;
            setThumbs(prev => {
              const next = { ...prev };
              for (const h of group.hits) {
                const url = map.get(h.waMessageId ?? h.id);
                if (url) next[h.id] = url;
              }
              return next;
            });
          });
          io.unobserve(e.target); // fetch once per row
        }
      },
      { rootMargin: '200px' },
    );
    observerRef.current = io;
    return () => io.disconnect();
  }, [results, groups]);

  const observe = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) {
        el.dataset.hitId = id;
        observerRef.current?.observe(el);
      }
    },
    [],
  );

  return { thumbs, observe };
}

/**
 * Build the body snippet: the line containing the match (highlighted) plus up to 2 lines of context
 * above and 2 below, with ellipses where lines are clipped.
 *
 * The matched line is located robustly — first by a Meilisearch `<mark>` in `_formatted.body`, then
 * by the query term appearing verbatim in the raw body (case-insensitive). This way the snippet
 * centers on the actual match even when Meilisearch's formatted highlighting is absent, and the
 * matched term is always wrapped in `<mark>` (we add it ourselves when Meilisearch didn't). Only a
 * line that truly contains the match gets the `is-match` highlight — never a misleading fallback.
 */
function renderSnippet(hit: SearchHit, query: string): React.ReactNode {
  // Priority: _formatted.body (Meilisearch) > snippet (built-in FTS <mark>-highlighted) > raw body.
  // Both _formatted.body and snippet carry <mark> tags and are safe to render; the raw body fallback
  // is escaped + highlighted inline.
  const formattedBody = hit._formatted?.body || '';
  const snippet = hit.snippet || '';
  const rawBody = hit.body || '';
  const source = formattedBody || snippet || rawBody;
  if (!source.trim()) return null;

  const lines = source.split(/\r?\n/);
  const q = query.trim().toLowerCase();
  // True when the source already carries <mark> tags (Meilisearch _formatted or built-in FTS snippet).
  const hasFormatted = !!(formattedBody || snippet);

  let matchIdx = lines.findIndex(l => l.includes('<mark>'));
  if (matchIdx === -1 && q) {
    matchIdx = lines.findIndex(l => l.toLowerCase().includes(q));
  }
  const hasRealMatch = matchIdx !== -1;
  if (matchIdx === -1) matchIdx = 0;

  const start = Math.max(0, matchIdx - 2);
  const end = Math.min(lines.length - 1, matchIdx + 2);
  const window = lines.slice(start, end + 1);
  const hasBefore = start > 0;
  const hasAfter = end < lines.length - 1;

  return (
    <div className="global-search-snippet">
      {hasBefore && <div className="global-search-snippet-ellipsis" aria-hidden="true">…</div>}
      {window.map((line, i) => {
        const lineIdx = start + i;
        const isMatchLine = hasRealMatch && lineIdx === matchIdx;
        let html: string;
        if (hasFormatted) {
          // Meilisearch already escaped the body; if its <mark> is missing on the match line, add ours.
          html = isMatchLine && !line.includes('<mark>') ? highlightQueryTerm(line, query) : line;
        } else {
          // Raw body — escape, then highlight the match line (XSS guard lives in highlightMatchLine).
          html = isMatchLine ? highlightMatchLine(line, query, { alreadyFormatted: false }) : escapeHtml(line);
        }
        return (
          <div
            key={lineIdx}
            className={`global-search-snippet-line${isMatchLine ? ' is-match' : ''}`}
            dangerouslySetInnerHTML={{ __html: html || ' ' }}
          />
        );
      })}
      {hasAfter && <div className="global-search-snippet-ellipsis" aria-hidden="true">…</div>}
    </div>
  );
}

function ThumbCell({ hit, thumbs }: { hit: SearchHit; thumbs: Record<string, string> }) {
  const url = thumbs[hit.id];

  if (url) {
    if (hit.type === 'video') {
      return (
        <div className={`global-search-thumb global-search-thumb--${hit.type}`}>
          <video src={url} muted preload="metadata" playsInline />
          <span className="global-search-thumb-play" aria-hidden="true">▶</span>
        </div>
      );
    }
    return (
      <div className={`global-search-thumb global-search-thumb--${hit.type}`}>
        <img src={url} alt={hit.body || ''} loading="lazy" />
      </div>
    );
  }

  // Fallback / non-previewable: a styled tile with the type icon. Same box so the layout is stable
  // while a real thumbnail loads and for media types we can't preview (audio/voice/document).
  return (
    <div className={`global-search-thumb global-search-thumb--${hit.type} is-placeholder`}>
      {TYPE_ICONS[hit.type] || <FileText size={18} />}
    </div>
  );
}

interface GlobalSearchProps {
  sessionId?: string;
  /** Called when a result is activated (click or Enter). The parent owns chat-switch + scroll-into-view. */
  onResultClick?: (hit: SearchHit) => void;
}

export function GlobalSearch({ sessionId, onResultClick }: GlobalSearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [hasMediaFilter, setHasMediaFilter] = useState<boolean | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { thumbs, observe } = useSearchThumbnails(results);

  const doSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      setTotal(0);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await searchApi.search({
        q: query.trim(),
        sessionId,
        type: typeFilter || undefined,
        direction: directionFilter || undefined,
        hasMedia: hasMediaFilter,
        limit: 20,
        offset: 0,
      });
      setResults(result.hits);
      setTotal(result.total);
      setSearchUnavailable(false);
    } catch (err: unknown) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 501) {
        setSearchUnavailable(true);
      } else {
        setError(err instanceof Error ? err.message : t('chats.search.errors.searchFailed', 'Search failed'));
      }
      setResults([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [query, sessionId, typeFilter, directionFilter, hasMediaFilter, t]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doSearch();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [doSearch]);

  if (searchUnavailable) {
    return (
      <div className="global-search">
        <div className="global-search-unavailable">
          <Search size={20} />
          <p>{t('chats.search.unavailable', 'Search unavailable. Configure Meilisearch for global search.')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="global-search">
      <div className="global-search-top">
        <div className="global-search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('chats.search.placeholder', 'Search messages...')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="global-search-clear"
              onClick={() => {
                setQuery('');
                setResults([]);
                setTotal(0);
              }}
              aria-label={t('chats.search.clear', 'Clear search')}
            >
              <X size={14} />
            </button>
          )}
          <button
            className={`global-search-filter-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
            title={t('chats.search.filters.title', 'Filters')}
            aria-label={t('chats.search.filters.title', 'Filters')}
            aria-expanded={showFilters}
          >
            <Filter size={16} />
          </button>
        </div>

        {showFilters && (
          <div className="global-search-filters">
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              aria-label={t('chats.search.filters.type', 'Type')}
            >
              <option value="">{t('chats.search.filters.all', 'All types')}</option>
              {MESSAGE_TYPES.map(type => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              value={directionFilter}
              onChange={e => setDirectionFilter(e.target.value)}
              aria-label={t('chats.search.filters.direction', 'Direction')}
            >
              <option value="">{t('chats.search.filters.all', 'All')}</option>
              <option value="incoming">{t('chats.search.results.incoming', 'Incoming')}</option>
              <option value="outgoing">{t('chats.search.results.outgoing', 'Outgoing')}</option>
            </select>
            <label className="global-search-media-filter">
              <input
                type="checkbox"
                checked={hasMediaFilter === true}
                onChange={e => setHasMediaFilter(e.target.checked ? true : undefined)}
              />
              {t('chats.search.filters.hasMedia', 'Has media')}
            </label>
          </div>
        )}
      </div>

      <div className="global-search-results" role="list">
        {loading && (
          <div className="global-search-loading">
            <Loader2 className="animate-spin" size={24} />
          </div>
        )}
        {error && <div className="global-search-error">{error}</div>}
        {!loading && query && results.length === 0 && !error && (
          <div className="global-search-no-results">{t('chats.search.noResults', 'No messages found')}</div>
        )}
        {!loading &&
          results.map(hit => (
            <button
              key={hit.id}
              ref={observe(hit.id)}
              type="button"
              className="global-search-result"
              role="listitem"
              onClick={() => onResultClick?.(hit)}
              title={t('chats.search.openInChat', 'Open in chat')}
            >
              <ThumbCell hit={hit} thumbs={thumbs} />
              <div className="global-search-result-content">
                <div className="global-search-result-meta">
                  <span className="global-search-result-chat">{hit.chatName || hit.chatId.split('@')[0]}</span>
                  <span className={`global-search-result-direction ${hit.direction}`} aria-hidden="true">
                    {hit.direction === 'incoming' ? '←' : '→'}
                  </span>
                  <span className="global-search-result-time">
                    {hit.timestamp ? formatRelativeTime(hit.createdAt) : ''}
                  </span>
                </div>
                {renderSnippet(hit, query)}
              </div>
            </button>
          ))}
        {!loading && total > results.length && (
          <div className="global-search-more">{t('chats.search.moreResults', `+${total - results.length} more results`)}</div>
        )}
      </div>
    </div>
  );
}