import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequestHandler } from "./app";
import { EventBus } from "./bus";
import { createMemoryStore } from "./store";
import { createUploadStore } from "./uploads";

/**
 * Reactions over the real handler, not the store.
 *
 * The pure function is covered in `shared/reactions.test.ts`; this is the seam a client actually
 * touches - routing, identity, validation and the JSON shape. A unit test of `toggleReaction` would
 * stay green if the route were registered at the wrong segment count, which is exactly the kind of
 * mistake a URL with three variable parts invites.
 */

let server: Server;
let base: string;
let channelId: string;
let messageId: string;

const SELF = "nyx";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aegis-user": SELF },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const store = createMemoryStore();
  const uploads = createUploadStore(join(tmpdir(), `aegis-reactions-${process.pid}`));

  const created = await store.createGuild({
    name: "Reaction Lab",
    accent: 3,
    templateId: "custom",
    ownerId: SELF,
    ownerName: "Nyx",
    ownerHandle: SELF,
  });

  const channel = created.workspace.guilds
    .flatMap((guild) => guild.channels)
    .find((entry) => entry.kind === "text");
  if (!channel) throw new Error("the fixture guild has no text channel");
  channelId = channel.id;

  const message = await store.createMessage(channelId, SELF, "hello", []);
  messageId = message.id;

  server = createServer(
    createRequestHandler({ store, bus: new EventBus(), apiKey: "", uploads }),
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /api/channels/:id/messages/:id/reactions", () => {
  it("adds a super reaction and answers with the whole message", async () => {
    const response = await post(
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji: "🔥", burst: true },
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      id: string;
      reactions: Array<{ emoji: string; userIds: string[]; burst: boolean }>;
    };

    // The whole row, so a retrying caller can see which way its toggle landed.
    expect(body.id).toBe(messageId);
    expect(body.reactions).toEqual([{ emoji: "🔥", userIds: [SELF], burst: true }]);
  });

  it("removes it again when the same member toggles twice", async () => {
    const response = await post(
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji: "🔥" },
    );

    const body = (await response.json()) as { reactions: unknown[] };
    expect(response.status).toBe(200);
    expect(body.reactions).toEqual([]);
  });

  it("rejects an empty emoji instead of storing a blank pill", async () => {
    const response = await post(
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji: "   " },
    );

    expect(response.status).toBe(400);
  });

  it("answers 404 for a message that is not in that channel", async () => {
    const response = await post(
      `/api/channels/${encodeURIComponent(channelId)}/messages/does-not-exist/reactions`,
      { emoji: "🔥" },
    );

    expect(response.status).toBe(404);
  });
});
