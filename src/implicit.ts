// Implicit tiling, part two: turning availability bits into tiles.
//
// An implicit tileset writes ONE tile and a rule. Everything below it — the
// boxes, the content URIs, the tree — is generated, and the only thing a
// `.subtree` file adds is which of the generated nodes actually exist.
//
// The generated tiles are ordinary `Tile`s, which is the point: once they are
// made, nothing downstream knows the difference between a tileset that wrote
// its tree out and one that described it. The per-node arrays, the shifted
// error of DEC-T2, the reader, the REPLACE flag — all the same code.
//
// And one thing gets SIMPLER here, which is worth saying because the explicit
// case is where the complexity lives: an implicit tileset's geometric error IS
// a closed form of the level, `rootError / 2^level`. It is the one shape of 3D
// Tiles that would not need `nodeGeometricError` at all.

import { VoxelkloudError } from "@voxelkloud/core";
import { boundingVolumeToBounds } from "./bounds.js";
import type { BoundingVolumeJson, Mat4 } from "./bounds.js";
import { fillTemplate, mortonOf } from "./subtree.js";
import type { SubdivisionScheme, Subtree } from "./subtree.js";
import type { RefineMode } from "./types.js";
import type { Tile } from "./tileset.js";

/** Where a tile sits in the implicit grid. Global, not subtree-relative. */
export interface ImplicitCoord {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  /** Always 0 under a quadtree, and never written into a template there. */
  readonly z: number;
}

/** Everything the rule needs, resolved once from the tile that declared it. */
export interface ImplicitContext {
  readonly scheme: SubdivisionScheme;
  readonly subtreeLevels: number;
  /** Levels that exist AT ALL, counting the root as level 0. */
  readonly availableLevels: number;
  readonly subtreeTemplate: string | undefined;
  readonly contentTemplate: string | undefined;
  /** The volume of the tile that declared the rule, in ITS OWN coordinates. */
  readonly rootVolume: BoundingVolumeJson;
  readonly rootGeometricError: number;
  readonly transform: Mat4;
  readonly refine: RefineMode;
  /** For resolving the two templates. */
  readonly baseUrl: string;
  /** The name of the declaring tile, so generated names extend it. */
  readonly rootName: string;
  readonly rootLevel: number;
}

function fail(message: string, path?: string): never {
  throw new VoxelkloudError(
    "invalid-metadata",
    message,
    path !== undefined ? { path } : {},
  );
}

/**
 * One child of a bounding volume, under the subdivision scheme.
 *
 * `childBits` is the Morton code of the child within its parent: bit 0 is X,
 * bit 1 is Y, bit 2 is Z. A quadtree never sets bit 2 and never splits Z, which
 * is the whole reason this could not be `createPagedOctree` — that engine
 * halves a cube on all three axes and has no way to be told otherwise.
 */
export function subdivideVolume(
  volume: BoundingVolumeJson,
  scheme: SubdivisionScheme,
  childBits: number,
): BoundingVolumeJson {
  const splitZ = scheme === "OCTREE";

  if (volume.box !== undefined && volume.box.length >= 12) {
    const b = volume.box;
    // Halve each half-axis VECTOR, not each extent: an oriented box is halved
    // in its own frame, and the axes may be rotated relative to the world.
    const hx = [b[3]! / 2, b[4]! / 2, b[5]! / 2];
    const hy = [b[6]! / 2, b[7]! / 2, b[8]! / 2];
    const hz = splitZ ? [b[9]! / 2, b[10]! / 2, b[11]! / 2] : [b[9]!, b[10]!, b[11]!];
    // Move the centre by half an axis, in the direction the bit selects.
    const sx = (childBits & 1) === 1 ? 1 : -1;
    const sy = (childBits & 2) === 2 ? 1 : -1;
    const sz = splitZ ? ((childBits & 4) === 4 ? 1 : -1) : 0;
    return {
      box: [
        b[0]! + sx * hx[0]! + sy * hy[0]! + sz * hz[0]!,
        b[1]! + sx * hx[1]! + sy * hy[1]! + sz * hz[1]!,
        b[2]! + sx * hx[2]! + sy * hy[2]! + sz * hz[2]!,
        hx[0]!, hx[1]!, hx[2]!,
        hy[0]!, hy[1]!, hy[2]!,
        hz[0]!, hz[1]!, hz[2]!,
      ],
    };
  }

  if (volume.region !== undefined && volume.region.length >= 6) {
    const r = volume.region;
    const midLon = (r[0]! + r[2]!) / 2;
    const midLat = (r[1]! + r[3]!) / 2;
    const midH = (r[4]! + r[5]!) / 2;
    const west = (childBits & 1) === 1 ? midLon : r[0]!;
    const east = (childBits & 1) === 1 ? r[2]! : midLon;
    const south = (childBits & 2) === 2 ? midLat : r[1]!;
    const north = (childBits & 2) === 2 ? r[3]! : midLat;
    const minH = splitZ && (childBits & 4) === 4 ? midH : r[4]!;
    const maxH = splitZ && (childBits & 4) === 4 ? r[5]! : splitZ ? midH : r[5]!;
    return { region: [west, south, east, north, minH, maxH] };
  }

  // A sphere cannot be halved into a sphere, and the spec does not ask it to:
  // implicit tiling is defined for `box` and `region` only.
  return fail(
    `Implicit tiling subdivides a "box" or a "region"; this tile's bounding ` +
      `volume is neither, so its children have nowhere to be.`,
  );
}

