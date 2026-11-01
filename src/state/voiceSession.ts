import type { VoicePreferences } from "../api/profile";
import {
  audioConstraints,
  isSpeaking,
  levelBucket,
  rmsOf,
  screenConstraints,
  videoConstraints,
} from "../api/voice";

/**
 * The voice session.
 *
 * Deliberately outside React and outside the route: a call survives navigating to a text channel,
 * exactly as a real client's does. The session owns the `MediaStream`s, the analyser and the
 * animation frame, and publishes a small immutable snapshot that components read through
 * `useSyncExternalStore`.
 *
 * There is no signaling server yet, so there are no remote peers to connect to. What *is* real:
 * microphone capture and mute, the speaking meter, camera capture and local preview, and screen
 * capture. The peer connection belongs behind `joinVoice` once the backend exists; the UI and the
 * session state machine do not have to change.
 */

export type VoiceStatus = "idle" | "connecting" | "connected" | "error";

export type VoiceSnapshot = {
  channelId: string | null;
  status: VoiceStatus;
  muted: boolean;
  deafened: boolean;
  micAvailable: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  micLevel: number;
  speaking: boolean;
  error: string | null;
  notice: string | null;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  startedAt: number | null;
};

const IDLE: VoiceSnapshot = {
  channelId: null,
  status: "idle",
  muted: false,
  deafened: false,
  micAvailable: false,
  cameraOn: false,
  screenSharing: false,
  micLevel: 0,
  speaking: false,
  error: null,
  notice: null,
  cameraStream: null,
  screenStream: null,
  startedAt: null,
};

const listeners = new Set<() => void>();
let snapshot: VoiceSnapshot = IDLE;
let preferences: VoicePreferences | null = null;
let mutedBeforeDeafen = false;

let audioStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;

let audioContext: AudioContext | null = null;
let analyserSource: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let frame = 0;
/** Bumped on every join/leave so a permission prompt that resolves late cannot attach to nothing. */
let generation = 0;

export function voiceSnapshot(): VoiceSnapshot {
  return snapshot;
}

export function subscribeVoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(patch: Partial<VoiceSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function describe(error: unknown): string {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Access was blocked. Allow the microphone or camera in Windows privacy settings, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "That device is not available. Choose another one in Voice & Video.";
    case "NotReadableError":
      return "The device is already in use by another app.";
    case "AbortError":
      return "The capture was interrupted. Try again.";
    default:
      return error instanceof Error && error.message.length > 0
        ? error.message
        : "The capture could not start.";
  }
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

function stopAnalyser(): void {
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  analyserSource?.disconnect();
  analyserSource = null;
  analyser = null;
  if (audioContext) {
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
}

function attachAnalyser(stream: MediaStream, sensitivity: number): void {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return;

  try {
    const context = new window.AudioContext();
    const node = context.createAnalyser();
    node.fftSize = 512;
    node.smoothingTimeConstant = 0.7;

    const source = context.createMediaStreamSource(stream);
    source.connect(node);
    void context.resume().catch(() => undefined);

    audioContext = context;
    analyserSource = source;
    analyser = node;
  } catch {
    // A missing analyser costs the meter, not the call.
    return;
  }

  const data = new Uint8Array(analyser.fftSize);

  const tick = (): void => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(data);
    const rms = rmsOf(data);
    const level = snapshot.muted || snapshot.deafened ? 0 : levelBucket(rms);
    const threshold = preferences?.sensitivity ?? sensitivity;
    const speaking = !snapshot.muted && !snapshot.deafened && isSpeaking(rms, threshold);

    if (level !== snapshot.micLevel || speaking !== snapshot.speaking) {
      update({ micLevel: level, speaking });
    }
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
}

/** Applied immediately: sensitivity and constraints are read from here by the live meter. */
export function applyVoicePreferences(next: VoicePreferences): void {
  preferences = next;
}

export async function joinVoice(channelId: string, next: VoicePreferences): Promise<void> {
  if (snapshot.channelId === channelId && snapshot.status === "connected") return;

  leaveVoice();
  preferences = next;
  const token = ++generation;

  update({
    channelId,
    status: "connecting",
    startedAt: Date.now(),
    error: null,
    notice: null,
  });

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    update({
      channelId: null,
      status: "error",
      error: "Microphone capture is not available in this environment.",
    });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(next),
    });

    if (token !== generation) {
      stopStream(stream);
      return;
    }

    audioStream = stream;
    // A mute chosen before joining is remembered, so joining a call is never a surprise broadcast.
    applyMute(snapshot.muted || snapshot.deafened);
    attachAnalyser(stream, next.sensitivity);
    update({ status: "connected", micAvailable: true });
  } catch (error) {
    if (token !== generation) return;

    const name = errorName(error);
    const missingDevice =
      name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError";

    if (missingDevice) {
      // Joining without a mic is still useful: camera and screen sharing do not need one.
      update({
        status: "connected",
        micAvailable: false,
        notice: "No microphone was found. You joined to listen, and can still share a screen.",
      });
      return;
    }

    update({ channelId: null, status: "error", error: describe(error) });
  }
}

