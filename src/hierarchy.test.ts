import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTileTable, createTilesetTree } from "./hierarchy.js";
import { parseTileset } from "./tileset.js";
import type { TilesetJson } from "./types.js";

// The FIDELITY oracle: py3dtiles over a plain LAS. See `pnts.test.ts` for why
// the COPC-derived tiling of the same cloud is not one.
const LION = new URL(
  "../../../demo/data/_tiles/lion-las/tileset.json",
  import.meta.url,
).pathname;
const HAS_LION = existsSync(LION);

const UNIT = { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
const BASE = "https://example.test/t/tileset.json";

function doc(root: unknown, geometricError = 64): TilesetJson {
  return { asset: { version: "1.1" }, geometricError, root } as TilesetJson;
}

function build(json: TilesetJson, loadDocument = async () => doc({})) {
  const parsed = parseTileset(json, { baseUrl: BASE });
  return createTilesetTree(createTileTable(parsed.tiles), {
    loadDocument: loadDocument as never,
    warnings: parsed.warnings,
  });
}

/** A three-level tree with a fanout of three and one content-less tile. */
const SIMPLE = doc({
  boundingVolume: UNIT,
  geometricError: 16,
  refine: "ADD",
  content: { uri: "r.pnts" },
  children: [
    { boundingVolume: UNIT, geometricError: 8, content: { uri: "a.pnts" } },
    { boundingVolume: UNIT, geometricError: 8 },
    {
      boundingVolume: UNIT,
      geometricError: 8,
      refine: "REPLACE",
      content: { uri: "c.pnts" },
      children: [{ boundingVolume: UNIT, geometricError: 0, content: { uri: "d.pnts" } }],
    },
  ],
});

describe("the tree the scheduler reads", () => {
  it("materialises a whole document at once", () => {
    // No lazy expansion INSIDE a document: an explicit tileset hands over its
    // whole structure in one JSON, so a node that has to be asked twice would
    // be a round trip invented for nothing.
    const tree = build(SIMPLE);
    expect(tree.nodeCount).toBe(5);
    expect(tree.root.childMask).toBe(3);
    expect(tree.tryExpandSync(tree.root)).toBe(true);
    expect(tree.maxLevel).toBe(2);
  });

  it("fills the four per-node arrays and no closed form", () => {
    const tree = build(SIMPLE);
    // The refinement quantity is the PARENT's error (DEC-T2), so the root
    // carries the tileset's and the leaf carries its parent's.
    expect(Array.from(tree.nodeGeometricError!.subarray(0, 5))).toEqual([
      64, 16, 16, 16, 8,
    ]);
    expect(tree.nodeBoundingRadius![0]).toBeCloseTo(Math.hypot(1, 1, 1), 12);
    expect(tree.nodePointSpacing![4]).toBeGreaterThan(0);
    expect(tree.nodeReplaces![3]).toBe(1);
    expect(tree.nodeReplaces![1]).toBe(0);
    // REPLACE is inherited, so the leaf under r/2 carries it too.
    expect(tree.nodeReplaces![4]).toBe(1);
  });

  it("gives a content-less tile ZERO points and a content tile the nominal", () => {
    // `view.ts` skips a node whose count is 0 before it fetches anything, which
    // is exactly right for a structural tile and exactly wrong for one whose
    // count is merely unknown.
    const tree = build(SIMPLE);
    expect(tree.node(2)!.numPoints).toBe(0);
    expect(tree.node(1)!.numPoints).toBe(65_536);
    expect(tree.nodePointCount![1]).toBe(65_536);
  });

  it("takes the observed count and pitch over the nominal", () => {
    const tree = build(SIMPLE);
    expect(tree.countsExact).toBe(false);
    tree.observe(1, 1234, 0.25);
    expect(tree.node(1)!.numPoints).toBe(1234);
    expect(tree.nodePointCount![1]).toBe(1234);
    expect(tree.nodePointSpacing![1]).toBe(0.25);
  });

  it("reports Cesium's default screen error, not the point-octree one", () => {
    // 16 device px is what every tileset in the world was authored against;
    // 1.35 px is a point SPACING and a different quantity entirely.
    expect(build(SIMPLE).defaultScreenError).toBe(16);
  });

  it("refuses a document with no root", () => {
    expect(() => build(doc(undefined))).toThrow(/no root tile/);
  });
});

describe("external tilesets", () => {
  const REFERRING = doc({
    boundingVolume: UNIT,
    geometricError: 16,
    refine: "ADD",
    content: { uri: "sub/tileset.json" },
  });

  const EXTERNAL = doc(
    {
      boundingVolume: UNIT,
      geometricError: 4,
      refine: "ADD",
      content: { uri: "deep.pnts" },
      children: [{ boundingVolume: UNIT, geometricError: 2, content: { uri: "x.pnts" } }],
    },
    8,
  );

  it("leaves the referring tile unexpanded until the document lands", () => {
    const tree = build(REFERRING);
    expect(tree.root.childMask).toBeUndefined();
    expect(tree.tryExpandSync(tree.root)).toBe(false);
    expect(tree.nodeCount).toBe(1);
  });

  it("grafts the external root as a child", async () => {
    const seen: string[] = [];
    const load = vi.fn(async (url: string) => {
      seen.push(url);
      return EXTERNAL;
    });
    const tree = build(REFERRING, load as never);
    await tree.expand(tree.root);

    expect(load).toHaveBeenCalledOnce();
    expect(seen).toEqual(["https://example.test/t/sub/tileset.json"]);
    expect(tree.root.childMask).toBe(1);
    expect(tree.nodeCount).toBe(3);
    const grafted = tree.node(1)!;
    expect(grafted.parent).toBe(tree.root);
    expect(grafted.level).toBe(1);
    // The referring tile's own error scores the grafted root, NOT the external
    // document's `geometricError` — the chain has to stay monotonic across the
    // seam or best-first stops being correct.
    expect(tree.nodeGeometricError![1]).toBe(16);
    expect(tree.nodeGeometricError![2]).toBe(4);
  });

  it("resolves the external document's URIs against ITSELF", () => {
    // The bug this format is famous for.
    const parsed = parseTileset(EXTERNAL, {
      baseUrl: "https://example.test/t/sub/tileset.json",
    });
    expect(parsed.tiles[0]!.contentUri).toBe(
      "https://example.test/t/sub/deep.pnts",
    );
  });

  it("dedupes concurrent expansions of the same tile", async () => {
    let resolve: (v: TilesetJson) => void = () => {};
    const load = vi.fn(
      () => new Promise<TilesetJson>((r) => { resolve = r; }),
    );
    const tree = build(REFERRING, load as never);
    const a = tree.expand(tree.root);
    const b = tree.expand(tree.root);
    resolve(EXTERNAL);
    await Promise.all([a, b]);
    expect(load).toHaveBeenCalledOnce();
    expect(tree.nodeCount).toBe(3);
  });

  it("settles a failed tile instead of retrying every frame", async () => {
    // `requestExpand` runs from the render loop. A transient failure that
    // retried on the next frame is the request storm the reference is known
    // for, so the node settles as a leaf and the error is kept.
    const load = vi.fn(async () => {
      throw new Error("504");
    });
    const tree = build(REFERRING, load as never);
    await expect(tree.expand(tree.root)).rejects.toThrow(/504/);
    expect(tree.root.childMask).toBe(0);
    expect(load).toHaveBeenCalledOnce();

    tree.requestExpand(tree.root);
    tree.requestExpand(tree.root);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
  });

  it("stops following a chain that never ends", async () => {
    // A tileset that refers to itself is a legal document and an infinite tree.
    const selfRef = doc({
      boundingVolume: UNIT,
      geometricError: 4,
      refine: "ADD",
      content: { uri: "tileset.json" },
    });
    const tree = build(selfRef, (async () => selfRef) as never);
    await tree.expandAll();
    expect(tree.nodeCount).toBeLessThan(12);
    expect(tree.warnings.map((w) => w.code)).toContain("external-tileset-depth");
  });

  it("expandAll reaches tiles that only exist after a fetch", async () => {
    const tree = build(REFERRING, (async () => EXTERNAL) as never);
    await tree.expandAll();
    expect(tree.nodeCount).toBe(3);
    for (let i = 0; i < tree.nodeCount; i++) {
      expect(tree.node(i)!.childMask, `node ${i}`).not.toBeUndefined();
    }
  });
});

describe.skipIf(!HAS_LION)("over the tileset py3dtiles wrote", () => {
  function lionTree() {
    const json = JSON.parse(readFileSync(LION, "utf8")) as TilesetJson;
    const parsed = parseTileset(json, { baseUrl: `file://${LION}` });
    return createTilesetTree(createTileTable(parsed.tiles), {
      loadDocument: async () => {
        throw new Error("no external tilesets here");
      },
      warnings: parsed.warnings,
    });
  }

  it("materialises all 67 tiles with no fetch at all", () => {
    const tree = lionTree();
    expect(tree.nodeCount).toBe(67);
    expect(tree.maxLevel).toBe(4);
    for (let i = 0; i < tree.nodeCount; i++) {
      expect(tree.tryExpandSync(tree.node(i)!), `node ${i}`).toBe(true);
    }
  });

  it("keeps the refinement score monotonic down every path", () => {
    const tree = lionTree();
    for (let i = 1; i < tree.nodeCount; i++) {
      const node = tree.node(i)!;
      const parent = node.parent!;
      expect(
        tree.nodeGeometricError![i],
        `${node.name} under ${parent.name}`,
      ).toBeLessThanOrEqual(tree.nodeGeometricError![parent.index]!);
    }
  });

  it("seeds every tile with the nominal count", () => {
    // A healthy py3dtiles tiling gives every tile content, so there is nothing
    // here that `hasPayload` has to answer no for — the content-less case is
    // exercised by the pathological fixture in `pnts.test.ts`.
    const tree = lionTree();
    for (let i = 0; i < tree.nodeCount; i++) {
      expect(tree.node(i)!.numPoints, tree.tile(i)!.name).toBe(65_536);
    }
  });
});

describe("refineMode", () => {
  const REPLACING = doc({
    boundingVolume: UNIT,
    geometricError: 16,
    refine: "REPLACE",
    content: { uri: "r.pnts" },
    children: [{ boundingVolume: UNIT, geometricError: 8, content: { uri: "a.pnts" } }],
  });

  it("marks REPLACE by default", () => {
    const parsed = parseTileset(REPLACING, { baseUrl: BASE });
    const tree = createTilesetTree(createTileTable(parsed.tiles), {
      loadDocument: (async () => doc({})) as never,
    });
    expect(Array.from(tree.nodeReplaces!.subarray(0, 2))).toEqual([1, 1]);
  });

  it('clears every mark under "add"', () => {
    // For the caller who would rather see 25% overdraw than lose 10% of the
    // points a mislabelled tiler hides. The number is in the option's doc.
    const parsed = parseTileset(REPLACING, { baseUrl: BASE });
    const tree = createTilesetTree(createTileTable(parsed.tiles), {
      loadDocument: (async () => doc({})) as never,
      refineMode: "add",
    });
    expect(Array.from(tree.nodeReplaces!.subarray(0, 2))).toEqual([0, 0]);
  });
});
