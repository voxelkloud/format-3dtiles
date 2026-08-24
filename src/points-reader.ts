// One tile: a GET, a decode, and two numbers handed back to the tree.
//
// Simpler than the other three readers, because a tile is a WHOLE FILE. No
// range, no chunk table, no offset arithmetic — the addressing a `.pnts` needs
// is a URI, which is why the tile table exists rather than the byte range that
// rides on a Potree or COPC node.
//
// What is NOT simpler is the write-back. A tileset declares no point counts and
// no point pitch, so both are guesses until this file decodes something; the
// two `observe` calls are what turn the guesses into the numbers the scheduler
// reads next frame.

import { VoxelkloudError } from "@voxelkloud/core";
import type {
  DecodedAttribute,
  DecodedPointData,
  OpenPointsOptions,
  PointAttribute,
  PointCloudNode,
  PointNodeRef,
  PointReader,
  ReadPointsOptions,
} from "@voxelkloud/core";
import { decodeGltfPoints, externalBufferUris, readGltf } from "./gltf.js";
import { decodePnts } from "./pnts.js";
import type { TileTable } from "./hierarchy.js";
import type { TilesetSource } from "./types.js";

const NO_ATTRIBUTES: readonly DecodedAttribute[] = [];
const NO_ATTRIBUTES_BY_NAME: ReadonlyMap<string, DecodedAttribute> = new Map();

/**
 * A priori bound on `|reconstructed - true|` for this node, in CRS units.
 *
 * Half a float32 ULP at the largest magnitude the node box can produce once the
 * cloud origin is subtracted. Computed from the BOX rather than from the data,
 * so it is valid before the first point is read — and it matters more here than
 * anywhere else in this repo: an ECEF coordinate is 6.4e6 metres, where the
 * float32 ULP is 0.5 m. Relative to the cloud origin the same tile reconstructs
 * to millimetres, which is the whole reason the frame carries an origin.
 */
function positionError(
  node: PointNodeRef,
  origin: readonly [number, number, number],
): number {
  const m = Math.max(
    Math.abs(node.minX - origin[0]),
    Math.abs(node.maxX - origin[0]),
    Math.abs(node.minY - origin[1]),
    Math.abs(node.maxY - origin[1]),
    Math.abs(node.minZ - origin[2]),
    Math.abs(node.maxZ - origin[2]),
  );
  if (!(m > 0)) return 0;
  return 2 ** (Math.floor(Math.log2(m)) - 24);
}

export interface TilesetPointReader extends PointReader {
  /** The attributes this reader will emit, resolved once. */
  readonly attributes: readonly PointAttribute[];
}

