// glTF point content — the shape 3D Tiles 1.1 recommends and `.pnts` is being
// retired in favour of.
//
// Structurally it is the opposite of a `.pnts`. There the feature table names a
// semantic and gives a byte offset, and that is the whole indirection. Here a
// primitive names an ACCESSOR, which names a BUFFER VIEW, which names a BUFFER,
// and each layer can add an offset, a stride and a component type. The payload
// is the same points; the addressing is four levels deep and every level is a
// place to be off by one.
//
// Two things are easy to get wrong and neither one fails loudly:
//
//   * glTF is Y-UP and 3D Tiles is Z-UP. The spec says the content is rotated,
//     and a reader that skips it draws the cloud lying on its side — which for
//     a scan of a building looks like data, not like a bug.
//   * An accessor may be INTERLEAVED with others in one buffer view, so the
//     step between two points is the view's `byteStride` and not the size of
//     the element. Reading them packed gives the right count of plausible
//     points, all wrong.

import { VoxelkloudError } from "@voxelkloud/core";
import type { Mat4 } from "./bounds.js";
import type { DecodedTileContent } from "./content.js";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** glTF primitive modes. Only POINTS carries what this driver wants. */
const MODE_POINTS = 0;

const COMPONENT = {
  5120: { size: 1, max: 127, read: "getInt8" },
  5121: { size: 1, max: 255, read: "getUint8" },
  5122: { size: 2, max: 32767, read: "getInt16" },
  5123: { size: 2, max: 65535, read: "getUint16" },
  5125: { size: 4, max: 4294967295, read: "getUint32" },
  5126: { size: 4, max: 1, read: "getFloat32" },
} as const;

type ComponentType = keyof typeof COMPONENT;

const TYPE_COUNT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

interface Accessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType?: number;
  readonly normalized?: boolean;
  readonly count?: number;
  readonly type?: string;
  readonly min?: readonly number[];
  readonly max?: readonly number[];
  readonly sparse?: unknown;
}

interface BufferView {
  readonly buffer?: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
  readonly byteStride?: number;
}

interface Primitive {
  readonly attributes?: Readonly<Record<string, number>>;
  readonly mode?: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

interface GltfNode {
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}

export interface GltfJson {
  readonly asset?: { readonly version?: string };
  readonly scene?: number;
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly { readonly primitives?: readonly Primitive[] }[];
  readonly accessors?: readonly Accessor[];
  readonly bufferViews?: readonly BufferView[];
  readonly buffers?: readonly { readonly uri?: string; readonly byteLength?: number }[];
  readonly extensionsRequired?: readonly string[];
  readonly extensionsUsed?: readonly string[];
}

function fail(code: string, message: string, path?: string): never {
  throw new VoxelkloudError(
    code as never,
    message,
    path !== undefined ? { path } : {},
  );
}

export interface Glb {
  readonly json: GltfJson;
  /** The BIN chunk. Empty when the document had none. */
  readonly binary: Uint8Array;
}

/**
 * Split a `.glb`, or parse a `.gltf`.
 *
 * Both spellings arrive in the wild — the Cesium samples ship `.gltf` with a
 * sibling `.bin` for some tilesets and `.glb` for others — and the difference
 * is only where the binary lives.
 */
export function readGltf(bytes: Uint8Array, path?: string): Glb {
  if (bytes.byteLength >= 12) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) === GLB_MAGIC) {
      const version = dv.getUint32(4, true);
      if (version !== 2) {
        fail("unsupported-format", `GLB version ${version} is not version 2.`, path);
      }
      let json: GltfJson | undefined;
      let binary: Uint8Array = new Uint8Array(0);
      let at = 12;
      while (at + 8 <= bytes.byteLength) {
        const length = dv.getUint32(at, true);
        const type = dv.getUint32(at + 4, true);
        const start = at + 8;
        const end = Math.min(start + length, bytes.byteLength);
        if (type === CHUNK_JSON && json === undefined) {
          try {
            json = JSON.parse(
              new TextDecoder().decode(bytes.subarray(start, end)),
            ) as GltfJson;
          } catch {
            fail("invalid-format", `The GLB's JSON chunk did not parse.`, path);
          }
        } else if (type === CHUNK_BIN && binary.byteLength === 0) {
          binary = bytes.subarray(start, end);
        }
        at = start + length;
      }
      if (json === undefined) fail("invalid-format", `The GLB has no JSON chunk.`, path);
      return { json, binary };
    }
  }
  // Not a GLB: a plain `.gltf` document.
  try {
    return {
      json: JSON.parse(new TextDecoder().decode(bytes)) as GltfJson,
      binary: new Uint8Array(0),
    };
  } catch {
    return fail("invalid-format", `Not a GLB and not JSON, so not a glTF.`, path);
  }
}

