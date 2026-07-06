import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { MeilisearchClient } from './meilisearch.client';
import { Message } from '../message/entities/message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Message], 'data')],
  controllers: [SearchController],
  providers: [SearchService, MeilisearchClient],
  exports: [SearchService],
})
export class SearchModule {}
