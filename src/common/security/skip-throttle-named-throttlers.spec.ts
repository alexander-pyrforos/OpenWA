import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';
import { HealthController } from '../../modules/health/health.controller';
import { MetricsController } from '../../modules/metrics/metrics.controller';

/**
 * Regression lock: bare `@SkipThrottle()` only sets skip metadata for a throttler
 * literally named "default" (@nestjs/throttler v6 default arg = { default: true }),
 * while the guard checks `THROTTLER:SKIP + namedThrottler.name` for every configured
 * throttler. The app configures named 'short'/'medium'/'long' throttlers, so the bare
 * decorator is a no-op and health/metrics endpoints get rate-limited (observed as
 * permanent 429s on /api/health). These specs drive the REAL guard against the REAL
 * decorated controllers, so the skip path is exercised end to end.
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

// Faithful getAllAndOverride over real decorator metadata: handler first, then class.
const reflector = {
  getAllAndOverride: (_key: string, targets: object[]) => {
    for (const target of targets) {
      const value = Reflect.getMetadata(_key, target);
      if (value !== undefined) return value;
    }
    return undefined;
  },
};

function guard(): ProxyAwareThrottlerGuard & { onModuleInit(): Promise<void> } {
  const instance = new ProxyAwareThrottlerGuard(
    NAMED_THROTTLERS as unknown as never,
    { increment } as unknown as never,
    reflector as never,
  );
  return instance as unknown as ProxyAwareThrottlerGuard & { onModuleInit(): Promise<void> };
}

function contextFor(handler: unknown, classRef: unknown) {
  const req = { socket: { remoteAddress: '203.0.113.9' }, headers: {} };
  const res = { header: jest.fn() };
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

describe('@SkipThrottle() covers the production named throttlers', () => {
  beforeEach(() => increment.mockClear());

  it.each([
    ['HealthController', HealthController, HealthController.prototype.check],
    ['MetricsController', MetricsController, MetricsController.prototype.scrape],
  ])('%s is exempt from the global named throttlers', async (_label, classRef, handler) => {
    const g = guard();
    await g.onModuleInit();
    const result = await g.canActivate(contextFor(handler, classRef));
    expect(result).toBe(true);
    // Skipping means the storage must never even see the request.
    expect(increment).not.toHaveBeenCalled();
  });

  // Control: the same rig throttles an UNDECORATED controller, so the specs above
  // cannot silently pass if the library's skip path ever changes.
  it('throttles a route without skip metadata', async () => {
    class PlainController {
      handle() {}
    }
    const g = guard();
    await g.onModuleInit();
    await g.canActivate(contextFor(PlainController.prototype.handle, PlainController));
    expect(increment).toHaveBeenCalled();
  });
});