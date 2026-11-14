import type { Arrangement, Rotation, Slot } from './protocol';

export type Resolution = 720 | 1080 | 2160;

export interface SlotSettings {
  deviceId: string;
  label: string;
  resolution: Resolution;
  fps: 30 | 60;
}

export interface CameraPrefs {
  rotation: Rotation;
  mirror: boolean;
}

export interface Settings {
  slots: Record<Slot, SlotSettings>;
  /** Keyed by camera label, so rotation/mirror follow the camera between slots. */
  cameras: Record<string, CameraPrefs>;
  /** >0 delays B, <0 delays A. */
  videoOffsetMs: number;
  audioDeviceId: string; // '' = no audio
  audioLabel: string;
  /** >0 delays audio, <0 delays both videos. */
  audioOffsetMs: number;
  /** Output quality as a 16:9 'Np' figure. */
  outSize: 720 | 1080 | 1440;
  /** Applies to both the preview and the combined recording. */
  arrangement: Arrangement;
  outFps: 30 | 60;
  saveIndividual: boolean;
  view: 'cameras' | 'output';
}

export const VIDEO_OFFSET_LIMIT = 2000;
export const AUDIO_OFFSET_LIMIT = 1500;

const KEY = 'bi_webcam.settings.v1';

const defaults = (): Settings => ({
  slots: {
    A: { deviceId: '', label: '', resolution: 1080, fps: 30 },
    B: { deviceId: '', label: '', resolution: 1080, fps: 30 },
  },
  cameras: {},
  videoOffsetMs: 0,
  audioDeviceId: '',
  audioLabel: '',
  audioOffsetMs: 0,
  outSize: 1080,
  arrangement: 'side',
  outFps: 30,
  saveIndividual: false,
  view: 'cameras',
});

export function loadSettings(): Settings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...d,
      ...s,
      slots: { A: { ...d.slots.A, ...s.slots?.A }, B: { ...d.slots.B, ...s.slots?.B } },
      cameras: { ...s.cameras },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

export function cameraPrefs(s: Settings, label: string): CameraPrefs {
  return s.cameras[label] ?? { rotation: 0, mirror: false };
}

/** Per-slot video delay and audio delay implied by the two offsets. */
export function delays(s: Settings) {
  const base = Math.max(0, -s.audioOffsetMs);
  return {
    A: base + Math.max(0, -s.videoOffsetMs),
    B: base + Math.max(0, s.videoOffsetMs),
    audio: Math.max(0, s.audioOffsetMs),
  };
}
