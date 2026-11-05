import { describe, expect, it, vi } from 'vitest';
import { type PhoneRef, WhatsAppClientFactory, type WhatsAppGateway } from '../src';

const graph = { apiVersion: 'v25.0' };
const fakeGateway = (phoneNumberId: string) =>
  ({ phoneNumberId, wabaId: 'waba' }) as unknown as WhatsAppGateway;

function build(overrides: Partial<ConstructorParameters<typeof WhatsAppClientFactory>[0]> = {}) {
  const loadCredentials = vi.fn(async (_: PhoneRef) => ({ accessToken: 't', wabaId: 'waba' }));
  const factory = new WhatsAppClientFactory({
    loadCredentials,
    graph,
    createGateway: (id) => fakeGateway(id),
    ...overrides,
  });
  return { factory, loadCredentials };
}

const ref = (phoneNumberId: string, orgId = 'org-a') => ({ orgId, phoneNumberId });

describe('WhatsAppClientFactory', () => {
  it('caches per phone number', async () => {
    const { factory, loadCredentials } = build();
    const first = await factory.get(ref('1'));
    expect(await factory.get(ref('1'))).toBe(first);
    expect(loadCredentials).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used client', async () => {
    const { factory, loadCredentials } = build({ maxSize: 2 });
    await factory.get(ref('1'));
    await factory.get(ref('2'));
    await factory.get(ref('1')); // 2 is now the oldest
    await factory.get(ref('3'));
    expect(factory.size).toBe(2);
    loadCredentials.mockClear();
    await factory.get(ref('1'));
    expect(loadCredentials).not.toHaveBeenCalled();
    await factory.get(ref('2'));
    expect(loadCredentials).toHaveBeenCalledTimes(1);
  });

  it('expires clients so decrypted tokens do not stay in memory', async () => {
    let now = 1_000;
    const { factory, loadCredentials } = build({ ttlMs: 100, now: () => now });
    await factory.get(ref('1'));
    now += 101;
    await factory.get(ref('1'));
    expect(loadCredentials).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces a reload (token rotated or number disconnected)', async () => {
    const { factory, loadCredentials } = build();
    await factory.get(ref('1'));
    factory.invalidate('1');
    await factory.get(ref('1'));
    expect(loadCredentials).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent callers', async () => {
    const { factory, loadCredentials } = build();
    await Promise.all([factory.get(ref('1')), factory.get(ref('1')), factory.get(ref('1'))]);
    expect(loadCredentials).toHaveBeenCalledTimes(1);
  });

  it('never serves one org a client cached for another org', async () => {
    const { factory, loadCredentials } = build();
    loadCredentials.mockImplementation(async (r: PhoneRef) => {
      if (r.orgId !== 'org-a') throw new Error('not found under RLS');
      return { accessToken: 't', wabaId: 'waba' };
    });
    await factory.get(ref('1', 'org-a'));
    await expect(factory.get(ref('1', 'org-b'))).rejects.toThrow('not found under RLS');
    // The owner's cached client survives the refused attempt.
    loadCredentials.mockClear();
    await factory.get(ref('1', 'org-a'));
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it('does not cache failures', async () => {
    const { factory, loadCredentials } = build();
    loadCredentials.mockRejectedValueOnce(new Error('db down'));
    await expect(factory.get(ref('1'))).rejects.toThrow('db down');
    await expect(factory.get(ref('1'))).resolves.toBeDefined();
  });
});
