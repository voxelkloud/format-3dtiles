// The `tileset.json` document, typed as it is written rather than as we wish it
// were. Nothing here is normalised: normalising is `tileset.ts`'s job and it
// records what it had to fix as warnings.

import type { PointCloudSourceBase } from "@voxelkloud/core";
import type { BoundingVolumeJson } from "./bounds.js";
import type { TileTable } from "./hierarchy.js";

/** `"ADD"` or `"REPLACE"`, and INHERITED when absent. Required on the root. */
export type RefineMode = "ADD" | "REPLACE";

export interface ContentJson {
  readonly uri?: string;
  /** 1.0 spelled it `url`, and files in the wild still do. */
  readonly url?: string;
  readonly boundingVolume?: BoundingVolumeJson;
  readonly metadata?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ImplicitTilingJson {
  readonly subdivisionScheme?: "QUADTREE" | "OCTREE";
  readonly subtreeLevels?: number;
  readonly availableLevels?: number;
  /** 1.0's extension spelled it `maximumLevel`, one less than `availableLevels`. */
  readonly maximumLevel?: number;
  readonly subtrees?: { readonly uri?: string };
}

export interface TileJson {
  readonly boundingVolume?: BoundingVolumeJson;
  readonly viewerRequestVolume?: BoundingVolumeJson;
  readonly geometricError?: number;
  readonly refine?: string;
  /** Column-major 4x4. Absent means identity. */
  readonly transform?: readonly number[];
  readonly content?: ContentJson;
  /** 1.1: a tile may carry several. */
  readonly contents?: readonly ContentJson[];
  readonly children?: readonly TileJson[];
  readonly implicitTiling?: ImplicitTilingJson;
  readonly metadata?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface TilesetJson {
  readonly asset?: { readonly version?: string; readonly tilesetVersion?: string };
  readonly geometricError?: number;
  readonly root?: TileJson;
  readonly extensionsUsed?: readonly string[];
  readonly extensionsRequired?: readonly string[];
  readonly schema?: unknown;
  readonly statistics?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * The codes this driver's warnings use. A CLOSED union, so a caller can
 * discriminate on it rather than matching message text.
 */
export type TilesetWarningCode =
  | "tileset-version-unknown"
  | "tile-missing-bounding-volume"
  | "tile-unreadable-bounding-volume"
  | "tile-missing-geometric-error"
  | "geometric-error-not-monotonic"
  | "refine-missing-on-root"
  | "content-unsupported"
  | "content-multiple"
  | "extension-unsupported"
  | "external-tileset-depth"
  | "point-count-estimated";

/** What `loadTilesetSource` produces, on top of the neutral contract. */
export interface TilesetSource extends PointCloudSourceBase {
  /** The document that was read. */
  readonly url: string;
  /** Directory it lives in, for resolving anything relative to it. */
  readonly baseUrl: string;
  /** `asset.version`, verbatim. */
  readonly version: string;
  readonly georeferenced: boolean;
  /** Shared with the tree; see {@link TileTable}. */
  readonly tiles: TileTable;
}
