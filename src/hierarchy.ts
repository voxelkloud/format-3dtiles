// The tile tree, as the scheduler sees it.
//
// NOT `createPagedOctree`, and the difference is the point: that engine indexes
// space by halving a cube, and three formats share it because all three do. An
// explicit tileset does not. Its children are any number of arbitrary boxes
// that may overlap, differ in size and leave gaps, and its structure arrives
// whole inside one document rather than in pages of a fixed subdivision.
// Implicit tiling IS an octree or a quadtree and belongs on that engine; this
// file is for the explicit case.
//
// So the only asynchrony here is the EXTERNAL TILESET: a tile whose content is
// another `tileset.json`, whose root is grafted on as its child once fetched.
// Everything else in a document is materialised the moment the document is.

import { VoxelkloudError, isVoxelkloudError } from "@voxelkloud/core";
import type { PointCloudNode, PointCloudTreeBase } from "@voxelkloud/core";
import { generateSubtreeTiles, subtreeUrl } from "./implicit.js";
import type { ImplicitContext, ImplicitCoord } from "./implicit.js";
import { readSubtree } from "./subtree.js";
import type { SubdivisionScheme } from "./subtree.js";
import { parseTileset } from "./tileset.js";
import type { Tile, TilesetWarning } from "./tileset.js";
import type { TilesetJson } from "./types.js";

/**
 * The tiles of one cloud, shared between the tree and the reader.
 *
 * A seam worth naming. The `PointReader` contract is handed a flat
 * {@link PointNodeRef} — an index, a name, a count, a box — and for every other
 * driver here that is enough, because a Potree or COPC node addresses its bytes
 * with a byte range that rides along on the node. A tile addresses its bytes
 * with a URI and a 4x4 transform, and neither fits on that shape.
 *
 * So the table is the shared thing: the tree APPENDS to it as external tilesets
 * arrive, the reader looks up by index, and `observe` carries the two numbers
 * only the decode can know back to the arrays the scheduler reads.
 */
export interface TileTable {
  readonly tiles: Tile[];
  /** Installed by the tree. A no-op until one is opened. */
  observe?: (index: number, numPoints: number, pitch: number) => void;
}

/** How a tileset document is fetched. The ONE door JSON comes through. */
export type LoadTilesetDocument = (
  url: string,
  signal?: AbortSignal,
) => Promise<TilesetJson>;

