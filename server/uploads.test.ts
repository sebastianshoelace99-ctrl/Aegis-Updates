import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../shared/messages";
import {
  createUploadStore,
  parseRange,
  safeFileName,
  type UploadStore,
} from "./uploads";

/**
 * The upload store, tested against a real temporary directory.
 *
 * These are the properties the HTTP layer depends on and cannot check on its own: ids are
 * opaque, names are labels rather than paths, the size cap is enforced before the bytes land,
 * and identical content is stored once.
 */

const dirs: string[] = [];

async function makeStore(): Promise<UploadStore> {
  const dir = await mkdtemp(join(tmpdir(), "aegis-upload-test-"));
  dirs.push(dir);
  return createUploadStore(dir);
}

/** The smallest thing `pipeline` and `uploads.save` need: a readable with headers. */
function fakeRequest(bytes: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(bytes.length > 0 ? [bytes] : []) as unknown as IncomingMessage;
  stream.headers = { "content-length": String(bytes.length), ...headers };
  return stream;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("upload store", () => {
  it("stores bytes, returns a file record and can read them back", async () => {
    const store = await makeStore();
    const body = Buffer.from("Aegis Shield attachment payload", "utf8");

    const saved = await store.save(fakeRequest(body), {
      name: "brief.txt",
      mime: "text/plain; charset=utf-8",
      authorId: "nyx",
    });

    expect(saved.upload).toMatchObject({
      kind: "file",
      name: "brief.txt",
      mime: "text/plain",
      size: body.byteLength,
      authorId: "nyx",
    });
    expect(saved.upload.uploadId).toMatch(/^[0-9a-f-]{36}$/);

    const found = await store.find(saved.upload.uploadId);
    expect(found?.blobPath).toBe(saved.blobPath);
    expect((await readFile(saved.blobPath)).toString("utf8")).toBe(body.toString("utf8"));
  });

  it("stores identical content once but keeps one record per upload", async () => {
    const store = await makeStore();
    const body = Buffer.from("same bytes", "utf8");

    const first = await store.save(fakeRequest(body), {
      name: "a.txt",
      mime: "text/plain",
      authorId: "nyx",
    });
    const second = await store.save(fakeRequest(body), {
      name: "b.txt",
      mime: "text/plain",
      authorId: "nyx",
    });

    expect(second.blobPath).toBe(first.blobPath);
    expect(second.upload.uploadId).not.toBe(first.upload.uploadId);
    expect(second.upload.name).toBe("b.txt");
  });

  it("refuses an empty file and an over-limit declaration", async () => {
    const store = await makeStore();

    await expect(
      store.save(fakeRequest(Buffer.alloc(0)), {
        name: "empty.bin",
        mime: "application/octet-stream",
        authorId: "nyx",
      }),
    ).rejects.toThrow(/empty/i);

    await expect(
      store.save(
        fakeRequest(Buffer.from("x"), {
          "content-length": String(MAX_ATTACHMENT_BYTES + 1),
        }),
        { name: "huge.bin", mime: "application/octet-stream", authorId: "nyx" },
      ),
    ).rejects.toThrow(/too large/i);
  });

  it("answers null for an unknown or malformed id", async () => {
    const store = await makeStore();
    expect(await store.find("not-a-uuid")).toBeNull();
    expect(await store.find("3f1c0a52-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("file names and ranges", () => {
  it("treats a file name as a label, never a path", () => {
    expect(safeFileName("C:\\Users\\Nyx\\plate.png")).toBe("plate.png");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("a\u0000b.png")).toBe("ab.png");
  });

  it("parses the range forms a media element actually sends", () => {
    expect(parseRange(undefined, 1_000)).toBeUndefined();
    expect(parseRange("bytes=0-99", 1_000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
    // An end past the file is clamped rather than rejected: players ask for it.
    expect(parseRange("bytes=0-9999", 1_000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=1000-", 1_000)).toBe("invalid");
    expect(parseRange("bytes=9-2", 1_000)).toBe("invalid");
    expect(parseRange("items=0-1", 1_000)).toBe("invalid");
  });
});
