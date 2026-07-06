import { useState, useEffect, useCallback, useRef } from 'react';
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
 * Lazy-load real image/video/sticker thumbnails for a set of search hits. Fetches each hit's chat
 * history WITH media (base64) once — cached per (session, chat) so multiple hits in the same chat
 * share one fetch — and matches by waMessageId. Falls back to a styled tile when the message isn't
 * in the recent history window or the fetch fails. Heavy per distinct chat, so only invoked for
 * previewable media types.
 */
function useSearchThumbnails(results: SearchHit[]): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    // Group previewable media hits by chat so each chat fetches at most once.
    const groups = new Map<string, { sessionId: string; chatId: string; hits: SearchHit[] }>();
    for (const hit of results) {
      if (!hit.hasMedia || !PREVIEWABLE_TYPES.has(hit.type)) continue;
      const key = `${hit.sessionId}::${hit.chatId}`;
      if (!groups.has(key)) groups.set(key, { sessionId: hit.sessionId, chatId: hit.chatId, hits: [] });
      groups.get(key)!.hits.push(hit);
    }
    if (groups.size === 0) return;

    for (const { sessionId, chatId, hits } of groups.values()) {
      const cacheKey = `${sessionId}::${chatId}`;
      let promise = thumbnailCache.get(cacheKey);
      if (!promise) {
        promise = sessionApi
          .getChatHistory(sessionId, chatId, 50, true)
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
        thumbnailCache.set(cacheKey, promise);
      }
      void promise.then(map => {
        if (cancelled) return;
        setThumbs(prev => {
          const next = { ...prev };
          for (const hit of hits) {
            const url = map.get(hit.waMessageId ?? hit.id);
            if (url) next[hit.id] = url;
          }
          return next;
        });
      });
    }

    return () => {
      cancelled = true;
    };
  }, [results]);

  return thumbs;
}

/** Escape HTML special characters in a raw string so it's safe to inject. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap occurrences of `query` (case-insensitive) in <mark> within an already-HTML-escaped string. */
function highlightQueryTerm(escaped: string, query: string): string {
  const q = query.trim();
  if (!q) return escaped;
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
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
  const formattedBody = hit._formatted?.body || '';
  const rawBody = hit.body || '';
  // Prefer the formatted body (carries Meilisearch's <mark> and is already HTML-escaped); fall back
  // to the raw body, which we escape ourselves below.
  const source = formattedBody || rawBody;
  if (!source.trim()) return null;

  const lines = source.split(/\r?\n/);
  const q = query.trim().toLowerCase();
  const hasFormatted = !!formattedBody;

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
          // Raw body — escape, then highlight the match line.
          html = isMatchLine ? highlightQueryTerm(escapeHtml(line), query) : escapeHtml(line);
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

  const thumbs = useSearchThumbnails(results);

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