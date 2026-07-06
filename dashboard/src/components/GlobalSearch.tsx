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
  CornerUpLeft,
} from 'lucide-react';
import { searchApi, type SearchHit } from '../services/api';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  text: <FileText size={14} />,
  image: <Image size={14} />,
  video: <Video size={14} />,
  audio: <Music size={14} />,
  voice: <Phone size={14} />,
  document: <File size={14} />,
  sticker: <StickyNote size={14} />,
  location: <MapPin size={14} />,
};

const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll'];

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

  const highlightBody = (hit: SearchHit) => {
    const body = hit._formatted?.body || hit.body || '';
    return <span dangerouslySetInnerHTML={{ __html: body }} />;
  };

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
      <div className="global-search-input">
        <Search size={16} />
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
          <Filter size={14} />
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

      <div className="global-search-results" role="list">
        {loading && (
          <div className="global-search-loading">
            <Loader2 className="animate-spin" size={20} />
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
              <div className="global-search-result-icon">
                {TYPE_ICONS[hit.type] || <FileText size={14} />}
              </div>
              <div className="global-search-result-content">
                <div className="global-search-result-body">{highlightBody(hit)}</div>
                <div className="global-search-result-meta">
                  <span className="global-search-result-chat">{hit.chatName || hit.chatId}</span>
                  <span className="global-search-result-time">
                    {hit.timestamp ? formatRelativeTime(hit.createdAt) : ''}
                  </span>
                  <span className={`global-search-result-direction ${hit.direction}`}>
                    {hit.direction === 'incoming' ? '←' : '→'}
                  </span>
                </div>
              </div>
              <CornerUpLeft size={14} className="global-search-result-open" />
            </button>
          ))}
        {!loading && total > results.length && (
          <div className="global-search-more">{t('chats.search.moreResults', `+${total - results.length} more results`)}</div>
        )}
      </div>
    </div>
  );
}