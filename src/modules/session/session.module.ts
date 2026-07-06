import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';
import { SearchModule } from '../search/search.module';

@Module({
  // WebhookModule does not import SessionModule back, so the dependency is one-directional —
  // no forwardRef() needed. SearchModule is one-directional too (it does not import SessionModule);
  // imported here so SessionService can sync incoming messages to Meilisearch.
  imports: [TypeOrmModule.forFeature([Session, Message], 'data'), WebhookModule, SearchModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
