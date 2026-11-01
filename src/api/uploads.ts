import { fileAttachmentSchema, type FileAttachment } from "../../shared/messages";
import { getSelfId } from "../state/identity";
import { getToken } from "../state/session";
import { API_BASE, API_KEY } from "./http";

/**
 * Attachment transport.
 *
 * `XMLHttpRequest` rather than `fetch` for one reason: `fetch` cannot report upload progress, and
 * a 100 MB file with no progress bar is indistinguishable from a hung app. The request body is
 * the raw file, not multipart: there is exactly one file per request, so a multipart parser on the
 * server would be pure overhead.
 */

export function uploadUrl(uploadId: string): string {
  return `${API_BASE}/api/uploads/${encodeURIComponent(uploadId)}`;
}

/** Same URL, but with `Content-Disposition: attachment` forced by the server. */
export function downloadUrl(uploadId: string): string {
  return `${uploadUrl(uploadId)}?download=1`;
}

export type UploadTask = {
  promise: Promise<FileAttachment>;
  /** Removing a queued file should also stop spending bandwidth on it. */
  abort: () => void;
};

function failureMessage(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return `The upload failed (${status}).`;
}

export function uploadAttachment(
  file: File,
  onProgress: (ratio: number) => void,
): UploadTask {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<FileAttachment>((resolve, reject) => {
    xhr.open("POST", `${API_BASE}/api/uploads`);
    xhr.responseType = "json";
    xhr.setRequestHeader("x-aegis-user", getSelfId());
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    if (API_KEY) xhr.setRequestHeader("x-aegis-key", API_KEY);
    // Percent-encoded: a header is not a place to put a Unicode file name.
    xhr.setRequestHeader("x-aegis-filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });

    xhr.addEventListener("error", () => {
      reject(new Error("The upload could not reach the backend."));
    });
    xhr.addEventListener("abort", () => {
      reject(new Error("Upload cancelled."));
    });
    xhr.addEventListener("load", () => {
      const body = xhr.response as unknown;
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(failureMessage(xhr.status, body)));
        return;
      }

      const attachment =
        body && typeof body === "object" && "attachment" in body
          ? (body as { attachment: unknown }).attachment
          : undefined;
      const parsed = fileAttachmentSchema.safeParse(attachment);
      if (!parsed.success) {
        reject(new Error("The backend returned an attachment record that could not be read."));
        return;
      }
      resolve(parsed.data);
    });

    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}
