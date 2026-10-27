import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ipMatches, normalizeIp, resolveClientIp, RequestLike } from '../utils/ip';

/**
 * Rate-limit bucket keyed on the resolved client IP.
 *
 * The stock ThrottlerGuard keys on `req.ip`, which — behind the documented reverse
 * proxy with Express `trust proxy` disabled — resolves to the proxy for every client,
 * so all traffic shares ONE bucket and a single abuser rate-limits everyone (self-DoS).
 *
 * This reuses the same trusted-proxy-aware resolution as ApiKeyGuard: with no
 * TRUSTED_PROXIES configured it falls back to the socket IP (no behavior change and no
 * XFF-spoofing risk); with trusted proxies it keys on the real forwarded client IP.
 *
 * RATE_LIMIT_BYPASS_IPS (comma-separated IPs/CIDRs) exempts matching clients from ALL
 * throttling. Matching is deliberately header-based even when TRUSTED_PROXIES is unset:
 * an exemption list does not need spoof-purity (worst case an abuser escapes their own
 * limits), while it must work behind CF + nginx where the socket peer is never the real
 * client. We check every XFF hop plus the socket address.
 */
@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const trustedProxies = (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(proxy => proxy.trim())
      .filter(Boolean);
    return Promise.resolve(resolveClientIp(req as unknown as RequestLike, trustedProxies));
  }

  async canActivate(context: Parameters<ThrottlerGuard['canActivate']>[0]): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http?.getRequest?.() as RequestLike | undefined;
    if (req && ProxyAwareThrottlerGuard.isThrottleBypassed(req)) {
      return true;
    }
    return super.canActivate(context);
  }

  private static isThrottleBypassed(req: RequestLike): boolean {
    const entries = (process.env.RATE_LIMIT_BYPASS_IPS || '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      return false;
    }
    const candidates = new Set<string>([normalizeIp(req.socket?.remoteAddress || '')]);
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
        .split(',')
        .map(hop => normalizeIp(hop.trim()))
        .filter(Boolean);
      for (const hop of hops) candidates.add(hop);
    }
    for (const ip of candidates) {
      if (ip && ipMatchesAny(ip, entries)) {
        return true;
      }
    }
    return false;
  }
}

function ipMatchesAny(ip: string, targets: string[]): boolean {
  return targets.some(target => ipMatches(ip, target));
}
