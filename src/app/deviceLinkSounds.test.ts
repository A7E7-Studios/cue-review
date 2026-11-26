import { describe, expect, it, vi } from 'vitest';
import { createDeviceLinkSounds, DEVICE_LINK_TONES, deviceLinkSound } from './deviceLinkSounds';
import type { ToneContext } from './deviceLinkSounds';

/** An AudioContext stand-in that keeps the frequencies of the tones started on it, in order. */
function fakeContext() {
  const tones: number[] = [];
  const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const context = {
    currentTime: 0, state: 'running', destination: {} as AudioNode,
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createOscillator: () => {
      const frequency = { setValueAtTime: vi.fn((value: number) => { tones.push(value); }) };
      return { type: 'sine', frequency, connect: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as OscillatorNode;
    },
    createGain: () => ({ gain: param(), connect: vi.fn() }) as unknown as GainNode,
  } satisfies ToneContext;
  return { context, tones };
}

describe('device link sounds', () => {
  it('play once for each drop and each return', () => {
    const { context, tones } = fakeContext();
    const create = vi.fn(() => context);
    const sounds = createDeviceLinkSounds(create);
    // A take starts connected and holds: nothing plays, and no audio context is made.
    expect([undefined, 'connected', 'connected'].map(value => sounds.update(value as 'connected' | undefined))).toEqual([null, null, null]);
    expect(create).not.toHaveBeenCalled();
    // The device drops, and stays gone over several polls: one lost sound.
    expect(sounds.update('reconnecting')).toBe('lost');
    expect(sounds.update('reconnecting')).toBeNull();
    expect(tones).toEqual([...DEVICE_LINK_TONES.lost]);
    // It comes back: one reconnected sound.
    expect(sounds.update('connected')).toBe('reconnected');
    expect(sounds.update('connected')).toBeNull();
    expect(tones).toEqual([...DEVICE_LINK_TONES.lost, ...DEVICE_LINK_TONES.reconnected]);
    // A second drop and return play again, on the same context.
    expect(sounds.update('reconnecting')).toBe('lost');
    expect(sounds.update('connected')).toBe('reconnected');
    expect(create).toHaveBeenCalledTimes(1);
    expect(tones).toHaveLength(8);
    sounds.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
  it('fall when the device goes and rise when it is back', () => {
    const [lostFirst, lostSecond] = DEVICE_LINK_TONES.lost;
    const [backFirst, backSecond] = DEVICE_LINK_TONES.reconnected;
    expect(lostSecond).toBeLessThan(lostFirst);
    expect(backSecond).toBeGreaterThan(backFirst);
  });
  it('stay silent when the recording ends, connected or not, and for a take that starts after it', () => {
    expect(deviceLinkSound('reconnecting', undefined)).toBeNull();
    expect(deviceLinkSound('connected', undefined)).toBeNull();
    expect(deviceLinkSound(undefined, 'connected')).toBeNull();
    // A device already gone at the first status of a take still says so.
    expect(deviceLinkSound(undefined, 'reconnecting')).toBe('lost');
  });
  it('keep going when the computer has no audio output', () => {
    const sounds = createDeviceLinkSounds(() => { throw new Error('No audio device'); });
    sounds.update('connected');
    expect(sounds.update('reconnecting')).toBe('lost');
    expect(sounds.update('connected')).toBe('reconnected');
  });
  it('wake a suspended audio context before playing', () => {
    const { context } = fakeContext();
    const suspended = { ...context, state: 'suspended' };
    const sounds = createDeviceLinkSounds(() => suspended);
    sounds.update('connected');
    sounds.update('reconnecting');
    expect(suspended.resume).toHaveBeenCalledTimes(1);
  });
});
