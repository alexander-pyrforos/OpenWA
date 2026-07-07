import { isKnownHookEvent, KNOWN_HOOK_EVENTS } from './hook.interfaces';

describe('hook events', () => {
  it('recognizes message:persisted (the search-indexer hook)', () => {
    expect(isKnownHookEvent('message:persisted')).toBe(true);
    expect(KNOWN_HOOK_EVENTS.has('message:persisted')).toBe(true);
  });

  it('still recognizes the existing message lifecycle events', () => {
    for (const e of ['message:received', 'message:sending', 'message:sent', 'message:failed', 'message:ack']) {
      expect(isKnownHookEvent(e)).toBe(true);
    }
  });
});