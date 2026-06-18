import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BaileysStoredMessage], 'data')],
  providers: [EngineFactory, BaileysMessageStoreService],
  exports: [EngineFactory],
})
export class EngineModule {}