export function leaveVoice(): void {
  generation += 1;

  stopAnalyser();
  stopStream(audioStream);
  audioStream = null;

  stopStream(cameraStream);
  cameraStream = null;

  stopStream(screenStream);
  screenStream = null;

  mutedBeforeDeafen = false;

  /*
   * Mute and deafen are preferences, not call state: a mute chosen in the dock survives leaving a
   * call, so the next join cannot start broadcasting. Everything else resets.
   */
  snapshot = { ...IDLE, muted: snapshot.muted, deafened: snapshot.deafened };
  for (const listener of listeners) listener();
}

function applyMute(muted: boolean): void {
  if (!audioStream) return;
  for (const track of audioStream.getAudioTracks()) track.enabled = !muted;
}

/**
 * Works whether or not a call is live: without a stream it only records the preference. Unmuting
 * while deafened also clears deafen, because "I can hear again" is the only sensible reading.
 */
export function setMuted(muted: boolean): void {
  applyMute(muted);
  update({
    muted,
    deafened: muted ? snapshot.deafened : false,
    speaking: muted ? false : snapshot.speaking,
    micLevel: muted ? 0 : snapshot.micLevel,
  });
}

export function toggleMute(): void {
  setMuted(!snapshot.muted);
}

export function setDeafened(deafened: boolean): void {
  if (deafened) {
    mutedBeforeDeafen = snapshot.muted;
    applyMute(true);
    update({ deafened: true, muted: true, speaking: false, micLevel: 0 });
    return;
  }

  applyMute(mutedBeforeDeafen);
  update({ deafened: false, muted: mutedBeforeDeafen });
}

export function toggleDeafen(): void {
  setDeafened(!snapshot.deafened);
}

function stopCamera(): void {
  stopStream(cameraStream);
  cameraStream = null;
  update({ cameraOn: false, cameraStream: null });
}

export async function setCamera(on: boolean): Promise<void> {
  if (snapshot.status !== "connected") return;

  if (!on) {
    if (cameraStream) stopCamera();
    return;
  }
  if (cameraStream) return;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    update({ notice: "Camera capture is not available in this environment." });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
    if (snapshot.status !== "connected") {
      stopStream(stream);
      return;
    }

    cameraStream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      cameraStream = null;
      update({ cameraOn: false, cameraStream: null });
    });
    update({ cameraOn: true, cameraStream: stream, notice: null });
  } catch (error) {
    update({ notice: describe(error) });
  }
}

export function toggleCamera(): void {
  void setCamera(!snapshot.cameraOn);
}

function stopScreen(): void {
  stopStream(screenStream);
  screenStream = null;
  update({ screenSharing: false, screenStream: null });
}

export async function setScreenSharing(on: boolean): Promise<void> {
  if (snapshot.status !== "connected") return;

  if (!on) {
    if (screenStream) stopScreen();
    return;
  }
  if (screenStream) return;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    update({ notice: "Screen sharing is not available in this environment." });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(
      screenConstraints(preferences?.screenQuality ?? "1080p"),
    );
    if (snapshot.status !== "connected") {
      stopStream(stream);
      return;
    }

    screenStream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      screenStream = null;
      update({ screenSharing: false, screenStream: null });
    });
    update({ screenSharing: true, screenStream: stream, notice: null });
  } catch (error) {
    // Cancelling the picker is a normal outcome, not an error worth shouting about.
    if (errorName(error) === "NotAllowedError" || errorName(error) === "AbortError") return;
    update({ notice: describe(error) });
  }
}

export function toggleScreenSharing(): void {
  void setScreenSharing(!snapshot.screenSharing);
}

export function dismissVoiceNotice(): void {
  if (snapshot.notice !== null) update({ notice: null });
}

