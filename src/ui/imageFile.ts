/**
 * Decode, crop and downscale a chosen image to a data URL.
 *
 * The file never leaves the renderer: `FileReader`/`createImageBitmap` are web APIs, so profile
 * pictures and banners do not need a fourth preload channel. Cropping to a fixed aspect ratio is
 * what keeps a 4000x6000 phone photo from becoming a 30 MB localStorage entry.
 */

export type ImageTarget = { width: number; height: number; quality?: number };

export const AVATAR_TARGET: ImageTarget = { width: 160, height: 160, quality: 0.86 };
export const BANNER_TARGET: ImageTarget = { width: 640, height: 200, quality: 0.82 };

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Must stay below the schema's cap, otherwise a valid upload would be rejected on reload. */
export const MAX_OUTPUT_CHARS = 850_000;

function formatLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function readImageFile(file: File, target: ImageTarget): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file (PNG, JPEG or WebP).");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Choose an image under ${formatLimit(MAX_UPLOAD_BYTES)}.`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file could not be read as an image.");
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is not available in this environment.");

    // Cover-crop: fill the target, centre the overflow, never letterbox.
    const scale = Math.max(target.width / bitmap.width, target.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (target.width - width) / 2,
      (target.height - height) / 2,
      width,
      height,
    );

    const dataUrl = canvas.toDataURL("image/webp", target.quality ?? 0.85);
    if (dataUrl.length > MAX_OUTPUT_CHARS) {
      throw new Error("That image is too detailed to store. Try a simpler one.");
    }
    return dataUrl;
  } finally {
    bitmap.close();
  }
}
