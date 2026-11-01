import { useEffect, useRef } from "react";
import { findChannelById, guildMembers, guildOfChannel } from "../../api/workspace";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useSettingsStore } from "../../state/settingsStore";
import { useUiStore } from "../../state/uiStore";
import type { VoiceSnapshot } from "../../state/voiceSession";
import { useVoice } from "../../state/useVoice";
import {
  dismissVoiceNotice,
  joinVoice,
  leaveVoice,
  setCamera,
  setDeafened,
  setMuted,
  setScreenSharing,
} from "../../state/voiceSession";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import {
  HeadphonesGlyph,
  HeadphonesOffGlyph,
  MicGlyph,
  MicOffGlyph,
  PhoneOffGlyph,
  ScreenGlyph,
  SettingsGlyph,
  SpeakerGlyph,
  VideoGlyph,
  VideoOffGlyph,
} from "../../ui/Glyphs";
import styles from "./Voice.module.css";

/**
 * The voice channel stage.
 *
 * The call itself lives in `voiceSession`, not here, so switching to a text channel and back does
 * not drop it. What this route owns is presentation and the control bar.
 *
 * There are no remote peers until a signaling server exists, and the UI says so instead of
 * pretending: what is real is local capture, mute/deafen, the speaking ring, camera preview and
 * screen capture. Those are the parts a peer connection would consume unchanged.
 */

