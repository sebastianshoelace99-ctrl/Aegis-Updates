import type { VoicePreferences } from "../api/profile";
import {
  heartbeatVoiceChannel,
  joinVoiceChannel,
  leaveVoiceChannel,
  sendVoiceSignal,
} from "../api/backend";
import type { VoiceSignal } from "../../shared/events";
import { getSelfId } from "./identity";
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
 * The backend relays bounded WebRTC signaling only; peer media travels directly between
 * participants. This session owns capture, remote peers and connection cleanup across routes.
 */

export type VoiceStatus = "idle" | "connecting" | "connected" | "error";
export type RemoteVoicePeer = { memberId: string; streams: MediaStream[] };

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
  remotePeers: RemoteVoicePeer[];
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
  remotePeers: [],
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
let registeredChannelId: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let iceServers: RTCIceServer[] = [];

type PeerState = {
  connection: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
};

const peerConnections = new Map<string, PeerState>();
const pendingVoicePeerIds = new Set<string>();
const pendingVoiceSignals: Array<{ memberId: string; signal: VoiceSignal }> = [];

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
    let micAvailable = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(next),
      });
      if (token !== generation) {
        stopStream(stream);
        return;
      }
      audioStream = stream;
      micAvailable = true;
      applyMute(snapshot.muted || snapshot.deafened);
      attachAnalyser(stream, next.sensitivity);
    } catch (error) {
      const name = errorName(error);
      const missingDevice =
        name === "NotFoundError" ||
        name === "DevicesNotFoundError" ||
        name === "OverconstrainedError";
      if (!missingDevice) throw error;
      update({
        micAvailable: false,
        notice: "No microphone was found. You joined to listen, and can still share a screen.",
      });
    }

    const joined = await joinVoiceChannel(channelId);
    if (token !== generation) {
      await leaveVoiceChannel(channelId).catch((error: unknown) => {
        console.warn("[aegis] could not leave a voice channel after a cancelled join", error);
      });
      return;
    }
    registeredChannelId = channelId;
    iceServers = joined.iceServers;
    for (const peerId of [...new Set([...joined.peers, ...pendingVoicePeerIds])]) {
      createPeerConnection(peerId);
    }
    pendingVoicePeerIds.clear();
    heartbeat = setInterval(() => {
      void heartbeatVoiceChannel(channelId).catch((error: unknown) => {
        update({
          notice: error instanceof Error ? error.message : "The voice session lost its connection.",
        });
      });
    }, 20_000);
    update({ status: "connected", micAvailable });
    for (const pending of pendingVoiceSignals.splice(0)) {
      void handleVoiceSignal(channelId, pending.memberId, pending.signal);
    }
  } catch (error) {
    if (token !== generation) return;
    if (registeredChannelId === channelId) registeredChannelId = null;
    void leaveVoiceChannel(channelId).catch((leaveError: unknown) => {
      console.warn("[aegis] could not clean up a failed voice join", leaveError);
    });
    for (const peer of peerConnections.values()) peer.connection.close();
    peerConnections.clear();
    pendingVoicePeerIds.clear();
    pendingVoiceSignals.length = 0;
    stopStream(audioStream);
    audioStream = null;
    stopAnalyser();
    update({ channelId: null, status: "error", error: describe(error), micAvailable: false });
  }
}

export function leaveVoice(): void {
  const channelId = registeredChannelId;
  registeredChannelId = null;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const peer of peerConnections.values()) peer.connection.close();
  peerConnections.clear();
  pendingVoicePeerIds.clear();
  pendingVoiceSignals.length = 0;
  iceServers = [];
  if (channelId) {
    void leaveVoiceChannel(channelId).catch((error: unknown) => {
      console.warn("[aegis] could not disconnect from voice", error);
    });
  }
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

function localTrackEntries(): Array<[MediaStreamTrack, MediaStream]> {
  const entries: Array<[MediaStreamTrack, MediaStream]> = [];
  for (const stream of [audioStream, cameraStream, screenStream]) {
    if (!stream) continue;
    for (const track of stream.getTracks()) {
      entries.push([track, stream]);
    }
  }
  return entries;
}

function syncPeerTracks(peer: PeerState): void {
  const desired = localTrackEntries();
  const senders = peer.connection.getSenders();
  for (const [track, stream] of desired) {
    if (!senders.some((sender) => sender.track?.id === track.id)) {
      peer.connection.addTrack(track, stream);
    }
  }
  for (const sender of senders) {
    if (sender.track && !desired.some(([track]) => track.id === sender.track?.id)) {
      peer.connection.removeTrack(sender);
    }
  }
}

function syncAllPeerTracks(): void {
  for (const peer of peerConnections.values()) syncPeerTracks(peer);
}

function reportSignalingFailure(error: unknown): void {
  update({
    notice:
      error instanceof Error
        ? `Voice connection problem: ${error.message}`
        : "Voice connection problem. Check your network and try again.",
  });
}

function sendSignal(memberId: string, signal: VoiceSignal): void {
  const channelId = snapshot.channelId;
  if (!channelId) return;
  void sendVoiceSignal(channelId, memberId, signal).catch(reportSignalingFailure);
}