/** Decode a `data:` URI's base64 payload. */
function decodeDataUri(uri: string): Uint8Array | undefined {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) return undefined;
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (!meta.includes("base64")) {
    const text = new TextEncoder().encode(decodeURIComponent(payload));
    const copy = new Uint8Array(new ArrayBuffer(text.byteLength));
    copy.set(text);
    return copy;
  }
  const decoded = atob(payload);
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

/** Column-major 4x4 from a node's TRS, the order glTF specifies. */
function nodeMatrix(node: GltfNode): number[] {
  if (node.matrix !== undefined && node.matrix.length >= 16) {
    return node.matrix.slice(0, 16) as number[];
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // Quaternion to a rotation matrix, then scale the columns and set the
  // translation — T * R * S, which is the order glTF mandates.
  const x2 = qx! + qx!;
  const y2 = qy! + qy!;
  const z2 = qz! + qz!;
  const xx = qx! * x2;
  const xy = qx! * y2;
  const xz = qx! * z2;
  const yy = qy! * y2;
  const yz = qy! * z2;
  const zz = qz! * z2;
  const wx = qw! * x2;
  const wy = qw! * y2;
  const wz = qw! * z2;
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function multiply(b: readonly number[], a: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        b[r]! * a[c * 4]! +
        b[4 + r]! * a[c * 4 + 1]! +
        b[8 + r]! * a[c * 4 + 2]! +
        b[12 + r]! * a[c * 4 + 3]!;
    }
  }
  return out;
}

/**
 * Y-up to Z-up, which 3D Tiles applies to every glTF content.
 *
 * `(x, y, z)` becomes `(x, -z, y)`. Column-major, and the one rotation a reader
 * cannot skip: without it the cloud lies on its side, and a scan on its side
 * looks like data rather than like a bug.
 */
export const Y_UP_TO_Z_UP: readonly number[] = [
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
];

/** Every primitive with POINTS, and the world matrix that places it. */
function collectPointPrimitives(
  json: GltfJson,
  path?: string,
): Array<{ primitive: Primitive; matrix: readonly number[] }> {
  const out: Array<{ primitive: Primitive; matrix: readonly number[] }> = [];
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const sceneIndex = json.scene ?? 0;
  const roots =
    json.scenes?.[sceneIndex]?.nodes ?? nodes.map((_, i) => i).filter((i) => i === 0);

  const seen = new Set<number>();
  const walk = (index: number, parent: readonly number[]): void => {
    // A cycle is malformed and would hang; a node visited twice legitimately
    // (shared subtree) is rare enough that refusing the second visit costs
    // nothing a point cloud tile would notice.
    if (seen.has(index)) return;
    seen.add(index);
    const node = nodes[index];
    if (node === undefined) return;
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of meshes[node.mesh]?.primitives ?? []) {
        if ((primitive.mode ?? 4) !== MODE_POINTS) continue;
        out.push({ primitive, matrix });
      }
    }
    for (const child of node.children ?? []) walk(child, matrix);
  };
  for (const root of roots) walk(root, Y_UP_TO_Z_UP);

  if (out.length === 0) {
    // Named rather than silent: a mesh tile is legal 3D Tiles and simply not
    // this driver's business, and "drew nothing" is the worst way to say so.
    fail(
      "unsupported-format",
      `This glTF has no primitive with mode 0 (POINTS). 3D Tiles content that ` +
        `is a mesh is legal and this driver reads point clouds only.`,
      path,
    );
  }
  return out;
}

interface Reader {
  readonly count: number;
  readonly components: number;
  read(index: number, component: number): number;
}

