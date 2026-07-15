import type { WAMessage } from '@whiskeysockets/baileys';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * Persistence boundary for the Baileys engine's message store. The adapter depends on this narrow
 * interface (not the concrete Nest service) so it stays unit-testable with a fake.
 */
export interface BaileysMessageStore {
  /** Persist a message (idempotent on the same id) so it can be referenced by reply/forward/react/delete. */
  put(sessionId: string, msg: WAMessage): Promise<void>;
  /** Look up a previously-seen message by its id, or null. */
  getMessage(sessionId: string, messageId: string): Promise<WAMessage | null>;
  /** Remove all stored messages for a session (called on logout). */
  clearSession(sessionId: string): Promise<void>;
}

/**
 * Persistence boundary for the non-evicting media-descriptor store (D1). Holds the FULL serialized
 * WAMessage for media-bearing history-sync messages so `downloadMediaMessage` can fetch the media
 * on demand. Narrow interface (not the concrete Nest service) so the adapter stays unit-testable.
 */
export interface MediaDescriptorStore {
  /** Persist (idempotent on the same id) the downloadable copy of a media-bearing history message. */
  put(sessionId: string, waMessageId: string, msg: WAMessage): Promise<void>;
  /** Look up a previously-stored downloadable copy by id, or null. */
  getMessage(sessionId: string, waMessageId: string): Promise<WAMessage | null>;
}

/**
 * Per-call construction config for {@link BaileysAdapter}. Engine-neutral fields come from the
 * factory; `authDir` is the base multi-file auth directory from the opaque `engine.baileys.*` blob
 * (the adapter appends the session id to isolate each session).
 */
export interface BaileysAdapterConfig {
  /** Session NAME — keys the on-disk auth directory and LID-mapping provenance. */
  sessionId: string;
  /** Session UUID (Session.id) — keys the FK-bound baileys_stored_messages rows via messageStore. */
  dbSessionId: string;
  authDir: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
  /** Persisted store for reply/forward/react/delete. Provided by the plugin; the four ops require it. */
  messageStore?: BaileysMessageStore;
  /** Persisted, cross-session lid->phone resolution table. Backs lid resolution beyond the in-memory map. */
  lidMappingStore?: LidMappingStore;
  /** Non-evicting store of media-bearing history-sync messages; backs on-demand history media download. */
  mediaDescriptorStore?: MediaDescriptorStore;
}

/**
 * The minimal pino-compatible logger Baileys' `makeWASocket` expects. Declared locally so we can
 * pass a fully silent logger without taking a direct `pino` dependency.
 *
 * Matches the Baileys `ILogger` contract: each log method receives `(obj: unknown, msg?: string)`.
 */
export interface BaileysLogger {
  level: string;
  child: (bindings: Record<string, unknown>) => BaileysLogger;
  trace: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}