export function VoiceRoute(): React.JSX.Element | null {
  const channelId = useWorkspaceStore((state) => state.channelId);
  const live = useLiveWorkspace();
  const voice = useVoice();
  const voiceSettings = useSettingsStore((state) => state.voice);
  const profile = useSettingsStore((state) => state.profile);
  const openSettings = useUiStore((state) => state.openSettings);

  const channel = findChannelById(live, channelId);
  if (!channel) return null;

  const guild = guildOfChannel(live, channel.id);
  const connectedHere = voice.channelId === channel.id && voice.status === "connected";
  const connecting = voice.channelId === channel.id && voice.status === "connecting";
  const elsewhere =
    voice.channelId !== null && voice.channelId !== channel.id && voice.status === "connected";
  const roster = guild ? guildMembers(live, guild) : [];
  const online = roster.filter((member) => member.presence !== "offline").length;

  return (
    <div className={styles.route} data-testid="voice-stage">
      <div className={styles.stage}>
        {connectedHere ? (
          <ConnectedStage voice={voice} name={profile.displayName} avatar={profile.avatar} accent={profile.accent} />
        ) : (
          <div className={styles.hero}>
            <span className={styles.heroMark} aria-hidden="true">
              <SpeakerGlyph />
            </span>
            <h2 className={styles.heroTitle}>#{channel.name}</h2>
            <p className={styles.heroBody}>{channel.topic}</p>
            <p className={styles.heroMeta}>
              {online} online in {guild?.name ?? "this server"} · the microphone is only captured
              after you join
            </p>

            {voice.error ? (
              <p className={styles.error} role="alert">
                {voice.error}
              </p>
            ) : null}

            <div className={styles.heroActions}>
              <button
                type="button"
                className={styles.join}
                data-testid="join-voice"
                disabled={connecting}
                onClick={() => void joinVoice(channel.id, voiceSettings)}
              >
                <MicGlyph />
                {connecting ? "Connecting…" : elsewhere ? "Move to this channel" : "Join Voice"}
              </button>

              {elsewhere ? (
                <button type="button" className={styles.ghost} onClick={leaveVoice}>
                  Disconnect
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {voice.notice ? (
        <div className={styles.notice} role="status">
          <span>{voice.notice}</span>
          <button type="button" className={styles.noticeClose} onClick={dismissVoiceNotice}>
            Dismiss
          </button>
        </div>
      ) : null}

      {connectedHere ? <Controls voice={voice} onSettings={() => openSettings("voice")} /> : null}
    </div>
  );
}

function ConnectedStage({
  voice,
  name,
  avatar,
  accent,
}: {
  voice: VoiceSnapshot;
  name: string;
  avatar: string | null;
  accent: number;
}): React.JSX.Element {
  return (
    <>
      {voice.screenStream ? (
        <div className={styles.screenTile}>
          <VoiceVideo stream={voice.screenStream} label="Your shared screen" muted />
          <span className={styles.tileLabel}>You are sharing your screen</span>
        </div>
      ) : null}

      <div className={styles.tiles}>
        {voice.cameraStream ? (
          <div className={styles.cameraTile}>
            <VoiceVideo stream={voice.cameraStream} label="Your camera" muted mirror />
            <span className={styles.tileLabel}>You</span>
          </div>
        ) : (
          <div className={styles.selfTile} data-speaking={voice.speaking}>
            <Avatar name={name} accent={accent} size="xl" image={avatar} />
            <strong>{name}</strong>
            <span>{voice.micAvailable ? (voice.muted ? "Muted" : "Microphone on") : "Listening"}</span>
          </div>
        )}

        <div className={styles.emptyTile}>
          <SpeakerGlyph />
          <strong>No one else is here yet</strong>
          <span>
            Invite someone from the member list. Calls become peer-to-peer once signaling lands.
          </span>
        </div>
      </div>
    </>
  );
}

function Controls({
  voice,
  onSettings,
}: {
  voice: VoiceSnapshot;
  onSettings: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.controls} data-testid="voice-controls">
      <div className={styles.meter} aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <span key={index} data-on={!voice.muted && index < voice.micLevel} />
        ))}
      </div>

      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.control}
          data-on={!voice.muted}
          data-alert={voice.muted}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          title={voice.muted ? "Unmute" : "Mute"}
          onClick={() => setMuted(!voice.muted)}
          disabled={!voice.micAvailable}
        >
          {voice.muted ? <MicOffGlyph /> : <MicGlyph />}
        </button>

        <button
          type="button"
          className={styles.control}
          data-on={!voice.deafened}
          data-alert={voice.deafened}
          aria-pressed={voice.deafened}
          aria-label={voice.deafened ? "Undeafen" : "Deafen"}
          title={voice.deafened ? "Undeafen" : "Deafen"}
          onClick={() => setDeafened(!voice.deafened)}
        >
          {voice.deafened ? <HeadphonesOffGlyph /> : <HeadphonesGlyph />}
        </button>

        <button
          type="button"
          className={styles.control}
          data-on={voice.cameraOn}
          aria-pressed={voice.cameraOn}
          aria-label={voice.cameraOn ? "Turn camera off" : "Turn camera on"}
          title={voice.cameraOn ? "Camera off" : "Camera on"}
          onClick={() => void setCamera(!voice.cameraOn)}
        >
          {voice.cameraOn ? <VideoGlyph /> : <VideoOffGlyph />}
        </button>

        <button
          type="button"
          className={styles.control}
          data-on={voice.screenSharing}
          aria-pressed={voice.screenSharing}
          aria-label={voice.screenSharing ? "Stop sharing screen" : "Share screen"}
          title={voice.screenSharing ? "Stop sharing" : "Share screen"}
          onClick={() => void setScreenSharing(!voice.screenSharing)}
        >
          <ScreenGlyph />
        </button>

        <button
          type="button"
          className={styles.control}
          aria-label="Voice and video settings"
          title="Voice & Video settings"
          onClick={onSettings}
        >
          <SettingsGlyph />
        </button>

        <button
          type="button"
          className={`${styles.control} ${styles.leave}`}
          aria-label="Disconnect from voice"
          title="Disconnect"
          onClick={leaveVoice}
          data-testid="leave-voice"
        >
          <PhoneOffGlyph />
        </button>
      </div>
    </div>
  );
}

function VoiceVideo({
  stream,
  label,
  muted = false,
  mirror = false,
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  mirror?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.srcObject = stream;
    void element.play().catch(() => undefined);

    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={ref}
      className={styles.video}
      data-mirror={mirror}
      autoPlay
      playsInline
      muted={muted}
      aria-label={label}
    />
  );
}

