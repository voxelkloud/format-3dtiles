// Implicit tiling: the `.subtree` file, and the arithmetic that turns a tile
// coordinate into a bit.
//
// The plan predicted this would ride on `createPagedOctree` in core — a fourth
// spelling of the page model Potree, COPC and EPT share. It does not, for two
// reasons that are geometry rather than taste:
//
//   1. A QUADTREE halves X and Y and leaves Z whole. That engine's node bounds
//      come from halving a CUBE on all three axes, and there is no way to say
//      "two axes only" to it.
//   2. An implicit tileset subdivides its root BOUNDING VOLUME, which may be an
//      oriented box or an ellipsoidal region. Halving an OBB happens in the
//      box's own frame; halving a region happens in longitude and latitude.
//      Neither is halving an axis-aligned cube.
//
// So the structure stays here, where the volume type is known. What DOES carry
// over is the shape of the idea: a page names the nodes it holds and points at
// the pages holding the rest, and `childSubtreeAvailability` is that pointer.

import { VoxelkloudError } from "@voxelkloud/core";

export type SubdivisionScheme = "QUADTREE" | "OCTREE";

const MAGIC = 0x74_62_75_73; // "subt" little-endian
const HEADER_BYTES = 24;

interface AvailabilityJson {
  readonly constant?: number;
  readonly bitstream?: number;
  /** 1.0's extension spelling, still written by some tools. */
  readonly bufferView?: number;
  readonly availableCount?: number;
}

interface SubtreeJson {
  readonly buffers?: readonly { readonly uri?: string; readonly byteLength?: number }[];
  readonly bufferViews?: readonly {
    readonly buffer?: number;
    readonly byteOffset?: number;
    readonly byteLength?: number;
  }[];
  readonly tileAvailability?: AvailabilityJson;
  readonly contentAvailability?: readonly AvailabilityJson[] | AvailabilityJson;
  readonly childSubtreeAvailability?: AvailabilityJson;
}

/**
 * One resolved availability channel: a constant, or a run of bits.
 *
 * A CLOSED representation on purpose. The spec lets a channel be "all
 * available" or "none available" without spending a byte, and a sparse tileset
 * uses that for most of its subtrees — turning those into a materialised
 * bitstream would allocate megabytes to say "no".
 */
export type Availability =
  | { readonly kind: "constant"; readonly value: boolean }
  | { readonly kind: "bits"; readonly bytes: Uint8Array };

export interface Subtree {
  readonly scheme: SubdivisionScheme;
  readonly subtreeLevels: number;
  /** Children per node: 4 for a quadtree, 8 for an octree. */
  readonly branching: 4 | 8;
  /** Whether the tile at `(levelInSubtree, morton)` exists. */
  isTileAvailable(levelInSubtree: number, morton: number): boolean;
  /** Whether it has content. `which` selects among 1.1's several contents. */
  isContentAvailable(levelInSubtree: number, morton: number, which?: number): boolean;
  /** Whether a further subtree hangs below the node at `morton` on the bottom level. */
  isChildSubtreeAvailable(morton: number): boolean;
  /** How many contents the subtree declares availability for. */
  readonly contentCount: number;
}

function fail(message: string, path?: string): never {
  throw new VoxelkloudError(
    "invalid-metadata",
    message,
    path !== undefined ? { path } : {},
  );
}

/**
 * Bit `i` of an availability bitstream.
 *
 * LSB FIRST within each byte, which is the spec's order and the opposite of how
 * a bitstream is usually drawn on a page. Reading it MSB-first does not fail —
 * it silently returns a different, plausible set of available tiles.
 */
function bitAt(bytes: Uint8Array, i: number): boolean {
  const byte = bytes[i >> 3];
  if (byte === undefined) return false;
  return ((byte >> (i & 7)) & 1) === 1;
}

function readAvailability(
  json: AvailabilityJson | undefined,
  views: readonly Uint8Array[],
  what: string,
  path?: string,
): Availability {
  if (json === undefined) return { kind: "constant", value: false };
  if (json.constant !== undefined) {
    return { kind: "constant", value: json.constant !== 0 };
  }
  const view = json.bitstream ?? json.bufferView;
  if (view === undefined) {
    return { kind: "constant", value: false };
  }
  const bytes = views[view];
  if (bytes === undefined) {
    fail(
      `The subtree's ${what} names bufferView ${view}, which the file does ` +
        `not have.`,
      path,
    );
  }
  return { kind: "bits", bytes };
}

function get(a: Availability, i: number): boolean {
  return a.kind === "constant" ? a.value : bitAt(a.bytes, i);
}

/**
 * The bit index of `(levelInSubtree, morton)` in a tile-availability bitstream.
 *
 * Level-order: every node of level 0, then every node of level 1, and so on,
 * with the nodes of one level in Morton order. So the offset of a level is the
 * number of nodes above it, which for branching `b` is `(b^L - 1) / (b - 1)`.
 */
export function availabilityIndex(
  branching: 4 | 8,
  levelInSubtree: number,
  morton: number,
): number {
  const offset = (branching ** levelInSubtree - 1) / (branching - 1);
  return offset + morton;
}

/** Interleave two coordinates, 2 bits per level. */
export function morton2(x: number, y: number): number {
  let m = 0;
  for (let b = 0; b < 16; b++) {
    m |= ((x >> b) & 1) << (2 * b);
    m |= ((y >> b) & 1) << (2 * b + 1);
  }
  return m >>> 0;
}

/** Interleave three coordinates, 3 bits per level. */
export function morton3(x: number, y: number, z: number): number {
  let m = 0;
  for (let b = 0; b < 10; b++) {
    m += ((x >> b) & 1) * 2 ** (3 * b);
    m += ((y >> b) & 1) * 2 ** (3 * b + 1);
    m += ((z >> b) & 1) * 2 ** (3 * b + 2);
  }
  return m;
}

