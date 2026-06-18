import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Persisted Baileys message store (the lib ships none). Holds the serialized WAMessage proto
 * (via BufferJSON) so reply/forward/react/delete can resolve the original message/key by id across
 * restarts. Engine-specific — lives in the engine layer, not the neutral `messages` table.
 */
@Entity('baileys_stored_messages')
@Index(['sessionId', 'waMessageId'], { unique: true }) // lookup + dedup (send-return vs upsert echo)
@Index(['sessionId', 'createdAt']) // eviction ordering
export class BaileysStoredMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @Column()
  waMessageId: string;

  @Column({ type: 'text' })
  serializedMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
