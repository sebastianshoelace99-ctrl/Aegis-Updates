import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { mulberry32 } from "./rng";

/**
 * The server tier, mocked. Shapes, validation and latency are real; only the transport is
 * local, so swapping this file for `fetch("/api/gallery")` changes nothing downstream.
 *
 * Three image sizes per asset (docs/02 section 8): `blur` (placeholder), `thumb` (grid) and
 * `display` (inspector only). The grid must never request `display`.
 */

export const artworkSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  status: z.enum(["brief", "sketch", "review", "revision", "delivered"]),
  updatedAt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  art: z.object({
    blur: z.string(),
    thumb: z.string(),
    display: z.string(),
  }),
});

export type Artwork = z.infer<typeof artworkSchema>;

const listSchema = z.array(artworkSchema);

const VARIANTS = 24;
const COUNT = 240;

const ARTISTS = ["Nyx", "Kestrel", "Aurelio", "Mira", "Halden", "Osei", "Vale"];
const ADJECTIVES = ["Quiet", "Hollow", "Amber", "Static", "Distant", "Copper", "Winter", "Patient"];
const NOUNS = ["Harbour", "Figure", "Interval", "Meridian", "Signal", "Threshold", "Garden", "Relay"];
const STATUSES: Artwork["status"][] = ["brief", "sketch", "review", "revision", "delivered"];
const RATIOS: ReadonlyArray<readonly [number, number]> = [
  [4, 3],
  [1, 1],
  [3, 4],
  [16, 9],
];

/** `1` -> `"01"`. Variant file names are zero-padded to match the generator's output. */
function twoDigits(value: number): string {
  return String(value + 1).padStart(2, "0");
}

function mockArtworks(): Artwork[] {
  const rand = mulberry32(0xa3615);

  return Array.from({ length: COUNT }, (_, index) => {
    const variant = index % VARIANTS;
    const [width, height] = RATIOS[index % RATIOS.length] ?? [4, 3];
    const stamp = Date.UTC(2026, 8, 1 + (index % 27), 9 + (index % 9), (index * 7) % 60);

    return {
      id: `art_${String(index + 1).padStart(3, "0")}`,
      title: `${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[(index * 3) % NOUNS.length]} ${String(index + 1).padStart(3, "0")}`,
      artist: ARTISTS[Math.floor(rand() * ARTISTS.length)] ?? "Nyx",
      status: STATUSES[index % STATUSES.length] ?? "brief",
      updatedAt: new Date(stamp).toISOString(),
      width,
      height,
      art: {
        blur: `/art/blur-${twoDigits(variant)}.svg`,
        thumb: `/art/thumb-${twoDigits(variant)}.svg`,
        display: `/art/display-${twoDigits(variant)}.svg`,
      },
    };
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchArtworks(): Promise<Artwork[]> {
  await delay(140); // a real amount of latency, so skeletons are exercised every launch
  return listSchema.parse(mockArtworks()); // validate at the edge, always
}

export const galleryQuery = queryOptions({
  queryKey: ["gallery"],
  queryFn: fetchArtworks,
  staleTime: 30_000,
});
