import { useEffect, useRef } from "react";
import { findChannelById, guildOfChannel } from "../../api/workspace";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useVoice } from "../../state/useVoice";
import { leaveVoice, setMuted } from "../../state/voiceSession";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { MicGlyph, MicOffGlyph, PhoneOffGlyph } from "../../ui/Glyphs";
import styles from "./Voice.module.css";

/**
 * The persistent "Voice Connected" strip in the channel column.
 *
 * It is rendered outside the voice route on purpose: a call survives navigation, so its only
 * always-visible surface has to survive it too. Clicking the strip returns to the stage.
 */
export function VoiceStatus(): React.JSX.Element | null {
  const voice = useVoice();
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const live = useLiveWorkspace();

  if (voice.status !== "connected" || !voice.channelId) return null;

  const channel = findChannelById(live, voice.channelId);
  const guild = guildOfChannel(live, voice.channelId);

  return (
    <div className={styles.status} data-testid="voice-status">
      <button
        type="button"
        className={styles.statusMain}
        onClick={() => openChannel(voice.channelId as string)}
        title="Open the voice channel"
      >
        <span className={styles.statusSignal} data-active={voice.speaking} aria-hidden="true" />
        <span className={styles.statusText}>
          <strong>Voice Connected</strong>
          <span>
            {channel?.name ?? "voice"} · {guild?.name ?? "server"}
          </span>
        </span>
      </button>

      <div className={styles.statusActions}>
        <button
          type="button"
          className={styles.statusButton}
          onClick={() => setMuted(!voice.muted)}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          title={voice.muted ? "Unmute" : "Mute"}
        >
          {voice.muted ? <MicOffGlyph /> : <MicGlyph />}
        </button>
        <button
          type="button"
          className={styles.statusButton}
          onClick={leaveVoice}
          aria-label="Disconnect from voice"
          title="Disconnect"
        >
          <PhoneOffGlyph />
        </button>
      </div>
    </div>
  );
}
