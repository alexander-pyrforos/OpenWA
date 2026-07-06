import { Controller, Get, Post, Query, HttpCode, HttpStatus, NotImplementedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto, SearchResultDto } from './dto/search-query.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('search')
@Controller('messages/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search messages across all sessions' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query text' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Filter by session ID' })
  @ApiQuery({ name: 'chatId', required: false, description: 'Filter by chat ID' })
  @ApiQuery({ name: 'from', required: false, description: 'Filter by sender' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Filter by message type',
    enum: [
      'text',
      'image',
      'video',
      'audio',
      'voice',
      'document',
      'sticker',
      'location',
      'contact',
      'poll',
      'call',
      'revoked',
      'forward',
      'unknown',
    ],
  })
  @ApiQuery({ name: 'direction', required: false, description: 'Filter by direction', enum: ['incoming', 'outgoing'] })
  @ApiQuery({ name: 'hasMedia', required: false, description: 'Filter: only messages with media', type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Results per page (max 100, default 20)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Pagination offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Search results' })
  @ApiResponse({ status: 400, description: 'Invalid query parameters' })
  @ApiResponse({ status: 501, description: 'Meilisearch not configured' })
  async search(@Query() dto: SearchQueryDto): Promise<SearchResultDto> {
    if (!this.searchService.isAvailable()) {
      throw new NotImplementedException('Search is not available. Configure MEILISEARCH_URL to enable global search.');
    }

    return this.searchService.search(dto);
  }

  @Post('reindex')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reindex all messages into Meilisearch (admin only)' })
  @ApiResponse({ status: 200, description: 'Reindex completed' })
  @ApiResponse({ status: 403, description: 'Key role below ADMIN' })
  @ApiResponse({ status: 501, description: 'Meilisearch not configured' })
  async reindex(): Promise<{ indexed: number }> {
    if (!this.searchService.isAvailable()) {
      throw new NotImplementedException('Search is not available. Configure MEILISEARCH_URL to enable global search.');
    }

    return this.searchService.reindexAll();
  }
}
