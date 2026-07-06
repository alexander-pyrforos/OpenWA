import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Meilisearch } from 'meilisearch';
import type { Index, SearchResponse } from 'meilisearch';
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

const INDEX_UID = 'messages';

@Injectable()
export class MeilisearchClient implements OnModuleInit {
  private client: Meilisearch | null = null;
  private index: Index<MeilisearchDocument> | null = null;
  private _available = false;
  private readonly logger = createLogger('MeilisearchClient');
  private readonly indexPrefix: string;

  constructor(private readonly configService: ConfigService) {
    this.indexPrefix = configService.get<string>('meilisearch.indexPrefix', 'openwa_');
  }

  async onModuleInit(): Promise<void> {
    const url = this.configService.get<string>('meilisearch.url');
    if (!url) {
      this.logger.log('Meilisearch URL not configured — search disabled');
      return;
    }

    try {
      const apiKey = this.configService.get<string>('meilisearch.apiKey');
      this.client = new Meilisearch({ host: url, apiKey });
      // Health check
      await this.client.health();
      // Get or create the index
      this.index = this.client.index<MeilisearchDocument>(this.indexPrefix + INDEX_UID);
      // Configure index settings
      await this.configureIndex();
      this._available = true;
      this.logger.log(`Meilisearch connected at ${url}, index: ${this.indexPrefix}${INDEX_UID}`);
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

  private async configureIndex(): Promise<void> {
    if (!this.index) return;
    try {
      await this.index.updateSearchableAttributes(['body']);
      await this.index.updateFilterableAttributes([
        'sessionId',
        'chatId',
        'from',
        'to',
        'type',
        'direction',
        'status',
        'hasMedia',
      ]);
      await this.index.updateSortableAttributes(['timestamp', 'createdAt']);
    } catch (error) {
      this.logger.warn(
        `Failed to configure Meilisearch index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async addDocuments(documents: MeilisearchDocument[]): Promise<void> {
    if (!this.index || !this._available) return;
    try {
      await this.index.addDocuments(documents, { primaryKey: 'id' });
    } catch (error) {
      this.logger.warn(
        `Failed to add documents to Meilisearch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async addDocument(document: MeilisearchDocument): Promise<void> {
    return this.addDocuments([document]);
  }

  async deleteDocument(id: string): Promise<void> {
    if (!this.index || !this._available) return;
    try {
      await this.index.deleteDocument(id);
    } catch (error) {
      this.logger.warn(
        `Failed to delete document ${id} from Meilisearch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async search(
    query: string,
    filters: Record<string, string | boolean>,
    limit: number,
    offset: number,
  ): Promise<SearchResponse<MeilisearchDocument>> {
    if (!this.index || !this._available) {
      throw new Error('Meilisearch is not available');
    }

    // Build Meilisearch filter expressions
    const filterExpressions: string[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') {
        filterExpressions.push(`${key} = ${value}`);
      } else {
        filterExpressions.push(`${key} = "${value}"`);
      }
    }

    return this.index.search(query, {
      filter: filterExpressions.length > 0 ? filterExpressions : undefined,
      limit,
      offset,
      attributesToHighlight: ['body'],
      sort: ['createdAt:desc'],
    });
  }

  async deleteAllDocuments(): Promise<void> {
    if (!this.index || !this._available) return;
    try {
      await this.index.deleteAllDocuments();
    } catch (error) {
      this.logger.warn(
        `Failed to delete all documents from Meilisearch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
