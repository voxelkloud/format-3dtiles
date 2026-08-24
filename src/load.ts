// Identify and open a tileset.
//
// One `tileset.json` gives the structure, and then there is a SECOND request
// that is not avoidable: the document says nothing about what a point carries.
// Not the attributes, not the colour, not even whether there is any — all of
// that lives in the first tile's feature table. EPT hit the same wall from the
// other side (its schema disagreed with the records Entwine wrote, so the
// driver reads the root node's header and believes it), and the answer is the
// same: pay for one small read rather than declare something that might be a
// lie.

import { VoxelkloudError } from "@voxelkloud/core";
import type {
  BoundingBox,
  LoadSourceOptions,
  PointAttribute,
  PointCloudTransport,
} from "@voxelkloud/core";
import { createTileTable } from "./hierarchy.js";
import { readPntsHeader } from "./pnts.js";
import { parseTileset } from "./tileset.js";
import type { Tile, TilesetWarning } from "./tileset.js";
import type { TilesetJson, TilesetSource } from "./types.js";

/** Enough of a `.pnts` to hold its header and feature table JSON. */
const PROBE_BYTES = 8192;

/** Both accepted inputs: the directory, or `tileset.json` itself. */
export function resolveTilesetUrls(input: string): {
  base: string;
  manifest: string;
} {
  const url = new URL(input);
  if (url.pathname.endsWith(".json")) {
    return { base: new URL(".", url).href, manifest: url.href };
  }
  const base = url.pathname.endsWith("/") ? url.href : `${url.href}/`;
  return { base, manifest: new URL("tileset.json", base).href };
}

