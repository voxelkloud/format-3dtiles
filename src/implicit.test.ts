import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IDENTITY, boundingVolumeToBounds } from "./bounds.js";
import { createTileTable, createTilesetTree } from "./hierarchy.js";
import { subdivideVolume, volumeAt } from "./implicit.js";
import type { ImplicitContext } from "./implicit.js";
import { parseTileset } from "./tileset.js";
import type { TilesetJson } from "./types.js";

const S = new URL("../../../demo/data/_tiles/cesium-samples/1.1/", import.meta.url)
  .pathname;
const QUAD = `${S}SparseImplicitQuadtree/`;
const OCT = `${S}SparseImplicitOctree/`;
const HAS = existsSync(`${QUAD}tileset.json`);

/** The unit box the samples use: centre at the origin, half-axes of 0.5. */
const UNIT_BOX = { box: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5] };

describe("subdivideVolume: box", () => {
  it("halves all three axes for an octree", () => {
    const child = subdivideVolume(UNIT_BOX, "OCTREE", 0);
    expect(child.box!.slice(3)).toEqual([0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.25]);
    // Bit 0 clear means the -X half, so the centre moves to -0.25.
    expect(child.box!.slice(0, 3)).toEqual([-0.25, -0.25, -0.25]);
    expect(subdivideVolume(UNIT_BOX, "OCTREE", 7).box!.slice(0, 3)).toEqual([
      0.25, 0.25, 0.25,
    ]);
  });

  it("leaves Z WHOLE for a quadtree", () => {
    // The reason this could not ride on `createPagedOctree`: that engine halves
    // a cube on all three axes and cannot be told to leave one alone.
    const child = subdivideVolume(UNIT_BOX, "QUADTREE", 3);
    expect(child.box!.slice(3)).toEqual([0.25, 0, 0, 0, 0.25, 0, 0, 0, 0.5]);
    expect(child.box!.slice(0, 3)).toEqual([0.25, 0.25, 0]);
  });

  it("halves an OBB in its OWN frame", () => {
    // A box rotated 45 degrees about Z: its half-axes are diagonal, and halving
    // them keeps the rotation. Halving the world-space envelope instead would
    // give children that do not tile their parent.
    const d = Math.SQRT1_2;
    const rotated = { box: [0, 0, 0, d, d, 0, -d, d, 0, 0, 0, 1] };
    const child = subdivideVolume(rotated, "OCTREE", 0);
    expect(child.box![3]).toBeCloseTo(d / 2, 12);
    expect(child.box![4]).toBeCloseTo(d / 2, 12);
    // The centre moved along the rotated axes, not along X and Y.
    expect(child.box![0]).toBeCloseTo(-d / 2 + d / 2, 12);
    expect(child.box![1]).toBeCloseTo(-d / 2 - d / 2, 12);
  });

  it("tiles its parent exactly: the four quadrants cover it and no more", () => {
    const parent = boundingVolumeToBounds(UNIT_BOX, IDENTITY)!;
    let area = 0;
    for (let c = 0; c < 4; c++) {
      const child = boundingVolumeToBounds(
        subdivideVolume(UNIT_BOX, "QUADTREE", c),
        IDENTITY,
      )!;
      expect(child.minX).toBeGreaterThanOrEqual(parent.minX - 1e-12);
      expect(child.maxX).toBeLessThanOrEqual(parent.maxX + 1e-12);
      area += (child.maxX - child.minX) * (child.maxY - child.minY);
    }
    expect(area).toBeCloseTo(
      (parent.maxX - parent.minX) * (parent.maxY - parent.minY),
      12,
    );
  });
});

describe("subdivideVolume: region", () => {
  const region = { region: [0, 0, 1, 1, 0, 100] };

  it("splits longitude and latitude, and height only for an octree", () => {
    expect(subdivideVolume(region, "QUADTREE", 0).region).toEqual([0, 0, 0.5, 0.5, 0, 100]);
    expect(subdivideVolume(region, "QUADTREE", 3).region).toEqual([0.5, 0.5, 1, 1, 0, 100]);
    expect(subdivideVolume(region, "OCTREE", 0).region).toEqual([0, 0, 0.5, 0.5, 0, 50]);
    expect(subdivideVolume(region, "OCTREE", 4).region).toEqual([0, 0, 0.5, 0.5, 50, 100]);
  });
});

describe("subdivideVolume: what it refuses", () => {
  it("names the sphere rather than guessing", () => {
    expect(() => subdivideVolume({ sphere: [0, 0, 0, 1] }, "OCTREE", 0)).toThrow(
      /"box" or a "region"/,
    );
  });
});

