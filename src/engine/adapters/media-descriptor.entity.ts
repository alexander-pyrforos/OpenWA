import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';

/**
 * Persisted downloadable copy of a media-bearing history-sync WAMessage. Unlike
 * `baileys_stored_messages`, this store is NON-evicting: the 5000/session FIFO cap on the live
 * message store would discard the oldest descriptors exactly when old media matters most, so a
 * dedicated table keeps them indefinitely for on-demand download.
 *
 * Stores the FULL serialized WAMessage (via Baileys `BufferJSON.replacer`, exactly like
 * `baileys-message-store.service.ts`). History-sync WAMessages carry the media download metadata
 * (`mediaKey`, `directPath`/`url`, `mediaKeyTimestamp`, `encSha256`, `fileSha256`, `fileLength`,
 * `mimetype`, plus a small `jpegThumbnail`) inside their `imageMessage`/`videoMessage`/… sub-objects
 * — the same shape `downloadMediaMessage(msg, 'stream', …)` consumes for live messages, so a
 * `BufferJSON.reviver`-parsed row is directly downloadable.
 *
 * No `(sessionId, createdAt)` index: there is no eviction ordering, so it is omitted intentionally
 * (smaller write footprint; lookups are by `(sessionId, waMessageId)` only).
 *
 * The `session` relation declares the CASCADE FK so both the `synchronize:true` SQLite path and the
 * migration path clean up descriptors when the parent session row is deleted.
 */
@Entity('message_media_descriptors')
@Index(['sessionId', 'waMessageId'], { unique: true }) // lookup + dedup
export class MediaDescriptor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session;

  @Column()
  waMessageId: string;

  @Column({ type: 'text' })
  serializedMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