async function fetchJson(
  transport: PointCloudTransport,
  url: string,
  signal: AbortSignal | undefined,
): Promise<TilesetJson> {
  let res: Response;
  try {
    res = await transport.fetch(url, {
      ...transport.requestInit,
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
  const text = await res.text();
  try {
    return JSON.parse(text) as TilesetJson;
  } catch (cause) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} is not JSON, so it is not a tileset.`,
      { url, cause },
    );
  }
}

function attribute(
  name: string,
  role: PointAttribute["role"],
  type: PointAttribute["type"],
  numElements: number,
  elementSize: number,
  byteOffset: number,
  min: number[],
  max: number[],
): PointAttribute {
  return {
    name,
    role,
    description: "",
    type,
    numElements,
    elementSize,
    byteSize: numElements * elementSize,
    byteOffset,
    min,
    max,
    scale: new Array<number>(numElements).fill(1),
    offset: new Array<number>(numElements).fill(0),
    // A tileset publishes neither: there is no manifest field for a histogram
    // and nothing here is normalised — a `.pnts` position is already float in
    // source units and its colour is already 8-bit.
    histogram: undefined,
    normalization: undefined,
  };
}

/**
 * What one point carries, learned from the first tile that has any.
 *
 * A `.pnts` spells colour four ways and may carry none at all, and NOTHING in
 * the tileset document says which. Declaring colour that is not there gives the
 * renderer an attribute it will bind and never fill; declaring none when it is
 * there renders a colour cloud in flat grey. So the first content tile is read
 * — a ranged 8 KiB where the host allows it, the whole tile where it does not,
 * which for static hosting is a normal answer rather than a misconfiguration.
 */
async function probeAttributes(
  transport: PointCloudTransport,
  tiles: readonly Tile[],
  bounds: BoundingBox,
  warnings: TilesetWarning[],
  signal: AbortSignal | undefined,
): Promise<PointAttribute[]> {
  const position = attribute(
    "position",
    "position",
    "float",
    3,
    4,
    0,
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]],
  );

  const first = tiles.find(
    (t) => t.contentKind === "pnts" && t.contentUri !== undefined,
  );
  if (first === undefined) return [position];

  const url = first.contentUri!;
  try {
    const headers = new Headers(transport.requestInit?.headers);
    headers.set("Range", `bytes=0-${PROBE_BYTES - 1}`);
    const res = await transport.fetch(url, {
      ...transport.requestInit,
      headers,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { featureTable: ft } = readPntsHeader(bytes, first.name);
    const hasAlpha = ft.RGBA !== undefined;
    const hasColor =
      hasAlpha ||
      ft.RGB !== undefined ||
      ft.RGB565 !== undefined ||
      ft.CONSTANT_RGBA !== undefined;
    if (!hasColor) return [position];
    const n = hasAlpha ? 4 : 3;
    return [
      position,
      attribute(
        hasAlpha ? "rgba" : "rgb",
        "color",
        "uint8",
        n,
        1,
        12,
        new Array<number>(n).fill(0),
        new Array<number>(n).fill(255),
      ),
    ];
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    // NOT fatal. A tileset whose first tile cannot be probed still has a
    // structure worth showing, and the elevation ramp is what a cloud with no
    // declared colour gets anyway.
    warnings.push({
      code: "content-unsupported",
      message:
        `Could not read the feature table of ${url} to find out what a point ` +
        `carries (${String(cause)}). Assuming position only, so the cloud will ` +
        `draw with an elevation ramp even if the tiles have colour.`,
      path: first.name,
    });
    return [position];
  }
}

/**
 * Load a tileset and build its source.
 *
 * @throws {VoxelkloudError} `"invalid-metadata"` when the document is not a
 *   tileset, `"hierarchy-error"` when it has no root tile.
 */
export async function loadTilesetSource(
  input: string | URL,
  options: LoadSourceOptions = {},
): Promise<TilesetSource> {
  const { base, manifest } = resolveTilesetUrls(String(input));
  const transport: PointCloudTransport = {
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    requestInit: options.requestInit,
  };

  const json =
    options.probe?.url === manifest && options.probe.json !== undefined
      ? (options.probe.json as TilesetJson)
      : await fetchJson(transport, manifest, options.signal);

  const parsed = parseTileset(json, { baseUrl: manifest });
  const root = parsed.tiles[0];
  if (root === undefined) {
    throw new VoxelkloudError(
      "hierarchy-error",
      `${manifest} has no root tile, so there is nothing to draw.`,
      { url: manifest },
    );
  }

  const warnings: TilesetWarning[] = [...parsed.warnings];
  const bounds: BoundingBox = {
    min: [root.bounds.minX, root.bounds.minY, root.bounds.minZ],
    max: [root.bounds.maxX, root.bounds.maxY, root.bounds.maxZ],
  };

  const attributes = await probeAttributes(
    transport,
    parsed.tiles,
    bounds,
    warnings,
    options.signal,
  );

  // NOT knowable without reading every tile, and saying so beats a number that
  // looks authoritative. The estimate is the nominal per content tile, which is
  // what the scheduler is charging against until the decodes correct it.
  const contentTiles = parsed.tiles.filter((t) => t.contentKind === "pnts").length;
  warnings.push({
    code: "point-count-estimated",
    message:
      `A tileset declares no point counts, so \`pointCount\` is an estimate ` +
      `over ${contentTiles} content tiles and will not match the file. Every ` +
      `tile's count is corrected the moment its content is decoded.`,
    path: "tileset.json",
  });

  return {
    attributes,
    attributesByName: new Map(attributes.map((a) => [a.name, a])),
    bounds,
    // A tileset's root bounding volume IS its declared extent — there is no
    // second, looser indexing cube of the kind an octree carries, so these are
    // the same box rather than one being a lie about the other.
    tightBoundingBox: bounds,
    pointCount: contentTiles * 65_536,
    ...(parsed.georeferenced
      ? { crs: { epsg: 4978, source: "declared" as const } }
      : {}),
    warnings,
    transport,
    url: manifest,
    baseUrl: base,
    version: parsed.version,
    georeferenced: parsed.georeferenced,
    tiles: createTileTable(parsed.tiles),
  } as TilesetSource;
}