export function openTilesetPoints(
  source: TilesetSource,
  options: OpenPointsOptions = {},
): TilesetPointReader {
  const table: TileTable = source.tiles;
  const origin: [number, number, number] = [
    source.bounds.min[0],
    source.bounds.min[1],
    source.bounds.min[2],
  ];
  // The selection is resolved ONCE, like every other driver: a tile carries
  // position and at most one colour, so this is a single question about whether
  // the caller wants colour rather than a per-node negotiation.
  const wanted = options.attributes;
  const withColor =
    wanted === undefined ||
    wanted === "all" ||
    wanted.includes("rgba") ||
    wanted.includes("rgb");
  if (Array.isArray(wanted)) {
    for (const name of wanted) {
      if (name !== "position" && name !== "rgb" && name !== "rgba") {
        throw new VoxelkloudError(
          "unsupported-attribute",
          `A 3D Tiles point tile carries "position" and at most one colour ` +
            `("rgb" or "rgba"); ${JSON.stringify(name)} is not something this ` +
            `driver can decode. Per-point batch table properties are not read.`,
        );
      }
    }
  }

  const fetchTile = async (
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> => {
    let res: Response;
    try {
      res = await source.transport.fetch(url, {
        ...source.transport.requestInit,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "AbortError" || cause.name === "TimeoutError")
      ) {
        throw cause;
      }
      throw new VoxelkloudError("network-error", `Network error fetching ${url}.`, {
        url,
        cause,
      });
    }
    if (!res.ok) {
      throw new VoxelkloudError(
        "http-error",
        `GET ${url} failed: HTTP ${res.status} ${res.statusText}.`,
        { url, status: res.status },
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  return {
    attributes: source.attributes,

    hasPayload(node: PointCloudNode): boolean {
      const tile = table.tiles[node.index];
      if (tile === undefined || tile.contentUri === undefined) return false;
      // `tileset` is a document rather than points, and answers no here rather
      // than failing inside a fetch the scheduler already paid for.
      return tile.contentKind === "pnts" || tile.contentKind === "gltf";
    },

    packingFor(): undefined {
      // Nothing is packed: positions are float32 in source units and colour is
      // 8-bit already. A scalar lane arrives with T5's glTF accessors.
      return undefined;
    },

    async read(
      node: PointNodeRef,
      readOptions: ReadPointsOptions = {},
    ): Promise<DecodedPointData> {
      const tile = table.tiles[node.index];
      if (tile === undefined || tile.contentUri === undefined) {
        throw new VoxelkloudError(
          "invalid-metadata",
          `Tile ${node.name} has no content to read.`,
          { path: node.name },
        );
      }
      if (tile.contentKind !== "pnts" && tile.contentKind !== "gltf") {
        throw new VoxelkloudError(
          "unsupported-format",
          `Tile ${node.name} has ${tile.contentKind} content; this driver ` +
            `reads .pnts and glTF points. Ask \`hasPayload\` before dispatching.`,
          { path: node.name, url: tile.contentUri },
        );
      }

      const bytes = await fetchTile(tile.contentUri, readOptions.signal);
      // Dispatch on the EXTENSION, not on the bytes, and then stop caring: the
      // two decoders address their points completely differently and produce
      // the same arrays.
      const decodeOptions = {
        transform: tile.transform,
        origin,
        withColor,
        path: node.name,
      };
      let decoded;
      if (tile.contentKind === "pnts") {
        decoded = decodePnts(bytes, decodeOptions);
      } else {
        // A `.glb` carries its buffer; a plain `.gltf` keeps it in a sibling
        // `.bin`, which is a SECOND request and cannot be avoided — the
        // published glTF point clouds are exactly that shape. Fetched in
        // parallel, because a document with several is rare but legal.
        const { json } = readGltf(bytes, node.name);
        const external = externalBufferUris(json);
        const buffers: (Uint8Array | undefined)[] = [];
        if (external.length > 0) {
          await Promise.all(
            external.map(async ({ index, uri }) => {
              buffers[index] = await fetchTile(
                new URL(uri, tile.contentUri!).toString(),
                readOptions.signal,
              );
            }),
          );
        }
        decoded = decodeGltfPoints(bytes, { ...decodeOptions, buffers });
      }

      // THE WRITE-BACK. Both numbers were guesses until this moment: the count
      // because a tileset declares none, the pitch because a tiler's
      // `geometricError` is a proxy for it and a leaf's is 0.
      table.observe?.(node.index, decoded.numPoints, decoded.pitch);

      const transferList: ArrayBuffer[] = [decoded.positions.buffer as ArrayBuffer];
      if (decoded.colors !== undefined) {
        transferList.push(decoded.colors.buffer as ArrayBuffer);
      }

      const computeBounds = readOptions.computeBounds ?? options.computeBounds ?? false;
      return {
        nodeIndex: node.index,
        nodeName: node.name,
        numPoints: decoded.numPoints,
        positions: decoded.positions,
        frame: {
          format: "float32",
          origin,
          scale: [1, 1, 1],
          originPolicy: "cloud",
          maxPositionError: positionError(node, origin),
        },
        colors:
          decoded.colors === undefined
            ? undefined
            : {
                array: decoded.colors,
                gpuFormat: "unorm8x4",
                maxValue: 255,
                declaredMax: 255,
                shift: 0,
              },
        attributes: NO_ATTRIBUTES,
        attributesByName: NO_ATTRIBUTES_BY_NAME,
        bounds: computeBounds
          ? { min: decoded.bounds.min, max: decoded.bounds.max }
          : undefined,
        transferList,
        byteLength: transferList.reduce((n, b) => n + b.byteLength, 0),
      };
    },

    dispose(): void {
      // Nothing is held: no decoder, no open range, no cache.
    },
  };
}
