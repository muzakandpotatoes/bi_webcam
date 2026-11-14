import type { Resolution } from './settings';

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
}

/** Ask for camera (and mic) permission once so device labels are visible. */
export async function unlockLabels(): Promise<void> {
  const tryGet = async (c: MediaStreamConstraints) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  };
  if (!(await tryGet({ video: true, audio: true }))) await tryGet({ video: true });
}

export async function listDevices(): Promise<DeviceLists> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === 'videoinput' && d.deviceId),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'),
  };
}

/** Find a saved device again: by id first, then by label (ids can change after re-plugging). */
export function findDevice(list: MediaDeviceInfo[], id: string, label: string) {
  return list.find((d) => d.deviceId === id) ?? (label ? list.find((d) => d.label === label) : undefined);
}

const SIZES: Record<Resolution, [number, number]> = {
  720: [1280, 720],
  1080: [1920, 1080],
  2160: [3840, 2160],
};

export async function openCamera(deviceId: string, res: Resolution, fps: number) {
  const [width, height] = SIZES[res];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps },
    },
  });
  return stream.getVideoTracks()[0];
}

export async function openMic(deviceId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      // Raw audio: these are meant for calls and hurt recordings.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  return stream.getAudioTracks()[0];
}
