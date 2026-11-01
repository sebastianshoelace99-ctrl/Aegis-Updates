import {
  buildGuild,
  createServerInputSchema,
  type CreateServerInput,
} from "../../shared/guildFactory";
import { createGuild } from "./backend";
import { liveWorkspace, replaceWorkspace } from "./liveWorkspace";
import { guildSchema, type Guild } from "./workspace";

/**
 * `POST /api/guilds`.
 *
 * Creating a server is the only write that changes the shape of the workspace, so it goes through
 * the same validation the backend uses: a created guild cannot have a category that does not
 * exist, a channel outside its own guild, or an initial the avatar cannot draw. Everything the UI
 * needs is derived from the shared factory - id, slug, the first channel, the roster - instead of
 * being assembled at the call site, because a second caller would assemble it differently.
 *
 * The backend is authoritative: it resolves the id against *its* guild list, then answers with the
 * whole workspace. That reply is what the rail renders, so two windows cannot disagree.
 */

export * from "../../shared/guildFactory";

export async function createServer(input: CreateServerInput): Promise<Guild> {
  const parsed = createServerInputSchema.parse(input);

  // Validated locally first, so an obvious mistake fails before the round trip. The server
  // re-derives the id against its own guild list and its answer is what gets installed.
  buildGuild(
    parsed,
    liveWorkspace().guilds.map((guild) => guild.id),
  );

  const reply = await createGuild(parsed);
  const guild = guildSchema.parse(reply.guild);
  replaceWorkspace(reply.workspace);
  return guild;
}
