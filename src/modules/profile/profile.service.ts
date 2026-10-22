import { BadRequestException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

/** Contract response of `GET /api/profile/:phone` (ERP phone validation + avatar). */
export interface ProfileLookupResult {
  chatId: string | null;
  exists: boolean | null;
  name: string | null;
  profilePic: string | null;
}

/**
 * Session-less WhatsApp profile lookup (`GET /api/profile/:phone`). Unlike the contact routes there
 * is no `:sessionId` in the path — this bridge serves a single-account deployment, so the lookup
 * picks any READY session with a live engine (scoped to the API key's `allowedSessions`, mirroring
 * `MessageService.getMessageByWaMessageId`: the guard has no param to scope against, so the service
 * enforces the fence).
 *
 * Contract notes (agreed with the ERP side):
 * - "session not ready" maps to **503**, never 400/409 — the ERP treats both as "bridge
 *   unreachable, write nothing", distinct from a bad phone (400) or a real verdict.
 * - An unregistered number is a normal verdict: HTTP 200 with `exists:false`, NOT a 404.
 * - A hung engine call (dead-but-ready socket) must not pin the request: the number lookup is
 *   bounded by `lookupTimeoutMs` and degrades to the same 503 the ERP already understands.
 * - Name/avatar are best-effort extras AFTER existence is confirmed (no junk calls to WA),
 *   each individually fault-tolerant so a missing avatar never fails the verdict.
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  /** Digits only, 8–15 (E.164 max). A leading '+' or any non-digit is a caller bug → 400. */
  private static readonly PHONE_PATTERN = /^\d{8,15}$/;
  /** Overall bound on the WA round-trips; the ERP caller gives up at 15s. */
  private static readonly DEFAULT_LOOKUP_TIMEOUT_MS = 25_000;
  /**
   * Avatar fetch bound: tighter than loadRemoteMediaBuffer's 30s media default so the full
   * response fits inside the ERP's 15s wait; capped at 5 MiB (avatars are tens of KB).
   */
  private static readonly AVATAR_FETCH = { timeoutMs: 12_000, maxBytes: 5 * 1024 * 1024 };

  constructor(
    private readonly sessionService: SessionService,
    // Test seam only: the module never registers a provider for it, so the DI default ({}) applies.
    @Optional() private readonly opts: { lookupTimeoutMs?: number } = {},
  ) {}

  async lookupByPhone(phone: string, allowedSessions?: string[] | null): Promise<ProfileLookupResult> {
    if (!ProfileService.PHONE_PATTERN.test(phone)) {
      throw new BadRequestException({
        chatId: null,
        exists: null,
        name: null,
        profilePic: null,
        error: 'invalid phone',
      });
    }

    const engine = await this.pickReadyEngine(allowedSessions ?? undefined);
    if (!engine) {
      throw ProfileService.sessionNotReady();
    }

    let chatId: string | null;
    try {
      chatId = await this.withLookupTimeout(engine.getNumberId(phone));
    } catch (error) {
      // EngineNotReadyError (mid-lookup drop) or the bound firing on a hung socket: both mean
      // "the bridge session is unusable right now", which the ERP contract wants as 503.
      if (error instanceof EngineNotReadyError || error instanceof ProfileLookupTimeoutError) {
        throw ProfileService.sessionNotReady();
      }
      throw error;
    }

    if (!chatId) {
      return { chatId: `${phone}@c.us`, exists: false, name: null, profilePic: null };
    }

    const [name, profilePic] = await Promise.all([
      this.resolveName(engine, chatId),
      this.resolveAvatar(engine, chatId),
    ]);
    return { chatId, exists: true, name, profilePic };
  }

  /**
   * First READY session (visible to the key) with a live engine in memory. A READY status without
   * an engine is the wedged state the staleness watchdog recovers — skip it and keep looking.
   */
  private async pickReadyEngine(allowedSessions?: string[]): Promise<IWhatsAppEngine | null> {
    const sessions = await this.sessionService.findAll(allowedSessions);
    for (const session of sessions) {
      if (session.status !== SessionStatus.READY) {
        continue;
      }
      const engine = this.sessionService.getEngine(session.id);
      if (engine) {
        return engine;
      }
    }
    return null;
  }

  /** Pushname first (the contact's own WhatsApp profile name), phonebook name as fallback. */
  private async resolveName(engine: IWhatsAppEngine, chatId: string): Promise<string | null> {
    try {
      const contact = await engine.getContactById(chatId);
      return contact?.pushName ?? contact?.name ?? null;
    } catch (error) {
      this.logger.warn(`Name lookup failed for ${chatId}: ${String(error)}`);
      return null;
    }
  }

  /** Full `data:` URL (the ERP decodes it itself); null on no photo, no URL, or any fetch error. */
  private async resolveAvatar(engine: IWhatsAppEngine, chatId: string): Promise<string | null> {
    try {
      const url = await engine.getProfilePicture(chatId);
      if (!url) {
        return null;
      }
      const { data, mimetype } = await loadRemoteMediaBuffer(url, ProfileService.AVATAR_FETCH);
      return `data:${mimetype || 'image/jpeg'};base64,${data.toString('base64')}`;
    } catch (error) {
      this.logger.warn(`Avatar lookup failed for ${chatId}: ${String(error)}`);
      return null;
    }
  }

  private withLookupTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = this.opts.lookupTimeoutMs ?? ProfileService.DEFAULT_LOOKUP_TIMEOUT_MS;
    // The rejection handler is attached immediately, so an abandoned loser promise (a hung engine
    // call that eventually settles) can never surface as an unhandled rejection.
    return Promise.race([
      promise.catch(error => {
        throw error;
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new ProfileLookupTimeoutError()), ms).unref()),
    ]);
  }

  private static sessionNotReady(): ServiceUnavailableException {
    return new ServiceUnavailableException({ error: 'session not ready' });
  }
}

/** Internal marker so a timed-out lookup maps to 503 like an EngineNotReadyError. */
class ProfileLookupTimeoutError extends Error {}
