import { workspaceSchema, type Workspace } from "../../shared/domain";

/**
 * The renderer's view of the workspace.
 *
 * The graph itself lives in `shared/domain.ts`, because the backend validates writes with the
 * same schemas the UI parses replies with. This file only owns the *boot* value.
 *
 * There is no seeded workspace any more. The app starts empty and fills itself from
 * `GET /api/workspace`; a first launch showing invented servers was the thing this module
 * existed to make obvious. `liveWorkspace()` in `./liveWorkspace` is the value the UI reads.
 */
export * from "../../shared/domain";

/** What the app renders before the backend answers. Structurally valid, intentionally empty. */
export const workspace: Workspace = workspaceSchema.parse({ guilds: [], members: [] });