/** Resolve one accessor into a random-access reader over its elements. */
function accessorReader(
  json: GltfJson,
  index: number,
  buffers: readonly (Uint8Array | undefined)[],
  path?: string,
  forColor = false,
): Reader {
  const accessor = json.accessors?.[index];
  if (accessor === undefined) {
    fail("invalid-format", `The glTF has no accessor ${index}.`, path);
  }
  if (accessor.sparse !== undefined) {
    fail(
      "unsupported-format",
      `Accessor ${index} is sparse. Sparse accessors are a legal glTF feature ` +
        `this driver does not implement; the points it would substitute are ` +
        `exactly the ones that would silently be wrong if it guessed.`,
      path,
    );
  }
  const componentType = accessor.componentType as ComponentType | undefined;
  const component = componentType !== undefined ? COMPONENT[componentType] : undefined;
  if (component === undefined) {
    fail("invalid-format", `Accessor ${index} has componentType ` +
      `${String(accessor.componentType)}, which is not a glTF component type.`, path);
  }
  const components = TYPE_COUNT[accessor.type ?? ""] ?? 0;
  if (components === 0) {
    fail("invalid-format", `Accessor ${index} has type ${String(accessor.type)}.`, path);
  }
  const count = accessor.count ?? 0;

  const viewIndex = accessor.bufferView;
  if (viewIndex === undefined) {
    // A bufferView-less accessor is all zeroes by the spec. Legal, and useless
    // as a position, so it is only tolerable for colour.
    return { count, components, read: () => 0 };
  }
  const view = json.bufferViews?.[viewIndex];
  if (view === undefined) {
    fail("invalid-format", `The glTF has no bufferView ${viewIndex}.`, path);
  }
  const bufferIndex = view.buffer ?? 0;
  const binary = buffers[bufferIndex];
  if (binary === undefined) {
    fail(
      "invalid-format",
      `bufferView ${viewIndex} reads buffer ${bufferIndex}, which was not ` +
        `resolved. A glTF with an external \`.bin\` needs it fetched before ` +
        `the decode; see \`externalBufferUris\`.`,
      path,
    );
  }

  const elementSize = component.size * components;
  // THE STRIDE. Zero or absent means tightly packed; anything else means the
  // accessor is interleaved with others and the step is the view's, not the
  // element's. Reading interleaved data as packed yields the right COUNT of
  // plausible points, every one of them wrong.
  const stride = view.byteStride !== undefined && view.byteStride > 0
    ? view.byteStride
    : elementSize;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const needed = count === 0 ? 0 : base + stride * (count - 1) + elementSize;
  if (needed > binary.byteLength) {
    fail(
      "invalid-format",
      `Accessor ${index} needs ${needed} bytes of a ${binary.byteLength}-byte ` +
        `binary chunk.`,
      path,
    );
  }

  const dv = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const read = component.read;
  // `normalized` is a claim the file makes, and files get it wrong in the one
  // direction that matters. glTF does not allow an unnormalised integer
  // COLOR_0 — a colour is 0..1 — so an integer accessor feeding colour is
  // normalised whatever the flag says. py3dtiles writes `normalized: false` on
  // a ubyte COLOR_0, and reading that literally turns every channel above 1
  // into full scale: a cloud of saturated white, which looks like a lighting
  // bug rather than a decode one.
  const integer = componentType !== 5126;
  const normalized = integer && (accessor.normalized === true || forColor);
  const scale = normalized ? 1 / component.max : 1;
  return {
    count,
    components,
    read(i, c) {
      const at = base + stride * i + component.size * c;
      const raw = (dv[read] as (o: number, le: boolean) => number).call(dv, at, true);
      return normalized ? Math.max(raw * scale, -1) : raw;
    },
  };
}

export interface DecodeGltfOptions {
  readonly transform: Mat4;
  readonly origin: readonly [number, number, number];
  readonly withColor?: boolean;
  readonly path?: string;
  /**
   * Buffers already fetched, by glTF buffer index.
   *
   * Buffer 0 defaults to the GLB's own BIN chunk, and a `data:` URI is decoded
   * here — but a plain `.gltf` puts its points in a sibling `.bin`, and that is
   * a second request nothing inside this function can make. The real glTF point
   * clouds published as 3D Tiles samples are exactly that shape, so it is the
   * normal case rather than the exotic one.
   */
  readonly buffers?: readonly (Uint8Array | undefined)[];
}

/**
 * Which buffers a document needs fetched, and from where.
 *
 * Returns the ones that are neither the GLB's own chunk nor a `data:` URI. The
 * caller resolves them against the document's URL and hands them back through
 * {@link DecodeGltfOptions.buffers}.
 */
export function externalBufferUris(
  json: GltfJson,
): Array<{ readonly index: number; readonly uri: string }> {
  const out: Array<{ index: number; uri: string }> = [];
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    if (buffer.uri === undefined) continue;
    if (decodeDataUri(buffer.uri) !== undefined) continue;
    out.push({ index, uri: buffer.uri });
  }
  return out;
}

const UNSUPPORTED_EXTENSIONS = new Map([
  [
    "KHR_draco_mesh_compression",
    `Draco-compressed content needs a Draco decoder, which this driver does ` +
      `not carry yet.`,
  ],
  [
    "EXT_meshopt_compression",
    `meshopt-compressed content needs a meshopt decoder, which this driver ` +
      `does not carry.`,
  ],
]);

/**
 * Decode a glTF tile's points.
 *
 * Emits the same shape a `.pnts` does, so the reader above this does not branch
 * on which spelling the tile used.
 */
