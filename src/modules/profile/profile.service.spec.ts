import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

jest.mock('../../common/media/load-remote-media', () => ({
  loadRemoteMediaBuffer: jest.fn(),
}));

const mockedLoadRemote = loadRemoteMediaBuffer as jest.MockedFunction<typeof loadRemoteMediaBuffer>;

describe('ProfileService', () => {
  const READY_SESSION = { id: 's1', status: SessionStatus.READY } as never;

  const makeService = (
    sessions: Array<{ id: string; status: SessionStatus }>,
    engines: Record<string, Partial<IWhatsAppEngine> | undefined>,
    opts?: { lookupTimeoutMs?: number },
  ) => {
    const findAll = jest.fn().mockResolvedValue(sessions);
    const sessionService = {
      findAll,
      getEngine: jest.fn((id: string) => engines[id]),
    } as unknown as SessionService;
    return { service: new ProfileService(sessionService, opts), findAll };
  };

  const readyEngine = (overrides: Partial<IWhatsAppEngine> = {}): Partial<IWhatsAppEngine> => ({
    getNumberId: jest.fn().mockResolvedValue('380671234567@c.us'),
    getContactById: jest.fn().mockResolvedValue({
      id: '380671234567@c.us',
      pushName: 'Sasha Watch',
      number: '380671234567',
      isMyContact: false,
      isBlocked: false,
    }),
    getProfilePicture: jest.fn().mockResolvedValue('https://pps.whatsapp.net/pic.jpg'),
    ...overrides,
  });

  beforeEach(() => {
    mockedLoadRemote.mockReset();
    mockedLoadRemote.mockResolvedValue({ data: Buffer.from('img'), mimetype: 'image/jpeg' });
  });

  // ---------- validation (400) ----------

  it.each(['', 'abc', '+380671234567', '1234567', '1234567890123456'])(
    'rejects %j as an invalid phone with the contract 400 body',
    async phone => {
      const { service } = makeService([READY_SESSION], { s1: readyEngine() });
      const err: unknown = await service.lookupByPhone(phone).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        chatId: null,
        exists: null,
        name: null,
        profilePic: null,
        error: 'invalid phone',
      });
    },
  );

  it('does not touch the session layer on invalid input', async () => {
    const { service, findAll } = makeService([READY_SESSION], { s1: readyEngine() });
    await expect(service.lookupByPhone('junk')).rejects.toBeInstanceOf(BadRequestException);
    expect(findAll).not.toHaveBeenCalled();
  });

  // ---------- session readiness (503) ----------

  it('returns 503 when no session exists', async () => {
    const { service } = makeService([], {});
    const err: unknown = await service.lookupByPhone('380671234567').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toEqual({ error: 'session not ready' });
  });

  it('returns 503 when no session is READY', async () => {
    const { service } = makeService([{ id: 's1', status: SessionStatus.DISCONNECTED }], {
      s1: readyEngine(),
    });
    await expect(service.lookupByPhone('380671234567')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 503 when the READY session has no live engine', async () => {
    const { service } = makeService([READY_SESSION], { s1: undefined });
    await expect(service.lookupByPhone('380671234567')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 503 when the engine reports not-ready mid-lookup', async () => {
    const engine = readyEngine({ getNumberId: jest.fn().mockRejectedValue(new EngineNotReadyError()) });
    const { service } = makeService([READY_SESSION], { s1: engine });
    await expect(service.lookupByPhone('380671234567')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 503 when the number lookup hangs past the lookup timeout', async () => {
    const engine = readyEngine({ getNumberId: jest.fn().mockReturnValue(new Promise(() => {})) });
    const { service } = makeService([READY_SESSION], { s1: engine }, { lookupTimeoutMs: 50 });
    await expect(service.lookupByPhone('380671234567')).rejects.toBeInstanceOf(ServiceUnavailableException);
  }, 5000);

  it('picks a later READY session when the first one is not ready', async () => {
    const { service } = makeService([{ id: 's0', status: SessionStatus.DISCONNECTED }, READY_SESSION], {
      s0: undefined,
      s1: readyEngine(),
    });
    const result = await service.lookupByPhone('380671234567');
    expect(result.exists).toBe(true);
  });

  // ---------- number not on WhatsApp (200 exists:false) ----------

  it('returns exists:false without fetching name/avatar for an unregistered number', async () => {
    const engine = readyEngine({ getNumberId: jest.fn().mockResolvedValue(null) });
    const { service } = makeService([READY_SESSION], { s1: engine });
    const result = await service.lookupByPhone('380671234567');
    expect(engine.getNumberId).toHaveBeenCalledWith('380671234567');
    expect(result).toEqual({
      chatId: '380671234567@c.us',
      exists: false,
      name: null,
      profilePic: null,
    });
    expect(engine.getContactById).not.toHaveBeenCalled();
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(mockedLoadRemote).not.toHaveBeenCalled();
  });

  // ---------- number on WhatsApp (200 exists:true) ----------

  it('returns pushName and the avatar as a data URL', async () => {
    const { service } = makeService([READY_SESSION], { s1: readyEngine() });
    const result = await service.lookupByPhone('380671234567');
    expect(result).toEqual({
      chatId: '380671234567@c.us',
      exists: true,
      name: 'Sasha Watch',
      profilePic: 'data:image/jpeg;base64,aW1n',
    });
  });

  it('falls back to the contact name when pushName is absent', async () => {
    const engine = readyEngine({
      getContactById: jest.fn().mockResolvedValue({
        id: '380671234567@c.us',
        name: 'Sasha (phonebook)',
        number: '380671234567',
        isMyContact: false,
        isBlocked: false,
      }),
    });
    const { service } = makeService([READY_SESSION], { s1: engine });
    await expect(service.lookupByPhone('380671234567')).resolves.toMatchObject({ name: 'Sasha (phonebook)' });
  });

  it('returns name:null when the engine cannot resolve a contact', async () => {
    const engine = readyEngine({ getContactById: jest.fn().mockRejectedValue(new Error('unknown id')) });
    const { service } = makeService([READY_SESSION], { s1: engine });
    await expect(service.lookupByPhone('380671234567')).resolves.toMatchObject({ exists: true, name: null });
  });

  it('returns profilePic:null when there is no avatar URL', async () => {
    const engine = readyEngine({ getProfilePicture: jest.fn().mockResolvedValue(null) });
    const { service } = makeService([READY_SESSION], { s1: engine });
    const result = await service.lookupByPhone('380671234567');
    expect(result.profilePic).toBeNull();
    expect(mockedLoadRemote).not.toHaveBeenCalled();
  });

  it('returns profilePic:null when the avatar download fails', async () => {
    mockedLoadRemote.mockRejectedValue(new Error('Media fetch failed with status 404'));
    const { service } = makeService([READY_SESSION], { s1: readyEngine() });
    await expect(service.lookupByPhone('380671234567')).resolves.toMatchObject({
      exists: true,
      profilePic: null,
    });
  });

  // ---------- api-key scoping ----------

  it("scopes session selection to the key's allowedSessions", async () => {
    const { service, findAll } = makeService([READY_SESSION], { s1: readyEngine() });
    await service.lookupByPhone('380671234567', ['s1']);
    expect(findAll).toHaveBeenCalledWith(['s1']);
  });
});
