import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';

export interface MeilisearchDocument {
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

/** A Meilisearch search hit, with the highlighted `_formatted` body when attributesToHighlight is set. */
export interface MeilisearchSearchHit {
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
  _formatted?: { body?: string } | null;
}

export interface MeilisearchSearchResponse {
  hits: MeilisearchSearchHit[];
  estimatedTotalHits?: number;
  processingTimeMs?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

const INDEX_UID = 'messages';

@Injectable()
export class MeilisearchClient implements OnModuleInit {
  private baseUrl = '';
  private apiKey: string | undefined;
  private indexUid = 'openwa_messages';
  private _available = false;
  private readonly logger = createLogger('MeilisearchClient');

  constructor(private readonly configService: ConfigService) {
    const prefix = this.configService.get<string>('meilisearch.indexPrefix', 'openwa_');
    this.indexUid = `${prefix}${INDEX_UID}`;
  }

  async onModuleInit(): Promise<void> {
    const url = this.configService.get<string>('meilisearch.url');
    if (!url) {
      this.logger.log('Meilisearch URL not configured — search disabled');
      return;
    }
    this.baseUrl = url.replace(/\/+$/, '');
    this.apiKey = this.configService.get<string>('meilisearch.apiKey');
    try {
      const health = await this.rest<{ status: string }>('/health');
      if (health.status !== 'available') throw new Error(`health status ${health.status}`);
      await this.ensureIndex();
      await this.configureIndex();
      this._available = true;
      this.logger.log(`Meilisearch connected at ${url}, index: ${this.indexUid}`);
    } catch (error) {
      this.logger.warn(
        `Meilisearch unavailable at ${url}: ${error instanceof Error ? error.message : String(error)}. Search disabled.`,
      );
      this._available = false;
    }
  }

  get available(): boolean {
    return this._available;
  }

  /** Core fetch helper — unguarded (host is trusted), so localhost works without SSRF_ALLOWED_HOSTS. */
  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Meilisearch ${init?.method ?? 'GET'} ${path} → ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  private async ensureIndex(): Promise<void> {
    try {
      await this.rest(`/indexes/${this.indexUid}`, { method: 'GET' });
    } catch {
      // Index doesn't exist — create it with `id` as the primary key.
      await this.rest('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: this.indexUid, primaryKey: 'id' }),
      });
    }
  }

  private async configureIndex(): Promise<void> {
    try {
      await this.rest(`/indexes/${this.indexUid}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          searchableAttributes: ['body'],
          filterableAttributes: ['sessionId', 'chatId', 'from', 'to', 'type', 'direction', 'status', 'hasMedia'],
          sortableAttributes: ['timestamp', 'createdAt'],
        }),
      });
    } catch (error) {
      this.logger.warn(`Failed to configure Meilisearch index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async addDocuments(documents: MeilisearchDocument[]): Promise<void> {
    if (!this._available || documents.length === 0) return;
    try {
      await this.rest(`/indexes/${this.indexUid}/documents?primaryKey=id`, {
        method: 'POST',
        body: JSON.stringify(documents),
      });
    } catch (error) {
      this.logger.warn(`Failed to add documents to Meilisearch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async addDocument(document: MeilisearchDocument): Promise<void> {
    return this.addDocuments([document]);
  }

  async deleteDocument(id: string): Promise<void> {
    if (!this._available) return;
    try {
      await this.rest(`/indexes/${this.indexUid}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      this.logger.warn(`Failed to delete document ${id} from Meilisearch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async search(
    query: string,
    filters: Record<string, string | boolean>,
    limit: number,
    offset: number,
  ): Promise<MeilisearchSearchResponse> {
    if (!this._available) throw new Error('Meilisearch is not available');

    const filterExpressions: string[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      filterExpressions.push(typeof value === 'boolean' ? `${key} = ${value}` : `${key} = "${value}"`);
    }

    return this.rest<MeilisearchSearchResponse>(`/indexes/${this.indexUid}/search`, {
      method: 'POST',
      body: JSON.stringify({
        q: query,
        filter: filterExpressions.length > 0 ? filterExpressions : undefined,
        limit,
        offset,
        attributesToHighlight: ['body'],
        highlightPreTag: '<mark>',
        highlightPostTag: '</mark>',
        sort: ['createdAt:desc'],
      }),
    });
  }

  async deleteAllDocuments(): Promise<void> {
    if (!this._available) return;
    try {
      await this.rest(`/indexes/${this.indexUid}/documents`, { method: 'DELETE' });
    } catch (error) {
      this.logger.warn(`Failed to delete all documents from Meilisearch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}