/** The Morton code of a tile at its own level, for either scheme. */
export function mortonOf(
  scheme: SubdivisionScheme,
  x: number,
  y: number,
  z: number,
): number {
  return scheme === "QUADTREE" ? morton2(x, y) : morton3(x, y, z);
}

export interface ReadSubtreeOptions {
  readonly scheme: SubdivisionScheme;
  readonly subtreeLevels: number;
  readonly path?: string;
}

/**
 * Parse one `.subtree`.
 *
 * A 24-byte header, a JSON chunk and a binary chunk — the same container shape
 * as a GLB, and deliberately so.
 *
 * EXTERNAL BUFFERS are refused by name rather than ignored. A buffer with a
 * `uri` lives in another file, and a reader that skipped it would report a
 * sparse tileset as empty: every availability bit it could not read would come
 * back false, and the result looks like a tileset with nothing in it rather
 * than like an error.
 */
export function readSubtree(
  bytes: Uint8Array,
  options: ReadSubtreeOptions,
): Subtree {
  const { scheme, subtreeLevels, path } = options;
  const branching = scheme === "QUADTREE" ? 4 : 8;

  if (bytes.byteLength < HEADER_BYTES) {
    fail(
      `A .subtree is at least ${HEADER_BYTES} bytes; got ${bytes.byteLength}.`,
      path,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) {
    fail(
      `Not a .subtree: expected the magic "subt", got ` +
        `"${String.fromCharCode(...bytes.subarray(0, 4))}".`,
      path,
    );
  }
  const version = dv.getUint32(4, true);
  if (version !== 1) {
    fail(`.subtree version ${version} is not version 1.`, path);
  }
  // 64-bit lengths, because the format allows a subtree larger than 4 GiB. Read
  // as BigInt and narrowed, so a length that genuinely does not fit is an error
  // rather than a silent truncation.
  const jsonLength = Number(dv.getBigUint64(8, true));
  const binaryLength = Number(dv.getBigUint64(16, true));
  if (!Number.isSafeInteger(jsonLength) || !Number.isSafeInteger(binaryLength)) {
    fail(`.subtree declares a chunk length this runtime cannot address.`, path);
  }
  if (HEADER_BYTES + jsonLength > bytes.byteLength) {
    fail(
      `.subtree declares a ${jsonLength}-byte JSON chunk but the file is ` +
        `${bytes.byteLength} bytes.`,
      path,
    );
  }

  let json: SubtreeJson;
  try {
    json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonLength)),
    ) as SubtreeJson;
  } catch {
    return fail(`.subtree JSON chunk did not parse.`, path);
  }

  const binary = bytes.subarray(
    HEADER_BYTES + jsonLength,
    HEADER_BYTES + jsonLength + binaryLength,
  );

  for (const [i, buffer] of (json.buffers ?? []).entries()) {
    if (buffer.uri !== undefined) {
      fail(
        `.subtree buffer ${i} lives in an external file (${buffer.uri}). This ` +
          `driver reads the internal binary chunk only. Reading it as empty ` +
          `would report every tile as unavailable, which looks like an empty ` +
          `tileset rather than like a missing file.`,
        path,
      );
    }
  }

  const views: Uint8Array[] = [];
  for (const [i, view] of (json.bufferViews ?? []).entries()) {
    const offset = view.byteOffset ?? 0;
    const length = view.byteLength ?? 0;
    if (offset + length > binary.byteLength) {
      fail(
        `.subtree bufferView ${i} wants bytes ${offset}..${offset + length} ` +
          `of a ${binary.byteLength}-byte binary chunk.`,
        path,
      );
    }
    views.push(binary.subarray(offset, offset + length));
  }

  const tiles = readAvailability(json.tileAvailability, views, "tileAvailability", path);
  const rawContent = json.contentAvailability;
  const contentList = Array.isArray(rawContent)
    ? rawContent
    : rawContent !== undefined
      ? [rawContent as AvailabilityJson]
      : [];
  const contents = contentList.map((c, i) =>
    readAvailability(c, views, `contentAvailability[${i}]`, path),
  );
  const children = readAvailability(
    json.childSubtreeAvailability,
    views,
    "childSubtreeAvailability",
    path,
  );

  return {
    scheme,
    subtreeLevels,
    branching,
    contentCount: contents.length,
    isTileAvailable(levelInSubtree, morton) {
      if (levelInSubtree < 0 || levelInSubtree >= subtreeLevels) return false;
      return get(tiles, availabilityIndex(branching, levelInSubtree, morton));
    },
    isContentAvailable(levelInSubtree, morton, which = 0) {
      const channel = contents[which];
      if (channel === undefined) return false;
      if (levelInSubtree < 0 || levelInSubtree >= subtreeLevels) return false;
      return get(channel, availabilityIndex(branching, levelInSubtree, morton));
    },
    isChildSubtreeAvailable(morton) {
      // Indexed over the level BELOW the subtree's last, so it is a plain
      // Morton index rather than a level-order one.
      return get(children, morton);
    },
  };
}

/**
 * Fill a `{level}/{x}/{y}/{z}` template.
 *
 * `{z}` is left alone for a quadtree rather than filled with 0: a quadtree
 * template does not contain it, and substituting into one that does would
 * invent a path.
 */
export function fillTemplate(
  template: string,
  level: number,
  x: number,
  y: number,
  z: number | undefined,
): string {
  let out = template
    .replaceAll("{level}", String(level))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
  if (z !== undefined) out = out.replaceAll("{z}", String(z));
  return out;
}
