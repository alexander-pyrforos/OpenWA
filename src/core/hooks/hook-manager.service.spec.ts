// Hook handlers must satisfy the async HookHandler signature; the test stubs return synchronously,
// so the no-await rule doesn't apply to them here.
/* eslint-disable @typescript-eslint/require-await */
import { HookManager } from './hook-manager.service';

describe('HookManager', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = new HookManager();
  });

  it('returns {continue:true, data} unchanged when no handlers are registered', async () => {
    const res = await hm.execute('message:received', { a: 1 }, { source: 'test' });
    expect(res).toEqual({ continue: true, data: { a: 1 } });
  });

  it('runs handlers in ascending priority order and propagates the mutated data', async () => {
    hm.register(
      'p',
      'message:received',
      async ctx => ({ continue: true, data: [...(ctx.data as string[]), 'late'] }),
      20,
    );
    hm.register(
      'p',
      'message:received',
      async ctx => ({ continue: true, data: [...(ctx.data as string[]), 'early'] }),
      10,
    );

    const res = await hm.execute<string[]>('message:received', [], { source: 'test' });
    expect(res.data).toEqual(['early', 'late']); // priority 10 runs before 20
  });

  it('stops the chain when a handler returns continue:false', async () => {
    const second = jest.fn();
    hm.register('p', 'message:received', async () => ({ continue: false, data: 'stopped' }), 10);
    hm.register(
      'p',
      'message:received',
      async ctx => {
        second();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'start', { source: 'test' });
    expect(res).toEqual({ continue: false, data: 'stopped' });
    expect(second).not.toHaveBeenCalled();
  });

  it('isolates a throwing handler — later handlers still run', async () => {
    const later = jest.fn();
    hm.register(
      'p',
      'message:received',
      async () => {
        throw new Error('boom');
      },
      10,
    );
    hm.register(
      'p',
      'message:received',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'd', { source: 'test' });
    expect(later).toHaveBeenCalledTimes(1);
    expect(res.continue).toBe(true);
  });

  it('isolates a handler that returns result.error — the chain continues', async () => {
    const later = jest.fn();
    hm.register('p', 'message:received', async ctx => ({ continue: true, data: ctx.data, error: new Error('x') }), 10);
    hm.register(
      'p',
      'message:received',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'd', { source: 'test' });
    expect(later).toHaveBeenCalledTimes(1);
    expect(res.continue).toBe(true);
  });

  it('register/unregister/hasHooks/getHookCount track registrations', () => {
    expect(hm.hasHooks('session:created')).toBe(false);
    const id = hm.register('p', 'session:created', async ctx => ({ continue: true, data: ctx.data }));
    expect(hm.hasHooks('session:created')).toBe(true);
    expect(hm.getHookCount('session:created')).toBe(1);

    hm.unregister(id);
    expect(hm.getHookCount('session:created')).toBe(0);
    expect(hm.hasHooks('session:created')).toBe(false);
  });

  it('unregisterPlugin removes only that plugin’s hooks', () => {
    hm.register('A', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));
    hm.register('A', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));
    hm.register('B', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));

    hm.unregisterPlugin('A');
    expect(hm.getHookCount('session:ready')).toBe(1); // only B remains
  });
});
