import { describe, expect, it, vi } from 'vitest';
import { createSystemProcessor, HEARTBEAT_KEY, UnknownJobError } from './processor.js';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('system processor', () => {
  it('heartbeat scrive un timestamp con TTL in Redis', async () => {
    const store = { set: vi.fn().mockResolvedValue('OK') };
    const fixed = new Date('2026-10-10T20:00:00.000Z');
    const process = createSystemProcessor({ store, logger, now: () => fixed });
    const result = await process({ name: 'heartbeat', data: {} });
    expect(result).toEqual({ at: fixed.toISOString() });
    expect(store.set).toHaveBeenCalledWith(HEARTBEAT_KEY, fixed.toISOString(), 'EX', 180);
  });

  it('pubblica il battito per attivare la manutenzione del Brain', async () => {
    const publishHeartbeat = vi.fn().mockResolvedValue(1);
    const process = createSystemProcessor({ store: { set: vi.fn() }, logger, publishHeartbeat });
    await process({ name: 'heartbeat', data: {} });
    expect(publishHeartbeat).toHaveBeenCalledWith('ernie:system:heartbeat', expect.any(String));
  });

  it('ping restituisce il payload', async () => {
    const store = { set: vi.fn() };
    const process = createSystemProcessor({ store, logger });
    const result = (await process({ name: 'ping', data: { hello: 'world' } })) as {
      pong: boolean;
      echo: unknown;
    };
    expect(result.pong).toBe(true);
    expect(result.echo).toEqual({ hello: 'world' });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('rifiuta job sconosciuti', async () => {
    const process = createSystemProcessor({ store: { set: vi.fn() }, logger });
    await expect(process({ name: 'boom', data: null })).rejects.toThrowError(UnknownJobError);
  });
});
