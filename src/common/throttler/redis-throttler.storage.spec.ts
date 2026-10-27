import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Regression lock: the storage must self-heal a Redis key that lost its TTL.
 *
 * Failure mode (production, 2026-10-27): a Redis connection drop/restart between
 * the `incr` (created the key) and the `pexpire` (lost) left the bucket key with NO
 * TTL. Because the old code only set the TTL when `incr` returned exactly 1, the key
 * could never regain it — every request counted forever, and once hits passed the
 * limit EVERY request on that route was 429 permanently (/api/health was stuck
 * blocked with 16k+ hits and PTTL = -1).
 *
 * The fix checks PTTL on every increment and re-applies the window TTL whenever it
 * is missing, preserving fixed-window semantics for keys that still have one.
 */

interface FakeCall {
  cmd: string;
  args: unknown[];
}

/**
 * @param pttlWithoutTtl what `pttl` reports while the key has no TTL (Redis: -1)
 * @param initialIncr    what the first `incr` returns (2 = NOT the first hit)
 */
function makeRedis(pttlWithoutTtl: number, initialIncr: number) {
  const calls: FakeCall[] = [];
  let incrs = 0;
  const redis = {
    async incr() {
      calls.push({ cmd: 'incr', args: [] });
      incrs += 1;
      return incrs === 1 ? initialIncr : initialIncr + incrs - 1;
    },
    async pttl() {
      calls.push({ cmd: 'pttl', args: [] });
      // Once a pexpire ran, the key has a live TTL (1000ms); before that, none.
      return calls.some(c => c.cmd === 'pexpire') ? 1000 : pttlWithoutTtl;
    },
    async pexpire(_key: string, ttl: number) {
      calls.push({ cmd: 'pexpire', args: [ttl] });
      return 1;
    },
  };
  return { redis, calls };
}

describe('RedisThrottlerStorage TTL self-heal', () => {
  it('re-applies the TTL when the key has none (lost pexpire)', async () => {
    // Production state: the key was created by an incr whose pexpire was lost,
    // so this increment is NOT the first hit (returns 2) and PTTL is -1 (exists, no TTL).
    const { redis, calls } = makeRedis(-1, 2);
    const storage = new RedisThrottlerStorage(redis as never);
    const record = await storage.increment('k', 1000, 10, 1000, 'short');

    expect(calls.some(c => c.cmd === 'pexpire')).toBe(true);
    expect(record.timeToExpire).toBe(1); // ceil(1000ms / 1000)
    expect(record.isBlocked).toBe(false);
  });

  it('blocks when hits exceed the limit', async () => {
    const fake = {
      incr: async () => 11,
      pexpire: async () => 1,
      pttl: async () => 500,
    };
    const storage = new RedisThrottlerStorage(fake as never);
    const record = await storage.increment('k', 1000, 10, 1000, 'short');
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(1);
  });

  it('keeps the existing TTL window untouched (no sliding window)', async () => {
    // 2nd hit with 500ms left on the window: no pexpire, remaining time reported.
    const { redis, calls } = makeRedis(500, 2);
    const storage = new RedisThrottlerStorage(redis as never);
    const record = await storage.increment('k', 1000, 10, 1000, 'short');
    expect(calls.filter(c => c.cmd === 'pexpire').length).toBe(0);
    expect(record.totalHits).toBe(2);
    expect(record.timeToExpire).toBe(1); // ceil(500/1000)
  });
});