describe("volumeAt", () => {
  const context = {
    scheme: "QUADTREE",
    rootVolume: UNIT_BOX,
  } as unknown as ImplicitContext;

  it("descends the coordinate bit by bit, from the top", () => {
    // (2, 1, 0) at level 2 is x = 0b10, y = 0b01: right then left in X, left
    // then right in Y. Reading the bits from the BOTTOM instead lands in the
    // wrong quadrant, which looks like a tileset with its tiles shuffled.
    const v = volumeAt(context, { level: 2, x: 2, y: 1, z: 0 });
    expect(v.box!.slice(3, 9)).toEqual([0.125, 0, 0, 0, 0.125, 0]);
    expect(v.box![0]).toBeCloseTo(0.125, 12);
    expect(v.box![1]).toBeCloseTo(-0.125, 12);
  });

  it("returns the root's own volume at level 0", () => {
    expect(volumeAt(context, { level: 0, x: 0, y: 0, z: 0 })).toBe(UNIT_BOX);
  });
});

describe.skipIf(!HAS)("over Cesium's sparse implicit samples", () => {
  function open(dir: string) {
    const json = JSON.parse(readFileSync(`${dir}tileset.json`, "utf8")) as TilesetJson;
    const parsed = parseTileset(json, { baseUrl: `file://${dir}tileset.json` });
    const tree = createTilesetTree(createTileTable(parsed.tiles), {
      loadDocument: async () => {
        throw new Error("no external tilesets here");
      },
      loadSubtree: async (url) =>
        new Uint8Array(readFileSync(url.replace("file://", ""))),
      warnings: parsed.warnings,
    });
    return tree;
  }

  it("starts as ONE tile that has to be asked", () => {
    const tree = open(QUAD);
    expect(tree.nodeCount).toBe(1);
    // The whole tree is a rule until the first subtree lands.
    expect(tree.root.childMask).toBeUndefined();
    expect(tree.tryExpandSync(tree.root)).toBe(false);
  });

  it("expands the quadtree to exactly the tiles the bits allow", () => {
    const tree = open(QUAD);
    return tree.expandAll().then(() => {
      // The sample's README describes a sparse tree: 7 available tiles in the
      // root subtree, 8 child subtrees, and 7 tiles in each of those.
      expect(tree.nodeCount).toBe(7 + 8 * 7);
      expect(tree.maxLevel).toBe(5);
      for (let i = 0; i < tree.nodeCount; i++) {
        expect(tree.node(i)!.childMask, `node ${i}`).not.toBeUndefined();
      }
    });
  });

  it("gives every generated tile at most four children", () => {
    const tree = open(QUAD);
    return tree.expandAll().then(() => {
      for (let i = 0; i < tree.nodeCount; i++) {
        expect(tree.node(i)!.children.length, `node ${i}`).toBeLessThanOrEqual(4);
      }
    });
  });

  it("keeps the geometric error a closed form of the level", () => {
    // The one shape of 3D Tiles that would not have needed `nodeGeometricError`
    // at all: implicit tiling halves the error every level, by construction.
    const tree = open(QUAD);
    return tree.expandAll().then(() => {
      const root = tree.tile(0)!.geometricError;
      for (let i = 1; i < tree.nodeCount; i++) {
        const tile = tree.tile(i)!;
        const depth = tile.level;
        expect(tile.geometricError, tile.name).toBeCloseTo(root / 2 ** depth, 9);
      }
    });
  });

  it("points every generated content URI at a file that exists", () => {
    // The end of the whole chain: an availability bit, a Morton code, a level
    // offset, a template. Any one of them wrong lands on a name that is not
    // there — and a driver that shrugged would render an empty tileset.
    const tree = open(QUAD);
    return tree.expandAll().then(() => {
      let withContent = 0;
      for (let i = 0; i < tree.nodeCount; i++) {
        const uri = tree.tile(i)!.contentUri;
        if (uri === undefined) continue;
        expect(existsSync(uri.replace("file://", "")), uri).toBe(true);
        withContent++;
      }
      expect(withContent).toBe(32);
    });
  });

  it("expands the OCTREE sample, where children are eight", () => {
    const tree = open(OCT);
    return tree.expandAll().then(() => {
      expect(tree.nodeCount).toBeGreaterThan(1);
      let maxKids = 0;
      for (let i = 0; i < tree.nodeCount; i++) {
        maxKids = Math.max(maxKids, tree.node(i)!.children.length);
      }
      expect(maxKids).toBeGreaterThan(4);
      expect(maxKids).toBeLessThanOrEqual(8);
    });
  });

  it("settles as a leaf when no subtree loader was given", async () => {
    // The rest of a tileset is still worth drawing, so this warns rather than
    // failing the load.
    const json = JSON.parse(readFileSync(`${QUAD}tileset.json`, "utf8")) as TilesetJson;
    const parsed = parseTileset(json, { baseUrl: `file://${QUAD}tileset.json` });
    const tree = createTilesetTree(createTileTable(parsed.tiles), {
      loadDocument: async () => {
        throw new Error("unused");
      },
      warnings: parsed.warnings,
    });
    await tree.expandAll();
    expect(tree.root.childMask).toBe(0);
    expect(tree.warnings.some((w) => w.message.includes("loadSubtree"))).toBe(true);
  });
});
