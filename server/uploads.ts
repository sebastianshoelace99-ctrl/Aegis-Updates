import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  type FileAttachment,
} from "../shared/messages";
import { HttpError } from "./errors";

/**
 * Attachment storage: one metadata sidecar per upload, one content-addressed blob per distinct
 * file.
 *
 * Two decisions worth stating, because both are visible from the outside:
 *
 *  1. **Bytes go to disk, not to the database.** A 100 MB attachment in a `bytea` column would
 *     make every `select *` on `messages` a disaster; PostgREST would happily do it. The message
 *     row only ever stores the small JSON record.
 *  2. **The blob name is its SHA-256.** Uploading the same 80 MB video twice costs one copy on
 *     disk while each upload keeps its own id, name and uploader. Removing an upload is
 *     deliberately not implemented yet: without reference counting it would delete bytes another
 *     message still points at.
 */

export type StoredUpload = FileAttachment & {
  /** Hex digest of the bytes; also the blob's file name. */
  sha256: string;
  authorId: string;
  createdAt: string;
};

export type UploadHandle = {
  upload: StoredUpload;
  blobPath: string;
};

export type UploadStore = {
  readonly dir: string;
  save(
    req: IncomingMessage,
    meta: { name: string; mime: string; authorId: string },
  ): Promise<UploadHandle>;
  find(id: string): Promise<UploadHandle | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bars control characters and path separators: a name is a label, never a path. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "file").slice(0, 200);
}

function safeMime(raw: string): string {
  const value = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)) return "application/octet-stream";
  return value.slice(0, 160);
}

/** A request that announced a body larger than the cap is refused before it is read. */
function declaredLength(req: IncomingMessage): number | null {
  const raw = req.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const tooLarge = (): HttpError =>
  new HttpError(
    413,
    `That file is too large. Attachments are limited to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
  );


export function createUploadStore(dir: string): UploadStore {
  let ready: Promise<void> | null = null;

  const ensure = (): Promise<void> => {
    ready ??= mkdir(join(dir, ".incoming"), { recursive: true }).then(() => undefined);
    return ready;
  };

  const blobPathOf = (sha256: string): string => join(dir, sha256);
  const metaPathOf = (id: string): string => join(dir, `${id}.json`);

  const readMeta = async (id: string): Promise<StoredUpload | null> => {
    if (!UUID.test(id)) return null;

    let text: string;
    try {
      text = await readFile(metaPathOf(id), "utf8");
    } catch {
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }

    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const { size, sha256 } = record;
    if (
      typeof record.name !== "string" ||
      typeof record.mime !== "string" ||
      typeof size !== "number" ||
      typeof sha256 !== "string" ||
      typeof record.authorId !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      return null;
    }

    return {
      kind: "file",
      uploadId: id,
      name: record.name,
      mime: record.mime,
      size,
      sha256,
      authorId: record.authorId,
      createdAt: record.createdAt,
    };
  };

  return {
    dir,

    async save(req, meta) {
      await ensure();

      const declared = declaredLength(req);
      if (declared !== null && declared > MAX_ATTACHMENT_BYTES) throw tooLarge();

      const id = randomUUID();
      const tmp = join(dir, ".incoming", `${id}.part`);
      const hash = createHash("sha256");
      let size = 0;
      let exceeded = false;

      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > MAX_ATTACHMENT_BYTES) {
            exceeded = true;
            callback(new Error("attachment too large"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(req, meter, createWriteStream(tmp));
      } catch {
        await rm(tmp, { force: true });
        if (exceeded) throw tooLarge();
        throw new HttpError(400, "The upload was interrupted.");
      }

      if (size === 0) {
        await rm(tmp, { force: true });
        throw new HttpError(400, "That file is empty.");
      }

      const sha256 = hash.digest("hex");
      const blobPath = blobPathOf(sha256);

      try {
        // `rename` onto an existing blob fails on Windows; that just means the bytes are already
        // here, so the temporary copy is discarded instead.
        await rename(tmp, blobPath);
      } catch {
        await rm(tmp, { force: true });
        // The discard is only safe if the blob really is there. A permission failure would
        // otherwise produce a record pointing at nothing, which reads as a 404 later.
        try {
          const info = await stat(blobPath);
          if (!info.isFile()) throw new Error("not a file");
        } catch {
          throw new HttpError(500, "That upload could not be stored on disk.");
        }
      }

      const upload: StoredUpload = {
        kind: "file",
        uploadId: id,
        name: safeFileName(meta.name),
        mime: safeMime(meta.mime),
        size,
        sha256,
        authorId: meta.authorId,
        createdAt: new Date().toISOString(),
      };

      await writeFile(`${metaPathOf(id)}.tmp`, JSON.stringify(upload), "utf8");
      await rename(`${metaPathOf(id)}.tmp`, metaPathOf(id));

      return { upload, blobPath };
    },

    async find(id) {
      await ensure();
      const upload = await readMeta(id);
      if (!upload) return null;

      const blobPath = blobPathOf(upload.sha256);
      try {
        const info = await stat(blobPath);
        if (!info.isFile()) return null;
      } catch {
        return null;
      }

      return { upload, blobPath };
    },
  };
}


/**
 * A read stream for one byte interval. `end` is inclusive, matching the HTTP `Range` header, so
 * the HTTP layer can decide between a 200 and a 206 without duplicating the arithmetic.
 */
export function openUpload(
  handle: UploadHandle,
  range?: { start: number; end: number },
): ReadStream {
  return createReadStream(handle.blobPath, range ? { start: range.start, end: range.end } : {});
}

/** `bytes=0-1023` -> `{start, end}`; `undefined` when absent; `"invalid"` when unusable. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix range: the last N bytes.
    const length = Number.parseInt(rawEnd ?? "", 10);
    if (!Number.isFinite(length) || length <= 0) return "invalid";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}
