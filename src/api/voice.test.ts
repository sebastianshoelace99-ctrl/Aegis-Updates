import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE } from "./profile";
import {
  LEVEL_SEGMENTS,
  audioConstraints,
  deviceLabel,
  isSpeaking,
  levelBucket,
  screenConstraints,
  speakingThresholdDb,
} from "./voice";

describe("voice helpers", () => {
  it("only pins a device when one was chosen", () => {
    expect(audioConstraints(DEFAULT_VOICE).deviceId).toBeUndefined();

    const pinned = audioConstraints({ ...DEFAULT_VOICE, inputDeviceId: "mic-42" });
    expect(pinned.deviceId).toEqual({ exact: "mic-42" });
    expect(pinned.noiseSuppression).toBe(true);
  });

  it("maps amplitude onto a stable twelve-segment meter", () => {
    expect(levelBucket(0)).toBe(0);
    expect(levelBucket(Number.NaN)).toBe(0);
    expect(levelBucket(1)).toBe(LEVEL_SEGMENTS);

    const quiet = levelBucket(0.01);
    const loud = levelBucket(0.4);
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(LEVEL_SEGMENTS);
  });

  it("lowers the threshold as sensitivity rises", () => {
    expect(speakingThresholdDb(100)).toBeLessThan(speakingThresholdDb(50));
    expect(speakingThresholdDb(50)).toBeLessThan(speakingThresholdDb(0));
    expect(speakingThresholdDb(150)).toBe(speakingThresholdDb(100));
  });

  it("decides audibility from RMS and sensitivity", () => {
    expect(isSpeaking(0.5, 50)).toBe(true);
    expect(isSpeaking(0.0001, 50)).toBe(false);
    expect(isSpeaking(0, 100)).toBe(false);
    expect(isSpeaking(0.02, 100)).toBe(true);
  });

  it("asks for a fixed height tier or the native source", () => {
    expect(screenConstraints("source").video).toBe(true);

    const hd = screenConstraints("720p").video;
    expect(hd).toMatchObject({ height: { ideal: 720 } });
  });

  it("gives an unlabelled device a usable name", () => {
    expect(deviceLabel("", 0, "Microphone")).toBe("Microphone 1");
    expect(deviceLabel("  USB Mic  ", 1, "Microphone")).toBe("USB Mic");
  });
});
