import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';

/**
 * Regression lock: RATE_LIMIT_BYPASS_IPS exempts listed client IPs/CIDRs from ALL
 * throttling. We sit behind CF + a host nginx, so the real client is the leftmost
 * hop of X-Forwarded-For; the request is bypassed if ANY hop (or the direct peer)
 * matches a listed entry — the throttle must never even touch the storage.
 */

const NAMED_THROTTLERS = [
  { name: 'short', ttl: 1000, limit: 10 },
  { name: 'medium', ttl: 60000, limit: 100 },
  { name: 'long', ttl: 3600000, limit: 1000 },
] as const;

const increment = jest.fn(async () => ({
  totalHits: 1,
  timeToExpire: 1,
  isBlocked: false,
  timeToBlockExpire: 0,
}));

const reflector = {
  getAllAndOverride: () => undefined,
};

const origBypass = process.env.RATE_LIMIT_BYPASS_IPS;
afterEach(() => {
  if (origBypass === undefined) delete process.env.RATE_LIMIT_BYPASS_IPS;
  else process.env.RATE_LIMIT_BYPASS_IPS = origBypass;
  increment.mockClear();
});

function makeGuard() {
  const guard = new ProxyAwareThrottlerGuard(
    NAMED_THROTTLERS as unknown as never,
    { increment } as unknown as never,
    reflector as never,
  );
  void guard.onModuleInit();
  return guard;
}

function ctx(req: Record<string, unknown>) {
  class Plain {
    handle() {}
  }
  return {
    getHandler: () => Plain.prototype.handle,
    getClass: () => Plain,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: jest.fn() }) }),
  } as never;
}

describe('RATE_LIMIT_BYPASS_IPS', () => {
  it('bypasses throttling when the XFF client matches', async () => {
    process.env.RATE_LIMIT_BYPASS_IPS = '203.0.113.9';
    const result = await makeGuard().canActivate(
      ctx({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9, 188.114.96.9' } }),
    );
    expect(result).toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('supports CIDR entries', async () => {
    process.env.RATE_LIMIT_BYPASS_IPS = '203.0.113.0/24';
    const result = await makeGuard().canActivate(
      ctx({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-forwarded-for': '203.0.113.77, 188.114.96.9' } }),
    );
    expect(result).toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('does not bypass unlisted clients', async () => {
    process.env.RATE_LIMIT_BYPASS_IPS = '203.0.113.9';
    const result = await makeGuard().canActivate(
      ctx({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-forwarded-for': '203.0.113.99, 188.114.96.9' } }),
    );
    expect(result).toBe(true); // under limit, still allowed — but throttled
    expect(increment).toHaveBeenCalledTimes(3); // short + medium + long
  });

  it('is inert with no env configured (control)', async () => {
    delete process.env.RATE_LIMIT_BYPASS_IPS;
    const result = await makeGuard().canActivate(
      ctx({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9, 188.114.96.9' } }),
    );
    expect(result).toBe(true);
    expect(increment).toHaveBeenCalledTimes(3);
  });
});