/** The volume of an implicit tile, by descending from the root's. */
export function volumeAt(
  context: ImplicitContext,
  coord: ImplicitCoord,
): BoundingVolumeJson {
  let volume = context.rootVolume;
  for (let level = 1; level <= coord.level; level++) {
    // The bit of each coordinate at this depth, counting from the top.
    const shift = coord.level - level;
    const bx = (coord.x >> shift) & 1;
    const by = (coord.y >> shift) & 1;
    const bz = context.scheme === "OCTREE" ? (coord.z >> shift) & 1 : 0;
    volume = subdivideVolume(volume, context.scheme, bx | (by << 1) | (bz << 2));
  }
  return volume;
}

function resolve(base: string, uri: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

/** Where the subtree file for a coordinate lives, or `undefined` if untemplated. */
export function subtreeUrl(
  context: ImplicitContext,
  coord: ImplicitCoord,
): string | undefined {
  if (context.subtreeTemplate === undefined) return undefined;
  return resolve(
    context.baseUrl,
    fillTemplate(
      context.subtreeTemplate,
      coord.level,
      coord.x,
      coord.y,
      context.scheme === "OCTREE" ? coord.z : undefined,
    ),
  );
}

function contentUrl(
  context: ImplicitContext,
  coord: ImplicitCoord,
): string | undefined {
  if (context.contentTemplate === undefined) return undefined;
  return resolve(
    context.baseUrl,
    fillTemplate(
      context.contentTemplate,
      coord.level,
      coord.x,
      coord.y,
      context.scheme === "OCTREE" ? coord.z : undefined,
    ),
  );
}

function classify(uri: string | undefined): Tile["contentKind"] {
  if (uri === undefined) return "unsupported";
  const path = uri.split(/[?#]/)[0] ?? "";
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot).toLowerCase();
  if (ext === ".pnts") return "pnts";
  if (ext === ".json") return "tileset";
  return "gltf";
}

export interface GenerateOptions {
  readonly context: ImplicitContext;
  /** The tile the subtree hangs from, and the coordinate it sits at. */
  readonly rootCoord: ImplicitCoord;
  readonly parentIndex: number;
  readonly startIndex: number;
  /** The declaring tile's own error, which scores the subtree's top tile. */
  readonly parentGeometricError: number;
}

/**
 * Turn one `.subtree` into tiles.
 *
 * Level 0 of a subtree IS the tile that fetched it, so generation starts at
 * level 1 and stops at `subtreeLevels - 1`. Below that, every AVAILABLE child
 * subtree becomes a placeholder tile carrying the rule again — it expands by
 * fetching its own `.subtree`, which is the same page-and-pointer shape Potree,
 * COPC and EPT all have, spelled a fourth way.
 *
 * A tile whose availability bit is 0 is not generated at all, and neither is
 * anything below it: the bitstream is the tree.
 */
export function generateSubtreeTiles(
  subtree: Subtree,
  options: GenerateOptions,
): Tile[] {
  const { context, rootCoord, parentIndex, startIndex } = options;
  const tiles: Tile[] = [];
  /** Global coordinate -> index, so a child can find its parent. */
  const byCoord = new Map<string, number>();
  const key = (c: ImplicitCoord) => `${c.level}/${c.x}/${c.y}/${c.z}`;
  byCoord.set(key(rootCoord), parentIndex);

  const errorAt = (level: number) => context.rootGeometricError / 2 ** level;
  const maxLevelInSubtree = Math.min(
    subtree.subtreeLevels - 1,
    // `availableLevels` counts levels, so the deepest is one less.
    context.availableLevels - 1 - rootCoord.level,
  );

  const push = (
    coord: ImplicitCoord,
    levelInSubtree: number,
    hasContent: boolean,
    implicitAgain: boolean,
  ): void => {
    const index = startIndex + tiles.length;
    const parentCoord: ImplicitCoord = {
      level: coord.level - 1,
      x: coord.x >> 1,
      y: coord.y >> 1,
      z: context.scheme === "OCTREE" ? coord.z >> 1 : 0,
    };
    const parent = byCoord.get(key(parentCoord));
    if (parent === undefined) return; // its parent's bit was 0; so is it.

    const volume = volumeAt(context, coord);
    const bounds = boundingVolumeToBounds(volume, context.transform);
    if (bounds === undefined) return;

    const own = errorAt(coord.level);
    const uri = hasContent ? contentUrl(context, coord) : undefined;
    const name =
      `${context.rootName}:${coord.level}-${coord.x}-${coord.y}` +
      (context.scheme === "OCTREE" ? `-${coord.z}` : "");

    tiles.push({
      index,
      name,
      // `coord.level` is GLOBAL to the implicit grid, not relative to the
      // subtree being read — subtracting the subtree's own root would restart
      // the depth at every subtree boundary and flatten the tree.
      level: context.rootLevel + coord.level,
      bounds,
      geometricError: own,
      // DEC-T2 again, and here the parent's error is a closed form rather than
      // a lookup: `rootError / 2^(level - 1)`.
      refinementError:
        coord.level === rootCoord.level
          ? options.parentGeometricError
          : errorAt(coord.level - 1),
      pitch: own > 0 ? own : errorAt(coord.level - 1) / 2,
      refine: context.refine,
      transform: context.transform,
      volumeJson: volume,
      contentUri: uri,
      contentKind: uri === undefined ? "unsupported" : classify(uri),
      contentTemplate: undefined,
      documentUrl: context.baseUrl,
      // A placeholder for a deeper subtree carries the rule forward; a leaf of
      // this subtree that has no child subtree carries nothing and is final.
      implicitTiling: implicitAgain
        ? {
            subdivisionScheme: context.scheme,
            subtreeLevels: context.subtreeLevels,
            availableLevels: context.availableLevels,
            subtrees: { uri: context.subtreeTemplate ?? "" },
          }
        : undefined,
      implicit: { context, coord },
      parentIndex: parent,
      childIndices: [],
    });
    byCoord.set(key(coord), index);
    void levelInSubtree;
  };

  for (let levelInSubtree = 1; levelInSubtree <= maxLevelInSubtree; levelInSubtree++) {
    const span = 2 ** levelInSubtree;
    const zSpan = context.scheme === "OCTREE" ? span : 1;
    for (let lz = 0; lz < zSpan; lz++) {
      for (let ly = 0; ly < span; ly++) {
        for (let lx = 0; lx < span; lx++) {
          const morton = mortonOf(context.scheme, lx, ly, lz);
          if (!subtree.isTileAvailable(levelInSubtree, morton)) continue;
          const coord: ImplicitCoord = {
            level: rootCoord.level + levelInSubtree,
            x: rootCoord.x * span + lx,
            y: rootCoord.y * span + ly,
            z: context.scheme === "OCTREE" ? rootCoord.z * span + lz : 0,
          };
          push(
            coord,
            levelInSubtree,
            subtree.isContentAvailable(levelInSubtree, morton),
            false,
          );
        }
      }
    }
  }

  // The bottom edge: one placeholder per available child subtree, each of which
  // will fetch its own file when the scheduler asks for it.
  if (
    subtree.subtreeLevels - 1 <= maxLevelInSubtree &&
    rootCoord.level + subtree.subtreeLevels < context.availableLevels
  ) {
    const span = 2 ** subtree.subtreeLevels;
    const zSpan = context.scheme === "OCTREE" ? span : 1;
    for (let lz = 0; lz < zSpan; lz++) {
      for (let ly = 0; ly < span; ly++) {
        for (let lx = 0; lx < span; lx++) {
          const morton = mortonOf(context.scheme, lx, ly, lz);
          if (!subtree.isChildSubtreeAvailable(morton)) continue;
          const coord: ImplicitCoord = {
            level: rootCoord.level + subtree.subtreeLevels,
            x: rootCoord.x * span + lx,
            y: rootCoord.y * span + ly,
            z: context.scheme === "OCTREE" ? rootCoord.z * span + lz : 0,
          };
          push(coord, subtree.subtreeLevels, false, true);
        }
      }
    }
  }

  return tiles;
}