/** How a `.subtree` is fetched. The other door, and the only one for bytes. */
export type LoadSubtreeBytes = (
  url: string,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

export interface TilesetTreeOptions {
  readonly loadDocument: LoadTilesetDocument;
  /**
   * Required only for a tileset that uses implicit tiling. Absent, an implicit
   * tile settles as a leaf with a warning rather than failing the load — the
   * rest of the tileset is still worth drawing.
   */
  readonly loadSubtree?: LoadSubtreeBytes;
  /**
   * Points assumed for a tile whose content has not been read yet.
   *
   * A `tileset.json` declares NO point counts — they live in the `.pnts`
   * feature table or the glTF accessor, both of which cost the whole tile. The
   * scheduler needs a number before it fetches, both to charge the budget and
   * because `view.ts` skips a node whose count is 0 outright. So a nominal is
   * seeded and corrected from the decode; see DEC-T3.
   *
   * 65,536 rather than a rounder number because it is the order of magnitude a
   * tiler actually writes: py3dtiles' lion_takanawa tiles run 241 to 241,983.
   */
  readonly nominalPointCount?: number;
  /** How deep a chain of external tilesets to follow. Default 8. */
  readonly maxExternalDepth?: number;
  /**
   * What to do with `refine`.
   *
   * `"as-declared"` (default) honours the tileset, which is conformance and is
   * what Cesium draws. `"add"` ignores REPLACE and draws every admitted tile.
   *
   * The option exists because the two are NOT close on real output, and the
   * gap is measured rather than argued. On py3dtiles' tiling of
   * `lion_takanawa` — 275,855 distinct positions, matching the source exactly —
   *
   *   as-declared : 247,821 distinct points ever drawn, 10.16% never seen
   *   add         : 275,855 drawn, of which 25.18% drawn twice
   *
   * because that file's refinement is genuinely MIXED: the two coarse layers at
   * the top are true stand-ins, and below them only about a third of each
   * internal tile's points reappear in its children. The default stays
   * `"as-declared"` — the points that go unseen go unseen in every viewer, and
   * that is the tiler's bug rather than this reader's licence to invent.
   */
  readonly refineMode?: "as-declared" | "add";
  readonly warnings?: TilesetWarning[];
}

/**
 * A tile node. MUTABLE and stable in identity, the same choice
 * `createPagedOctree` makes and for the same reason: a node whose children
 * arrive later has to be able to receive them, and freezing turns a malformed
 * file into a `TypeError` where a warning belongs.
 */
class TileNode implements PointCloudNode {
  childMask: number | undefined;
  children: (PointCloudNode | undefined)[] = [];
  parent: PointCloudNode | undefined;
  numPoints: number;

  constructor(
    readonly index: number,
    readonly name: string,
    readonly level: number,
    readonly minX: number,
    readonly minY: number,
    readonly minZ: number,
    readonly maxX: number,
    readonly maxY: number,
    readonly maxZ: number,
    numPoints: number,
    childMask: number | undefined,
    parent: PointCloudNode | undefined,
  ) {
    this.numPoints = numPoints;
    this.childMask = childMask;
    this.parent = parent;
  }
}

export interface TilesetTree extends PointCloudTreeBase {
  /** The tile behind a node, for the reader. */
  tile(index: number): Tile | undefined;
  /**
   * Record what a decoded tile actually held.
   *
   * The other half of DEC-T3 and of the measured pitch: both numbers are only
   * knowable once the content has been read, and both are side arrays because
   * the scheduler reads them per frame from an index.
   */
  observe(index: number, numPoints: number, pitch: number): void;
  readonly warnings: readonly TilesetWarning[];
  /** Whether every tile's count is the real one rather than the nominal. */
  readonly countsExact: boolean;
}

class Tree implements TilesetTree {
  private readonly nodes: TileNode[] = [];
  private readonly tiles: Tile[] = [];
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly failed = new Map<number, VoxelkloudError>();
  private readonly observed = new Set<number>();
  private capacity = 0;
  private disposed = false;
  private controller = new AbortController();

  geometricError!: Float64Array;
  spacing!: Float64Array;
  radius!: Float64Array;
  counts!: Float64Array;
  replaces!: Uint8Array;

  readonly warnings: TilesetWarning[];

  constructor(
    private readonly table: TileTable,
    private readonly options: TilesetTreeOptions,
  ) {
    this.warnings = options.warnings ?? [];
    const parsedTiles = table.tiles.slice();
    this.grow(parsedTiles.length);
    this.addTiles(parsedTiles, undefined);
    table.observe = (i, n, pitch) => { this.observe(i, n, pitch); };
    if (this.nodes.length === 0) {
      throw new VoxelkloudError(
        "hierarchy-error",
        "The tileset has no root tile.",
        { path: "tileset.json" },
      );
    }
  }

  // ── the arrays ──────────────────────────────────────────────────────────

  private grow(needed: number): void {
    if (needed <= this.capacity) return;
    let cap = Math.max(this.capacity, 64);
    while (cap < needed) cap *= 2;
    const err = new Float64Array(cap);
    const spc = new Float64Array(cap);
    const rad = new Float64Array(cap);
    const cnt = new Float64Array(cap);
    const rep = new Uint8Array(cap);
    if (this.capacity > 0) {
      err.set(this.geometricError);
      spc.set(this.spacing);
      rad.set(this.radius);
      cnt.set(this.counts);
      rep.set(this.replaces);
    }
    this.geometricError = err;
    this.spacing = spc;
    this.radius = rad;
    this.counts = cnt;
    this.replaces = rep;
    this.capacity = cap;
  }

  /**
   * Materialise one document's tiles.
   *
   * `graftUnder` is the node an external tileset's root hangs from. The tiles
   * arrive with indices already assigned by `parseTileset`, so this only has to
   * build nodes and wire them.
   */
  private addTiles(tiles: readonly Tile[], graftUnder: TileNode | undefined): void {
    if (tiles.length === 0) return;
    this.grow(tiles[tiles.length - 1]!.index + 1);
    const nominal = this.options.nominalPointCount ?? 65_536;

    for (const t of tiles) {
      const parent =
        t.parentIndex !== undefined ? this.nodes[t.parentIndex] : graftUnder;
      // A tile that refers OUT has children nobody has seen yet, so its mask
      // stays unknown and the scheduler will ask for an expansion.
      const external = t.contentKind === "tileset" || t.implicitTiling !== undefined;
      const node = new TileNode(
        t.index,
        t.name,
        t.level,
        t.bounds.minX,
        t.bounds.minY,
        t.bounds.minZ,
        t.bounds.maxX,
        t.bounds.maxY,
        t.bounds.maxZ,
        // A tile with no content of its own has NO points of its own: py3dtiles
        // writes chains of five such tiles, and seeding those with a nominal
        // would charge the budget for nodes that can never draw.
        t.contentUri !== undefined && !external ? nominal : 0,
        external ? undefined : t.childIndices.length,
        parent,
      );
      this.nodes[t.index] = node;
      this.tiles[t.index] = t;
      this.table.tiles[t.index] = t;
      this.geometricError[t.index] = t.refinementError;
      this.spacing[t.index] = t.pitch;
      this.radius[t.index] = t.bounds.radius;
      this.counts[t.index] = node.numPoints;
      this.replaces[t.index] =
        t.refine === "REPLACE" && this.options.refineMode !== "add" ? 1 : 0;
      if (parent !== undefined && parent.children.indexOf(node) < 0) {
        parent.children.push(node);
        parent.childMask = parent.children.length;
      }
    }
  }

  // ── the contract ────────────────────────────────────────────────────────

  get nodeCount(): number {
    return this.nodes.length;
  }
  get root(): PointCloudNode {
    return this.nodes[0]!;
  }
  get maxLevel(): number {
    let m = 0;
    for (const n of this.nodes) if (n !== undefined && n.level > m) m = n.level;
    return m;
  }
  node(index: number): PointCloudNode | undefined {
    return this.nodes[index];
  }
  tile(index: number): Tile | undefined {
    return this.tiles[index];
  }

  // Closed forms nothing here uses, because every quantity is per-node. They
  // exist because the contract has them and a caller may reach for one before
  // the arrays are consulted; each returns the ROOT's value, which is the only
  // level-wide number a tileset has.
  geometricErrorAt(level: number): number {
    return this.geometricError[0]! / 2 ** level;
  }
  pointSpacingAt(level: number): number {
    return this.spacing[0]! / 2 ** level;
  }
  boundingRadiusAt(level: number): number {
    return this.radius[0]! / 2 ** level;
  }

  get nodeGeometricError(): Float64Array {
    return this.geometricError;
  }
  get nodePointSpacing(): Float64Array {
    return this.spacing;
  }
  get nodeBoundingRadius(): Float64Array {
    return this.radius;
  }
  get nodePointCount(): Float64Array {
    return this.counts;
  }
  get nodeReplaces(): Uint8Array {
    return this.replaces;
  }
  /**
   * 16 device pixels — Cesium's `maximumScreenSpaceError` default, which is the
   * number every tileset in the world was authored against. The 1.35 px that
   * `metric.ts` calibrates is a POINT SPACING; a tile error is a different
   * quantity and wants a different threshold, which is exactly why A4 put this
   * on the driver.
   */
  get defaultScreenError(): number {
    return 16;
  }

  get countsExact(): boolean {
    let n = 0;
    for (const t of this.tiles) if (t?.contentUri !== undefined) n++;
    return this.observed.size >= n;
  }

  observe(index: number, numPoints: number, pitch: number): void {
    const node = this.nodes[index];
    if (node === undefined) return;
    node.numPoints = numPoints;
    this.counts[index] = numPoints;
    if (pitch > 0 && Number.isFinite(pitch)) this.spacing[index] = pitch;
    this.observed.add(index);
  }

  tryExpandSync(node: PointCloudNode): boolean {
    // Within a document every child is already here, so the only node that can
    // answer "not yet" is one waiting on an external tileset.
    return node.childMask !== undefined;
  }

  requestExpand(node: PointCloudNode, signal?: AbortSignal): void {
    if (node.childMask !== undefined) return;
    void this.expand(node, signal !== undefined ? { signal } : {}).catch(() => {
      // Fire and forget by contract. The failure is recorded on the node and
      // surfaced through `expand`, which is where a caller that wants it looks.
    });
  }

  async expand(
    node: PointCloudNode,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PointCloudNode> {
    if (node.childMask !== undefined) return node;
    const index = node.index;
    const failure = this.failed.get(index);
    if (failure !== undefined) throw failure;

    const existing = this.inFlight.get(index);
    if (existing !== undefined) {
      await existing;
      return this.nodes[index] ?? node;
    }

    const run = this.fetchExternal(index, options.signal);
    this.inFlight.set(index, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(index);
    }
    return this.nodes[index] ?? node;
  }

  private async fetchExternal(index: number, signal?: AbortSignal): Promise<void> {
    const tile = this.tiles[index];
    const node = this.nodes[index];
    if (tile === undefined || node === undefined) return;
    if (tile.implicitTiling !== undefined) {
      await this.fetchSubtree(index, tile, node, signal);
      return;
    }

    const uri = tile.contentUri;
    if (uri === undefined) {
      node.childMask = node.children.length;
      return;
    }

    const depth = this.externalDepthOf(index);
    const maxDepth = this.options.maxExternalDepth ?? 8;
    if (depth >= maxDepth) {
      this.warnings.push({
        code: "external-tileset-depth",
        message:
          `Stopped following external tilesets at ${uri}: the chain is ` +
          `${depth} deep, past the ${maxDepth} this driver follows. Each link ` +
          `is a round trip that cannot start until the one before it lands.`,
        path: tile.name,
      });
      node.childMask = node.children.length;
      return;
    }

    try {
      const merged = signal ?? this.controller.signal;
      const json = await this.options.loadDocument(uri, merged);
      if (this.disposed) return;
      const parsed = parseTileset(json, {
        baseUrl: uri,
        startIndex: this.nodes.length,
        namePrefix: `${tile.name}!`,
        startLevel: tile.level + 1,
        parentTransform: tile.transform,
        parentGeometricError: tile.geometricError,
        parentIndex: index,
        parentRefine: tile.refine,
      });
      this.warnings.push(...parsed.warnings);
      this.addTiles(parsed.tiles, node);
      node.childMask = node.children.length;
    } catch (error) {
      const err = isVoxelkloudError(error)
        ? error
        : new VoxelkloudError(
            "hierarchy-error",
            `Could not load the external tileset ${uri}: ${String(error)}`,
            { path: tile.name, cause: error },
          );
      // TERMINAL for this node, never a per-frame retry: `requestExpand` is
      // called from the render loop, and a transient failure that retried every
      // frame is the request storm the reference is known for.
      this.failed.set(index, err);
      node.childMask = node.children.length;
      throw err;
    }
  }

  /**
   * Expand an implicit tile by fetching the `.subtree` that says what exists.
   *
   * The declaring tile supplies the rule; the file supplies the availability.
   * Everything between them — the boxes, the content URIs, the names — is
   * generated, so what comes back is ordinary tiles and nothing downstream can
   * tell they were not written out.
   */
  private async fetchSubtree(
    index: number,
    tile: Tile,
    node: TileNode,
    signal?: AbortSignal,
  ): Promise<void> {
    const declared = tile.implicitTiling!;
    const scheme: SubdivisionScheme =
      declared.subdivisionScheme === "QUADTREE" ? "QUADTREE" : "OCTREE";
    const subtreeLevels = declared.subtreeLevels ?? 0;
    // 1.0's extension spelled the depth as `maximumLevel`, one LESS than 1.1's
    // `availableLevels`. Reading one as the other is an off-by-one that shows
    // up as a missing bottom level, which is easy to mistake for sparseness.
    const availableLevels =
      declared.availableLevels ??
      (declared.maximumLevel !== undefined ? declared.maximumLevel + 1 : 0);

    const context: ImplicitContext = tile.implicit?.context ?? {
      scheme,
      subtreeLevels,
      availableLevels,
      subtreeTemplate: declared.subtrees?.uri,
      contentTemplate: tile.contentTemplate,
      rootVolume: tile.volumeJson ?? { box: [] },
      rootGeometricError: tile.geometricError,
      transform: tile.transform,
      refine: tile.refine,
      // The DOCUMENT's URL, not the content's: a template is resolved against
      // the tileset that declared it, exactly like any other relative URI.
      baseUrl: tile.documentUrl,
      rootName: tile.name,
      rootLevel: tile.level,
    };
    const coord: ImplicitCoord = tile.implicit?.coord ?? {
      level: 0,
      x: 0,
      y: 0,
      z: 0,
    };

    const load = this.options.loadSubtree;
    const url = subtreeUrl(context, coord);
    if (load === undefined || url === undefined || subtreeLevels <= 0) {
      this.warnings.push({
        code: "content-unsupported",
        message:
          load === undefined
            ? `Tile ${tile.name} uses implicit tiling, but no subtree loader ` +
              `was supplied, so its subtree is unreadable and it draws as a ` +
              `leaf. Pass \`loadSubtree\` to open it.`
            : `Tile ${tile.name} declares implicit tiling without a usable ` +
              `subtree template or level count; it draws as a leaf.`,
        path: tile.name,
      });
      node.childMask = node.children.length;
      return;
    }

    try {
      const bytes = await load(url, signal ?? this.controller.signal);
      if (this.disposed) return;
      const subtree = readSubtree(bytes, {
        scheme: context.scheme,
        subtreeLevels: context.subtreeLevels,
        path: url,
      });
      const generated = generateSubtreeTiles(subtree, {
        context,
        rootCoord: coord,
        parentIndex: index,
        startIndex: this.nodes.length,
        parentGeometricError: tile.refinementError,
      });
      this.addTiles(generated, node);
      node.childMask = node.children.length;
    } catch (error) {
      const err = isVoxelkloudError(error)
        ? error
        : new VoxelkloudError(
            "hierarchy-error",
            `Could not load the subtree ${url}: ${String(error)}`,
            { path: tile.name, cause: error },
          );
      this.failed.set(index, err);
      node.childMask = node.children.length;
      throw err;
    }
  }

  /** How many external hops led to this tile. */
  private externalDepthOf(index: number): number {
    let depth = 0;
    let at: PointCloudNode | undefined = this.nodes[index];
    while (at !== undefined) {
      if (this.tiles[at.index]?.contentKind === "tileset") depth++;
      at = at.parent;
    }
    return depth;
  }

  async expandAll(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    // Breadth-wise and repeated: expanding one external tileset can reveal
    // more, and a single pass over the nodes present at entry would miss them.
    for (;;) {
      const pending = this.nodes.filter((n) => n !== undefined && n.childMask === undefined);
      if (pending.length === 0) return;
      const results = await Promise.allSettled(
        pending.map((n) => this.expand(n, options)),
      );
      // A failure is recorded and the node settled, so the loop terminates
      // whether or not every document was reachable.
      if (results.every((r) => r.status === "rejected")) return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.inFlight.clear();
  }
}

/** Build the tree over a table already holding the root document's tiles. */
export function createTilesetTree(
  table: TileTable,
  options: TilesetTreeOptions,
): TilesetTree {
  return new Tree(table, options);
}

/** A table seeded with one parsed document. */
export function createTileTable(tiles: readonly Tile[]): TileTable {
  return { tiles: tiles.slice() };
}
