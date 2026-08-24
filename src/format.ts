import type { FormatProbe, PointCloudFormat } from "@voxelkloud/core";
import { createTilesetTree } from "./hierarchy.js";
import { loadTilesetSource, resolveTilesetUrls } from "./load.js";
import { openTilesetPoints } from "./points-reader.js";
import type { TilesetJson, TilesetSource } from "./types.js";

/**
 * The 3D Tiles driver, as the registry entry.
 *
 * Not registered by default, the same as COPC and EPT: an app that reads Potree
 * should not carry a tileset parser to find that out.
 */
export const tilesetFormat: PointCloudFormat<TilesetSource> = {
  id: "3d-tiles",
  label: "3D Tiles",

  sniffUrl(url) {
    const path = url.split(/[?#]/)[0] ?? "";
    if (path.endsWith("/tileset.json")) return 2;
    // A bare directory is this format's conventional shape, and also Potree's
    // and EPT's. Weak on purpose: content decides.
    if (path.endsWith("/")) return 1;
    return 0;
  },

  probeUrl(url) {
    try {
      return resolveTilesetUrls(url).manifest;
    } catch {
      return undefined;
    }
  },

  sniff(probe: FormatProbe) {
    const j = probe.json;
    if (j === null || typeof j !== "object") return 0;
    const o = j as Record<string, unknown>;
    // `asset.version` plus a `root` that carries a `geometricError` is the
    // combination no other manifest in this space has. `asset` alone would also
    // match a glTF, which is a document this driver reads but not a tileset.
    const asset = o["asset"];
    const root = o["root"];
    if (asset === null || typeof asset !== "object") return 0;
    if (root === null || typeof root !== "object") return 0;
    const r = root as Record<string, unknown>;
    if (typeof r["geometricError"] !== "number") return 2;
    return r["boundingVolume"] !== undefined ? 3 : 2;
  },

  load: (url, options) => loadTilesetSource(url, options),

  openTree: async (source, options) => {
    const warnings = [...source.warnings] as never[];
    return createTilesetTree(source.tiles, {
      loadDocument: async (url, signal) => {
        const res = await source.transport.fetch(url, {
          ...source.transport.requestInit,
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}.`);
        return (await res.json()) as TilesetJson;
      },
      loadSubtree: async (url, signal) => {
        const res = await source.transport.fetch(url, {
          ...source.transport.requestInit,
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}.`);
        return new Uint8Array(await res.arrayBuffer());
      },
      warnings,
    });
  },

  openPoints: (source, options) => openTilesetPoints(source, options),
};

/** Re-exported so a caller can pin the driver by its stable id. */
export const TILESET_FORMAT_ID = tilesetFormat.id;
