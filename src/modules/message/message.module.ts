import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { MessageController } from './message.controller';
import { SessionModule } from '../session/session.module';
import { TemplateModule } from '../template/template.module';
import { SearchModule } from '../search/search.module';
import { Message } from './entities/message.entity';
import { MessageBatch } from './entities/message-batch.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Message, MessageBatch], 'data'), SessionModule, TemplateModule, SearchModule],
  controllers: [MessageController],
  providers: [MessageService, BulkMessageService, MessageTypeBackfillService],
  exports: [MessageService, BulkMessageService],
})
export class MessageModule {}
