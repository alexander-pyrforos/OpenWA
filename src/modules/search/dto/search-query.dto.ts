import { IsString, IsOptional, IsBoolean, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchQueryDto {
  @ApiProperty({ description: 'Search query text', example: 'hello world' })
  @IsString()
  q: string;

  @ApiPropertyOptional({ description: 'Filter by session ID' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Filter by chat ID' })
  @IsOptional()
  @IsString()
  chatId?: string;

  @ApiPropertyOptional({ description: 'Filter by sender' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
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
  @IsOptional()
  @IsString()
  @IsIn([
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
  ])
  type?: string;

  @ApiPropertyOptional({ description: 'Filter by direction', enum: ['incoming', 'outgoing'] })
  @IsOptional()
  @IsString()
  @IsIn(['incoming', 'outgoing'])
  direction?: string;

  @ApiPropertyOptional({ description: 'Filter: only messages with media' })
  @IsOptional()
  @IsBoolean()
  hasMedia?: boolean;

  @ApiPropertyOptional({ description: 'Results per page (max 100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Pagination offset', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class SearchResultDto {
  @ApiProperty()
  hits: SearchMessageHitDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  offset: number;
}

export class SearchMessageHitDto {
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

  /** Meilisearch-formatted fields with <mark> highlighting */
  _formatted?: {
    body?: string;
  };
}
