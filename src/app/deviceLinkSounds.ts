import type { DeviceLink } from '../backend';

/** `lost` when a recording's device drops off USB, `reconnected` when its video resumes. */
export type DeviceLinkSound = 'lost' | 'reconnected';

/** The parts of an AudioContext the sounds use, so a test can stand in for it. */
export interface ToneContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

/**
 * Two tones each, about 150 ms apiece, loud enough to hear from the PC's speakers with a headset on: falling (E5 to A4)
 * when the device goes, rising (C5 to G5) when it is back.
 */
export const DEVICE_LINK_TONES: Record<DeviceLinkSound, readonly number[]> = { lost: [659.25, 440], reconnected: [523.25, 783.99] };
const TONE_S = 0.15;
const GAP_S = 0.03;
const PEAK_GAIN = 0.28;

/**
 * The sound a change of the status's `device` plays: `lost` when it turns `reconnecting`, `reconnected` when it turns
 * `connected` after `reconnecting`, otherwise none. A take that starts connected, a state that holds, and the end of the
 * recording (the field goes away) play nothing.
 */
export function deviceLinkSound(previous: DeviceLink | undefined, next: DeviceLink | undefined): DeviceLinkSound | null {
  if (next === 'reconnecting' && previous !== 'reconnecting') return 'lost';
  if (next === 'connected' && previous === 'reconnecting') return 'reconnected';
  return null;
}

/** Plays the two tones of `sound` on `context`, from now. */
export function playDeviceLinkSound(context: ToneContext, sound: DeviceLinkSound) {
  const start = context.currentTime + 0.01;
  DEVICE_LINK_TONES[sound].forEach((frequency, index) => {
    const at = start + index * (TONE_S + GAP_S);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, at);
    // A short rise and fall, so the tone does not click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.01);
    gain.gain.setValueAtTime(PEAK_GAIN, at + TONE_S - 0.04);
    gain.gain.linearRampToValueAtTime(0, at + TONE_S);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + TONE_S + 0.01);
  });
}

export interface DeviceLinkSounds {
  /** Takes the status's `device` after each poll and plays the sound its change calls for; returns that sound. */
  update(next: DeviceLink | undefined): DeviceLinkSound | null;
  /** Closes the audio context. */
  dispose(): void;
}

/**
 * Follows the recording's device link across status polls and plays the lost and reconnected sounds. The audio context
 * is made on the first sound (`createContext`, a real AudioContext by default) and kept; the app has had the Record click
 * by then, so it may play.
 */
export function createDeviceLinkSounds(createContext: () => ToneContext = () => new AudioContext()): DeviceLinkSounds {
  let previous: DeviceLink | undefined;
  let context: ToneContext | undefined;
  return {
    update(next) {
      const sound = deviceLinkSound(previous, next);
      previous = next;
      if (!sound) return null;
      try {
        context ??= createContext();
        if (context.state === 'suspended') void context.resume().catch(() => {});
        playDeviceLinkSound(context, sound);
      } catch {
        // No audio output: the dock still shows the state.
      }
      return sound;
    },
    dispose() {
      void context?.close().catch(() => {});
      context = undefined;
    },
  };
}
