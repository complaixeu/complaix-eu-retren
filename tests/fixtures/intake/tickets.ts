/**
 * Placeholder upload files for domain A (A1, reused by A3). Neutral, not real tickets
 * (docs/plans/README.md §3): only the leading "magic bytes" matter, so each file is that
 * signature plus a marker. They are built here instead of committed as binaries, so no image or
 * PDF lands in git.
 */
const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
  );

/** A real 1×1 grey PNG, so browsers can draw the preview thumbnail. */
export const PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A JPEG signature (SOI + APP0 "JFIF") and a marker; not a drawable image. */
export const PLACEHOLDER_JPEG = bytes(
  [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
  "JFIF\0",
  "placeholder-ticket",
);

/** A minimal PDF header and a marker. */
export const PLACEHOLDER_PDF = bytes("%PDF-1.4\n% placeholder-ticket\n%%EOF\n");

/** An ISO-BMFF `ftyp` box with major brand `heic` (what iPhones write) and a marker. */
export const PLACEHOLDER_HEIC = bytes(
  [0x00, 0x00, 0x00, 0x18],
  "ftypheic",
  [0x00, 0x00, 0x00, 0x00],
  "mif1heic",
  "placeholder-ticket",
);

/** A generic HEIF (`mif1`) that lists `heic` as a compatible brand, as some Android phones write. */
export const PLACEHOLDER_HEIF_MIF1 = bytes(
  [0x00, 0x00, 0x00, 0x18],
  "ftypmif1",
  [0x00, 0x00, 0x00, 0x00],
  "mif1heic",
  "placeholder-ticket",
);

/** An AVIF (`avif` brand, `mif1` compatible): HEIF-shaped but not HEIC, so not accepted. */
export const PLACEHOLDER_AVIF = bytes(
  [0x00, 0x00, 0x00, 0x18],
  "ftypavif",
  [0x00, 0x00, 0x00, 0x00],
  "mif1avif",
  "placeholder-ticket",
);

/** Plain text: a wrong type whatever its name says. */
export const PLACEHOLDER_TEXT = bytes("placeholder-ticket: this is not an image\n");

/** A GIF: an image, but not one of the accepted types. */
export const PLACEHOLDER_GIF = bytes("GIF89a", [0x01, 0x00, 0x01, 0x00], "placeholder");

/** `size` bytes that start like a PNG: valid type, used for the size limit. */
export function placeholderPngOfSize(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(PLACEHOLDER_PNG.subarray(0, Math.min(size, PLACEHOLDER_PNG.length)));
  return out;
}
