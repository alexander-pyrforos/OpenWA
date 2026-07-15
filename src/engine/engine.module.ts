import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { MediaDescriptor } from './adapters/media-descriptor.entity';
import { MediaDescriptorService } from './adapters/media-descriptor.service';
import { LidMapping } from './identity/lid-mapping.entity';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BaileysStoredMessage, LidMapping, MediaDescriptor], 'data')],
  providers: [EngineFactory, BaileysMessageStoreService, MediaDescriptorService, LidMappingStoreService],
  exports: [EngineFactory, LidMappingStoreService, MediaDescriptorService],
})
export class EngineModule {}
