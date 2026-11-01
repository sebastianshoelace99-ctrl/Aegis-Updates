import { useSyncExternalStore } from "react";
import { subscribeVoice, voiceSnapshot, type VoiceSnapshot } from "./voiceSession";

/**
 * The call, as React sees it. The session outlives every route; this hook only subscribes to the
 * snapshot, so navigating to a text channel does not drop the call or re-request the microphone.
 */
export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(subscribeVoice, voiceSnapshot);
}
