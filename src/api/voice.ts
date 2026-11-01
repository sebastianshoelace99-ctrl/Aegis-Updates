import type { ScreenQuality, VoicePreferences } from "./profile";

/**
 * Voice constraints and level maths, kept free of React and of `getUserMedia` itself.
 *
 * The session in `src/state/voiceSession.ts` calls these; Vitest can test them without a browser.
 * Everything here is a pure function of the saved preferences, so what the settings dialog says
 * and what the capture request asks for cannot drift apart.
 */

export const LEVEL_SEGMENTS = 12;

/** `deviceId: "default"` means "let the OS choose", which is not the same as an empty object. */
export function audioConstraints(preferences: VoicePreferences): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    noiseSuppression: preferences.noiseSuppression,
    echoCancellation: preferences.echoCancellation,
    autoGainControl: preferences.autoGainControl,
  };

  if (preferences.inputDeviceId !== "default") {
    constraints.deviceId = { exact: preferences.inputDeviceId };
  }

  return constraints;
}

export function videoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

/**
 * "Source" means "do not downscale" - the capture keeps the display's native resolution. The two
 * fixed tiers ask for a height and let the aspect ratio follow, because forcing both dimensions
 * letterboxes a 16:10 monitor.
 */
export function screenConstraints(quality: ScreenQuality): DisplayMediaStreamOptions {
  if (quality === "source") return { video: true, audio: false };

  const height = quality === "720p" ? 720 : 1080;
  return {
    video: { height: { ideal: height }, frameRate: { ideal: 30, max: 30 } },
    audio: false,
  };
}

/** Byte time-domain data is centred on 128, so this is already a signed -1..1 waveform. */
export function rmsOf(data: Uint8Array): number {
  if (data.length === 0) return 0;

  let sum = 0;
  for (const sample of data) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / data.length);
}

/** 0 = silence, 12 = clipping. A logarithmic scale so quiet speech still moves the meter. */
export function levelBucket(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;

  const db = 20 * Math.log10(Math.min(1, rms));
  const normalized = Math.max(0, Math.min(1, (db + 60) / 60));
  return Math.round(normalized * LEVEL_SEGMENTS);
}

/**
 * Higher sensitivity lowers the threshold. At 100 the ring reacts to almost anything; at 0 it
 * takes a loud voice, which is what "push to talk without push to talk" needs in a noisy room.
 */
export function speakingThresholdDb(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  return -60 + (1 - clamped / 100) * 55;
}

export function isSpeaking(rms: number, sensitivity: number): boolean {
  if (!Number.isFinite(rms) || rms <= 0) return false;
  return 20 * Math.log10(Math.min(1, rms)) >= speakingThresholdDb(sensitivity);
}

/** A device label can be empty before permission is granted; the index keeps the option unique. */
export function deviceLabel(label: string, index: number, fallback: string): string {
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : `${fallback} ${index + 1}`;
}
