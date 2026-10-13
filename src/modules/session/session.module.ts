import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
  // WebhookModule does not import SessionModule back, so the dependency is one-directional —
  // no forwardRef() needed. StorageModule is one-directional too: StorageService knows nothing
  // about sessions; SessionService only consumes it for the inbound-media offload.
  imports: [TypeOrmModule.forFeature([Session, Message], 'data'), WebhookModule, StorageModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