export function decodeGltfPoints(
  bytes: Uint8Array,
  options: DecodeGltfOptions,
): DecodedTileContent {
  const { json, binary } = readGltf(bytes, options.path);

  for (const ext of json.extensionsRequired ?? []) {
    const why = UNSUPPORTED_EXTENSIONS.get(ext);
    if (why !== undefined) {
      fail("unsupported-format", `${why} (${ext})`, options.path);
    }
  }

  // Buffer 0 is the GLB's own chunk unless the document names a URI for it.
  // A `data:` payload is decoded here; anything else had to arrive through
  // `options.buffers`.
  const resolved: (Uint8Array | undefined)[] = [];
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    const supplied = options.buffers?.[index];
    if (supplied !== undefined) {
      resolved[index] = supplied;
    } else if (buffer.uri !== undefined) {
      resolved[index] = decodeDataUri(buffer.uri);
    } else if (index === 0) {
      resolved[index] = binary;
    }
  }
  // Only when the document declares NO buffers at all: a buffer that names a
  // URI stays unresolved on purpose, so the error says which file is missing
  // rather than reading the GLB's chunk as if it were that file.
  if ((json.buffers ?? []).length === 0) resolved[0] = binary;

  const primitives = collectPointPrimitives(json, options.path);
  for (const { primitive } of primitives) {
    for (const ext of Object.keys(primitive.extensions ?? {})) {
      const why = UNSUPPORTED_EXTENSIONS.get(ext);
      if (why !== undefined) fail("unsupported-format", `${why} (${ext})`, options.path);
    }
  }

  // One pass to size the output, so nothing is grown or copied twice.
  const readers = primitives.map(({ primitive, matrix }) => {
    const positionIndex = primitive.attributes?.["POSITION"];
    if (positionIndex === undefined) {
      fail("invalid-format", `A POINTS primitive has no POSITION.`, options.path);
    }
    const position = accessorReader(json, positionIndex, resolved, options.path);
    const colorIndex = primitive.attributes?.["COLOR_0"];
    const color =
      options.withColor === false || colorIndex === undefined
        ? undefined
        : accessorReader(json, colorIndex, resolved, options.path, true);
    return { position, color, matrix };
  });

  const total = readers.reduce((n, r) => n + r.position.count, 0);
  const anyColor = readers.some((r) => r.color !== undefined);
  const positions = new Float32Array(3 * total);
  const colors = anyColor ? new Uint8Array(4 * total) : undefined;

  const m = options.transform;
  const [ox, oy, oz] = options.origin;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let w = 0;

  for (const { position, color, matrix } of readers) {
    // The node chain, then the tile transform. Composed once per primitive, in
    // float64, and applied per point — the same decision the `.pnts` path makes
    // and B7 made for an E57 pose.
    const chain = multiply(m as readonly number[], matrix);
    for (let i = 0; i < position.count; i++) {
      const lx = position.read(i, 0);
      const ly = position.read(i, 1);
      const lz = position.read(i, 2);
      const ax = chain[0]! * lx + chain[4]! * ly + chain[8]! * lz + chain[12]!;
      const ay = chain[1]! * lx + chain[5]! * ly + chain[9]! * lz + chain[13]!;
      const az = chain[2]! * lx + chain[6]! * ly + chain[10]! * lz + chain[14]!;
      if (ax < minX) minX = ax;
      if (ay < minY) minY = ay;
      if (az < minZ) minZ = az;
      if (ax > maxX) maxX = ax;
      if (ay > maxY) maxY = ay;
      if (az > maxZ) maxZ = az;
      positions[3 * w] = ax - ox;
      positions[3 * w + 1] = ay - oy;
      positions[3 * w + 2] = az - oz;

      if (colors !== undefined) {
        if (color === undefined) {
          colors[4 * w] = 255;
          colors[4 * w + 1] = 255;
          colors[4 * w + 2] = 255;
          colors[4 * w + 3] = 255;
        } else {
          // COLOR_0 is float or normalized integer, and either way the value is
          // 0..1 by the time it is read. Alpha defaults to opaque for a VEC3.
          for (let c = 0; c < 3; c++) {
            const v = color.read(i, c);
            colors[4 * w + c] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
          }
          const a = color.components >= 4 ? color.read(i, 3) : 1;
          colors[4 * w + 3] = Math.round(Math.min(Math.max(a, 0), 1) * 255);
        }
      }
      w++;
    }
  }

  if (total === 0) {
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }
  const volume =
    Math.max(maxX - minX, 1e-9) *
    Math.max(maxY - minY, 1e-9) *
    Math.max(maxZ - minZ, 1e-9);
  return {
    numPoints: total,
    positions,
    colors,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    pitch: total > 0 ? Math.cbrt(volume / total) : 1,
  };
}


