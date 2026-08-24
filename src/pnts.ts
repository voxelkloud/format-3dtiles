// `.pnts` — the 3D Tiles 1.0 point cloud tile.
//
// A 28-byte header, a JSON feature table, a binary feature table, and a batch
// table this driver reads nothing from yet. Everything about a POINT is in the
// feature table; the batch table is per-feature metadata, which is a different
// question from "where are the points".
//
// The one decision worth stating up front is where the transform is applied.
// A tile stores its points in its own frame, plus an optional RTC_CENTER, under
// a chain of tile transforms. The neutral contract has ONE origin per cloud and
// ONE model matrix, so the chain is COMPOSED IN FLOAT64 HERE and baked into the
// positions — the same decision Task B7 made for an E57 scan's pose, for the
// same reason: a per-node matrix would undo the arena.

import { VoxelkloudError } from "@voxelkloud/core";
import type { Mat4 } from "./bounds.js";
import type { DecodedTileContent } from "./content.js";

const HEADER_BYTES = 28;
const MAGIC = 0x73_74_6e_70; // "pnts" little-endian

export interface PntsFeatureTable {
  readonly POINTS_LENGTH?: number;
  readonly RTC_CENTER?: readonly number[];
  readonly POSITION?: { readonly byteOffset: number };
  readonly POSITION_QUANTIZED?: { readonly byteOffset: number };
  readonly QUANTIZED_VOLUME_OFFSET?: readonly number[];
  readonly QUANTIZED_VOLUME_SCALE?: readonly number[];
  readonly RGBA?: { readonly byteOffset: number };
  readonly RGB?: { readonly byteOffset: number };
  readonly RGB565?: { readonly byteOffset: number };
  readonly CONSTANT_RGBA?: readonly number[];
  readonly NORMAL?: { readonly byteOffset: number };
  readonly NORMAL_OCT16P?: { readonly byteOffset: number };
  readonly BATCH_ID?: { readonly byteOffset: number; readonly componentType?: string };
  readonly BATCH_LENGTH?: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface PntsHeader {
  readonly version: number;
  readonly byteLength: number;
  readonly featureTable: PntsFeatureTable;
  readonly featureBinary: Uint8Array;
  readonly batchTable: Record<string, unknown>;
  readonly batchBinary: Uint8Array;
}

function fail(code: string, message: string, path?: string): never {
  throw new VoxelkloudError(
    code as never,
    message,
    path !== undefined ? { path } : {},
  );
}

/** Split a `.pnts` into its four sections. Cheap: no point is touched. */
export function readPntsHeader(bytes: Uint8Array, path?: string): PntsHeader {
  if (bytes.byteLength < HEADER_BYTES) {
    fail(
      "invalid-format",
      `A .pnts is at least ${HEADER_BYTES} bytes; got ${bytes.byteLength}.`,
      path,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    fail(
      "invalid-format",
      `Not a .pnts: expected the magic "pnts", got ` +
        `"${String.fromCharCode(...bytes.subarray(0, 4))}".`,
      path,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    fail("unsupported-format", `.pnts version ${version} is not version 1.`, path);
  }
  const byteLength = view.getUint32(8, true);
  const ftJson = view.getUint32(12, true);
  const ftBin = view.getUint32(16, true);
  const btJson = view.getUint32(20, true);
  const btBin = view.getUint32(24, true);

  let at = HEADER_BYTES;
  const decoder = new TextDecoder();
  const readJson = (len: number): Record<string, unknown> => {
    if (len === 0) return {};
    if (at + len > bytes.byteLength) {
      fail(
        "invalid-format",
        `A .pnts section runs past the end of the file: wanted ${len} bytes ` +
          `at ${at}, have ${bytes.byteLength}.`,
        path,
      );
    }
    const text = decoder.decode(bytes.subarray(at, at + len));
    at += len;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail("invalid-format", `A .pnts JSON section did not parse.`, path);
    }
  };
  const readBin = (len: number): Uint8Array => {
    const end = Math.min(at + len, bytes.byteLength);
    const out = bytes.subarray(at, end);
    at += len;
    return out;
  };

  const featureTable = readJson(ftJson) as PntsFeatureTable;
  const featureBinary = readBin(ftBin);
  const batchTable = readJson(btJson);
  const batchBinary = readBin(btBin);

  return { version, byteLength, featureTable, featureBinary, batchTable, batchBinary };
}

export interface DecodePntsOptions {
  /** Composed tile transform, column-major float64. */
  readonly transform: Mat4;
  /** The cloud origin the emitted float32 positions are relative to. */
  readonly origin: readonly [number, number, number];
  /** Skip the colour pass when the renderer did not ask for it. */
  readonly withColor?: boolean;
  readonly path?: string;
}

/** @deprecated Use {@link DecodedTileContent}, which glTF content shares. */
export type DecodedPnts = DecodedTileContent;

/**
 * Decode one `.pnts` into the neutral point arrays.
 *
 * Positions come out RELATIVE to `origin` in float32, which is the contract
 * every other driver here meets and the reason it exists: an ECEF coordinate is
 * 6.4e6 metres, where the float32 ULP is 0.5 m — a tileset drawn in absolute
 * float32 would quantise the planet to half-metre steps.
 */
export function decodePnts(
  bytes: Uint8Array,
  options: DecodePntsOptions,
): DecodedPnts {
  const { featureTable: ft, featureBinary: bin } = readPntsHeader(
    bytes,
    options.path,
  );
  const n = ft.POINTS_LENGTH ?? 0;
  if (!(n >= 0)) {
    fail("invalid-format", `.pnts declares POINTS_LENGTH ${n}.`, options.path);
  }

  // CHECKED FIRST, and the reason is that this file lies about itself. A Draco
  // tile still writes `POSITION: { byteOffset: 0 }` into the feature table as a
  // PLACEHOLDER — the real data is the compressed block the extension names.
  // Reading the placeholder does not fail: it reads the compressed bytes as
  // float32 and produces exactly POINTS_LENGTH plausible garbage points.
  // Measured on Cesium's own `PointCloudDraco`, which is why this is a guard
  // and not a comment.
  const draco = ft.extensions?.["3DTILES_draco_point_compression"];
  if (draco !== undefined) {
    fail(
      "unsupported-format",
      `This .pnts is Draco-compressed (3DTILES_draco_point_compression) and ` +
        `needs a Draco decoder, which this driver does not carry yet. Its ` +
        `feature table declares POSITION at byteOffset 0 as a placeholder, so ` +
        `reading it anyway would yield ${n} points of decompressed noise.`,
      options.path,
    );
  }

  const m = options.transform;
  const [ox, oy, oz] = options.origin;
  const rtc = ft.RTC_CENTER;
  const rtcX = rtc?.[0] ?? 0;
  const rtcY = rtc?.[1] ?? 0;
  const rtcZ = rtc?.[2] ?? 0;

  const positions = new Float32Array(3 * n);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  /** One point, from tile-local through the chain to relative float32. */
  const emit = (i: number, lx: number, ly: number, lz: number): void => {
    // RTC first: it is defined in the tile's own frame, BEFORE the transform.
    const px = lx + rtcX;
    const py = ly + rtcY;
    const pz = lz + rtcZ;
    // float64 throughout: this is the one place absolute coordinates exist.
    const ax = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
    const ay = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
    const az = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (az < minZ) minZ = az;
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
    if (az > maxZ) maxZ = az;
    positions[3 * i] = ax - ox;
    positions[3 * i + 1] = ay - oy;
    positions[3 * i + 2] = az - oz;
  };

  if (ft.POSITION !== undefined) {
    const off = ft.POSITION.byteOffset;
    requireRange(bin, off, 12 * n, "POSITION", options.path);
    // A float32 view needs 4-byte alignment, which a section offset does not
    // guarantee; read through a DataView rather than assume it.
    const dv = new DataView(bin.buffer, bin.byteOffset + off, 12 * n);
    for (let i = 0; i < n; i++) {
      emit(
        i,
        dv.getFloat32(12 * i, true),
        dv.getFloat32(12 * i + 4, true),
        dv.getFloat32(12 * i + 8, true),
      );
    }
  } else if (ft.POSITION_QUANTIZED !== undefined) {
    const off = ft.POSITION_QUANTIZED.byteOffset;
    requireRange(bin, off, 6 * n, "POSITION_QUANTIZED", options.path);
    const qo = ft.QUANTIZED_VOLUME_OFFSET;
    const qs = ft.QUANTIZED_VOLUME_SCALE;
    if (qo === undefined || qs === undefined) {
      fail(
        "invalid-format",
        `.pnts uses POSITION_QUANTIZED without QUANTIZED_VOLUME_OFFSET and ` +
          `QUANTIZED_VOLUME_SCALE; the integers mean nothing without them.`,
        options.path,
      );
    }
    const dv = new DataView(bin.buffer, bin.byteOffset + off, 6 * n);
    // The spec's own formula: the uint16 range maps onto the volume.
    const sx = qs[0]! / 65535;
    const sy = qs[1]! / 65535;
    const sz = qs[2]! / 65535;
    for (let i = 0; i < n; i++) {
      emit(
        i,
        qo[0]! + dv.getUint16(6 * i, true) * sx,
        qo[1]! + dv.getUint16(6 * i + 2, true) * sy,
        qo[2]! + dv.getUint16(6 * i + 4, true) * sz,
      );
    }
  } else {
    fail(
      "invalid-format",
      `.pnts declares neither POSITION nor POSITION_QUANTIZED.`,
      options.path,
    );
  }

  const colors =
    options.withColor === false ? undefined : decodeColors(ft, bin, n, options.path);

  if (n === 0) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }
  const volume =
    Math.max(maxX - minX, 1e-9) *
    Math.max(maxY - minY, 1e-9) *
    Math.max(maxZ - minZ, 1e-9);
  return {
    numPoints: n,
    positions,
    colors,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    pitch: n > 0 ? Math.cbrt(volume / n) : 1,
  };
}

function requireRange(
  bin: Uint8Array,
  offset: number,
  length: number,
  what: string,
  path?: string,
): void {
  if (offset < 0 || offset + length > bin.byteLength) {
    fail(
      "invalid-format",
      `.pnts ${what} wants bytes ${offset}..${offset + length} of a ` +
        `${bin.byteLength}-byte feature table binary.`,
      path,
    );
  }
}

/**
 * Colour, always widened to RGBA.
 *
 * Four spellings and all four are in the spec: RGBA, RGB, RGB565, and one
 * CONSTANT_RGBA for the whole tile. The narrow ones are widened here rather
 * than downstream, because a renderer that had to branch on which spelling a
 * tile used would be a renderer that knows about 3D Tiles.
 */
function decodeColors(
  ft: PntsFeatureTable,
  bin: Uint8Array,
  n: number,
  path?: string,
): Uint8Array | undefined {
  if (ft.RGBA !== undefined) {
    requireRange(bin, ft.RGBA.byteOffset, 4 * n, "RGBA", path);
    // A copy, never a view: the caller's buffer may be detached the instant a
    // worker transfers it.
    return bin.slice(ft.RGBA.byteOffset, ft.RGBA.byteOffset + 4 * n);
  }
  if (ft.RGB !== undefined) {
    const off = ft.RGB.byteOffset;
    requireRange(bin, off, 3 * n, "RGB", path);
    const out = new Uint8Array(4 * n);
    for (let i = 0; i < n; i++) {
      out[4 * i] = bin[off + 3 * i]!;
      out[4 * i + 1] = bin[off + 3 * i + 1]!;
      out[4 * i + 2] = bin[off + 3 * i + 2]!;
      out[4 * i + 3] = 255;
    }
    return out;
  }
  if (ft.RGB565 !== undefined) {
    const off = ft.RGB565.byteOffset;
    requireRange(bin, off, 2 * n, "RGB565", path);
    const dv = new DataView(bin.buffer, bin.byteOffset + off, 2 * n);
    const out = new Uint8Array(4 * n);
    for (let i = 0; i < n; i++) {
      const v = dv.getUint16(2 * i, true);
      // 5/6/5 bits widened so full scale reaches 255 exactly, not 248 or 252 —
      // the same rule the single-file tier applies to 8-bit colour.
      const r = (v >> 11) & 0x1f;
      const g = (v >> 5) & 0x3f;
      const b = v & 0x1f;
      out[4 * i] = (r * 255 + 15) / 31;
      out[4 * i + 1] = (g * 255 + 31) / 63;
      out[4 * i + 2] = (b * 255 + 15) / 31;
      out[4 * i + 3] = 255;
    }
    return out;
  }
  if (ft.CONSTANT_RGBA !== undefined) {
    const c = ft.CONSTANT_RGBA;
    const out = new Uint8Array(4 * n);
    for (let i = 0; i < n; i++) {
      out[4 * i] = c[0] ?? 255;
      out[4 * i + 1] = c[1] ?? 255;
      out[4 * i + 2] = c[2] ?? 255;
      out[4 * i + 3] = c[3] ?? 255;
    }
    return out;
  }
  return undefined;
}

/** Which unsupported extensions a tile declares, for a warning worth reading. */
export function pntsExtensions(ft: PntsFeatureTable): string[] {
  return Object.keys(ft.extensions ?? {});
}
