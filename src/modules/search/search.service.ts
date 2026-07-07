import { Injectable } from '@nestjs/common';
import { MeilisearchClient, MeilisearchDocument, MeilisearchSearchHit } from './meilisearch.client';
import { SearchQueryDto, SearchResultDto, SearchMessageHitDto } from './dto/search-query.dto';
import { Message } from '../message/entities/message.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';

@Injectable()
export class SearchService {
  private readonly logger = createLogger('SearchService');

  constructor(
    private readonly meilisearchClient: MeilisearchClient,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
  ) {}

  /** Whether Meilisearch is configured and connected. */
  isAvailable(): boolean {
    return this.meilisearchClient.available;
  }

  /** Convert a Message entity to a Meilisearch document. */
  private toDocument(message: Message): MeilisearchDocument {
    const metadata = message.metadata as Record<string, unknown> | null;
    const hasMedia = !!(metadata && metadata.media && typeof metadata.media === 'object');

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

  /** Execute a search query against Meilisearch. */
  async search(dto: SearchQueryDto): Promise<SearchResultDto> {
    if (!this.isAvailable()) {
      throw new Error('Meilisearch is not available');
    }

    const filters: Record<string, string | boolean> = {};
    if (dto.sessionId) filters.sessionId = dto.sessionId;
    if (dto.chatId) filters.chatId = dto.chatId;
    if (dto.from) filters.from = dto.from;
    if (dto.type) filters.type = dto.type;
    if (dto.direction) filters.direction = dto.direction;
    if (dto.hasMedia !== undefined) filters.hasMedia = dto.hasMedia;

    const result = await this.meilisearchClient.search(dto.q, filters, dto.limit ?? 20, dto.offset ?? 0);

    const hits: SearchMessageHitDto[] = result.hits.map((hit: MeilisearchSearchHit) => ({
      id: hit.id,
      sessionId: hit.sessionId,
      waMessageId: hit.waMessageId,
      chatId: hit.chatId,
      chatName: hit.chatName,
      from: hit.from,
      to: hit.to,
      body: hit.body,
      type: hit.type,
      direction: hit.direction,
      status: hit.status,
      hasMedia: hit.hasMedia,
      timestamp: hit.timestamp,
      createdAt: hit.createdAt,
      _formatted: hit._formatted ? { body: hit._formatted.body } : undefined,
    }));

    return {
      hits,
      total: result.estimatedTotalHits ?? result.hits.length,
      limit: dto.limit ?? 20,
      offset: dto.offset ?? 0,
    };
  }

  /** Reindex all messages from the database into Meilisearch. */
  async reindexAll(): Promise<{ indexed: number }> {
    if (!this.isAvailable()) {
      throw new Error('Meilisearch is not available');
    }

    // Clear existing index
    await this.meilisearchClient.deleteAllDocuments();

    // Batch-index all messages
    const batchSize = 1000;
    let offset = 0;
    let totalIndexed = 0;

    while (true) {
      const messages = await this.messageRepository.find({
        order: { createdAt: 'ASC' },
        skip: offset,
        take: batchSize,
      });

      if (messages.length === 0) break;

      const documents = messages.map(m => this.toDocument(m));
      await this.meilisearchClient.addDocuments(documents);
      totalIndexed += messages.length;
      offset += batchSize;

      if (messages.length < batchSize) break;
    }

    this.logger.log(`Reindexed ${totalIndexed} messages into Meilisearch`);
    return { indexed: totalIndexed };
  }
}