function publishRemotePeer(memberId: string, stream: MediaStream): void {
  const peers = new Map(snapshot.remotePeers.map((peer) => [peer.memberId, peer]));
  const current = peers.get(memberId) ?? { memberId, streams: [] };
  if (!current.streams.some((entry) => entry.id === stream.id)) {
    peers.set(memberId, { ...current, streams: [...current.streams, stream] });
  }
  update({ remotePeers: [...peers.values()] });
}

function closePeerConnection(memberId: string): void {
  const peer = peerConnections.get(memberId);
  if (peer) {
    peer.connection.ontrack = null;
    peer.connection.onicecandidate = null;
    peer.connection.onnegotiationneeded = null;
    peer.connection.onconnectionstatechange = null;
    peer.connection.close();
    peerConnections.delete(memberId);
  }
  update({ remotePeers: snapshot.remotePeers.filter((peer) => peer.memberId !== memberId) });
}

function createPeerConnection(memberId: string): PeerState | null {
  const existing = peerConnections.get(memberId);
  if (existing) return existing;
  if (typeof RTCPeerConnection !== "function") {
    update({ notice: "WebRTC is not available in this environment." });
    return null;
  }

  const connection = new RTCPeerConnection({ iceServers });
  const peer: PeerState = {
    connection,
    polite: getSelfId().localeCompare(memberId) > 0,
    makingOffer: false,
    ignoreOffer: false,
    pendingCandidates: [],
  };
  peerConnections.set(memberId, peer);
  syncPeerTracks(peer);

  connection.onicecandidate = (event) => {
    if (!event.candidate) return;
    const candidate = event.candidate.toJSON();
    sendSignal(memberId, {
      type: "candidate",
      candidate: candidate.candidate ?? "",
      ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
      ...(candidate.sdpMLineIndex !== undefined
        ? { sdpMLineIndex: candidate.sdpMLineIndex }
        : {}),
      ...(candidate.usernameFragment !== undefined
        ? { usernameFragment: candidate.usernameFragment }
        : {}),
    });
  };

  connection.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    publishRemotePeer(memberId, stream);
  };

  connection.onnegotiationneeded = () => {
    void (async () => {
      try {
        peer.makingOffer = true;
        if (connection.signalingState !== "stable") return;
        await connection.setLocalDescription(await connection.createOffer());
        const description = connection.localDescription;
        if (
          description?.sdp &&
          description.type !== "pranswer" &&
          description.type !== "rollback"
        ) {
          sendSignal(memberId, {
            type: "description",
            sdpType: description.type,
            sdp: description.sdp,
          });
        }
      } catch (error) {
        reportSignalingFailure(error);
      } finally {
        peer.makingOffer = false;
      }
    })();
  };

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed") {
      closePeerConnection(memberId);
      update({ notice: "A peer connection failed. They may need to rejoin the call." });
    }
  };

  return peer;
}

export function handleVoicePeer(channelId: string, memberId: string, joined: boolean): void {
  if (
    channelId !== snapshot.channelId ||
    (snapshot.status !== "connected" && snapshot.status !== "connecting")
  ) {
    return;
  }
  if (snapshot.status === "connecting") {
    if (joined) pendingVoicePeerIds.add(memberId);
    else pendingVoicePeerIds.delete(memberId);
  } else if (joined) {
    createPeerConnection(memberId);
  } else {
    closePeerConnection(memberId);
  }
}

export async function handleVoiceSignal(
  channelId: string,
  memberId: string,
  signal: VoiceSignal,
): Promise<void> {
  if (channelId !== snapshot.channelId || snapshot.status === "idle" || snapshot.status === "error") {
    return;
  }
  if (snapshot.status === "connecting") {
    pendingVoiceSignals.push({ memberId, signal });
    return;
  }
  const peer = createPeerConnection(memberId);
  if (!peer) return;
  const connection = peer.connection;

  try {
    if (signal.type === "candidate") {
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate,
        ...(signal.sdpMid !== undefined ? { sdpMid: signal.sdpMid } : {}),
        ...(signal.sdpMLineIndex !== undefined ? { sdpMLineIndex: signal.sdpMLineIndex } : {}),
        ...(signal.usernameFragment !== undefined
          ? { usernameFragment: signal.usernameFragment }
          : {}),
      };
      if (!connection.remoteDescription) peer.pendingCandidates.push(candidate);
      else if (!peer.ignoreOffer) await connection.addIceCandidate(candidate);
      return;
    }

    const offerCollision =
      signal.sdpType === "offer" &&
      (peer.makingOffer || connection.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    if (offerCollision && peer.polite) {
      await connection.setLocalDescription({ type: "rollback" });
    }
    await connection.setRemoteDescription({ type: signal.sdpType, sdp: signal.sdp });
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }

    if (signal.sdpType === "offer") {
      await connection.setLocalDescription(await connection.createAnswer());
      const description = connection.localDescription;
      if (description?.sdp) {
        sendSignal(memberId, { type: "description", sdpType: "answer", sdp: description.sdp });
      }
    }
  } catch (error) {
    if (!peer.ignoreOffer) reportSignalingFailure(error);
  }
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
  syncAllPeerTracks();
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
      syncAllPeerTracks();
      update({ cameraOn: false, cameraStream: null });
    });
    syncAllPeerTracks();
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
  syncAllPeerTracks();
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
      syncAllPeerTracks();
      update({ screenSharing: false, screenStream: null });
    });
    syncAllPeerTracks();
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
