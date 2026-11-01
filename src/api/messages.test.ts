import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentSchema,
  fetchMessages,
  flattenPages,
  formatBytes,
  mentionedHandles,
  messageSchema,
  sendMessage,
  type FileAttachment,
  type Message,
} from "./messages";

const channelId = "fixture/general";

function messageAt(index: number, body = `Message ${index}`): Message {
  return {
    id: `m-${index}`,
    channelId,
    authorId: "nyx",
    body,
    createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, index)).toISOString(),
    kind: "user",
    attachments: [],
    mentions: [],
    replyToId: null,
    editedAt: null,
    reactions: [],
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("message API", () => {
  it("requests an encoded channel path with the cursor and limit", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond([messageAt(1)]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchMessages({
      channelId,
      before: "2026-10-20T10:00:05.000Z",
      limit: 20,
    });

    expect(page).toHaveLength(1);
    expect(page[0]?.id).toBe("m-1");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/channels/fixture%2Fgeneral/messages");
    expect(url).toContain("before=2026-10-20T10%3A00%3A05.000Z");
    expect(url).toContain("limit=20");
  });

  it("starts at the newest page when no cursor is given", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMessages({ channelId });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain("before=");
  });

  it("rejects a malformed row instead of rendering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond([{ ...messageAt(1), body: "" }])),
    );

    await expect(fetchMessages({ channelId })).rejects.toThrow();
  });

  it("flattens newest-chunk-first pages oldest-first", () => {
    const newest = [messageAt(3), messageAt(4)];
    const older = [messageAt(1), messageAt(2)];

    const flat = flattenPages([newest, older]);
    expect(flat.map((message) => message.id)).toEqual(["m-1", "m-2", "m-3", "m-4"]);
  });

  it("parses mentions case-insensitively without duplicates", () => {
    expect(mentionedHandles("@nyx and @Nyx and @Sable")).toEqual(["nyx", "sable"]);
    expect(mentionedHandles("no mentions here")).toEqual([]);
  });

  it("posts a trimmed body as the signed-in author", async () => {
    const sent = messageAt(9, "Shipping this one tonight.");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond(sent, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessage(channelId, "  Shipping this one tonight.  ");
    expect(result.id).toBe("m-9");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "Shipping this one tonight.",
      attachments: [],
    });
    // The author is decided by the server from `x-aegis-user`, never by the caller.
    const headers = new Headers(init?.headers);
    expect(headers.get("x-aegis-user")).toBe("nyx");
  });

  it("fails loudly on bad input without a round trip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMessage(channelId, "   ")).rejects.toThrow(/empty/);
    await expect(sendMessage(channelId, "x".repeat(4_001))).rejects.toThrow(/4000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the message schema strict about the fields the feed relies on", () => {
    expect(messageSchema.safeParse(messageAt(1)).success).toBe(true);
    expect(messageSchema.safeParse({ ...messageAt(1), createdAt: "" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...messageAt(1), kind: "bot" }).success).toBe(false);
  });
});

const fileAttachment: FileAttachment = {
  kind: "file",
  uploadId: "3f1c0a52-0000-4000-8000-000000000001",
  name: "plate-final.png",
  mime: "image/png",
  size: 2_048,
};

describe("file attachments", () => {
  it("allows a message that is only a file", () => {
    const parsed = messageSchema.safeParse({
      ...messageAt(1),
      body: "",
      attachments: [fileAttachment],
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a message with neither text nor files", () => {
    expect(messageSchema.safeParse({ ...messageAt(1), body: "", attachments: [] }).success).toBe(
      false,
    );
  });

  it("caps one attachment at the advertised 100 MB", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
    expect(
      attachmentSchema.safeParse({ ...fileAttachment, size: MAX_ATTACHMENT_BYTES }).success,
    ).toBe(true);
    expect(
      attachmentSchema.safeParse({ ...fileAttachment, size: MAX_ATTACHMENT_BYTES + 1 }).success,
    ).toBe(false);
  });

  it("upgrades a legacy artwork attachment that predates the discriminator", () => {
    const legacy = {
      artworkId: "a-1",
      title: "Harbour at dusk",
      thumb: "thumb.svg",
      display: "display.svg",
      width: 800,
      height: 600,
    };

    const parsed = messageSchema.safeParse({ ...messageAt(1), attachments: [legacy] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.attachments[0]?.kind).toBe("artwork");
  });

  it("sends upload ids, never client-supplied names or types", async () => {
    const sent = { ...messageAt(1), body: "", attachments: [fileAttachment] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond(sent, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMessage(channelId, "", [fileAttachment]);
    expect(result.attachments).toHaveLength(1);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "",
      attachments: [{ uploadId: fileAttachment.uploadId }],
    });
  });

  it("formats sizes for both the composer and the feed", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(0)).toBe("0 B");
  });
});
