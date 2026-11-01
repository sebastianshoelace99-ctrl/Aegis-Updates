/**
 * Main-process view of the channel names. Re-exported, not redefined: there is exactly one
 * definition (shared/channels.ts) and this file exists so main-side code imports from
 * `electron/channels` and never reaches into `shared/` with a guessed path.
 */
export { Channel, Push } from "../shared/channels";
export type { ChannelName, PushChannel } from "../shared/channels";
