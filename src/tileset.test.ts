import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyContent, parseTileset } from "./tileset.js";
import type { TilesetJson } from "./types.js";

/**
 * The Cesium sample tilesets, which this repo did not write.
 *
 * Not vendored: 52 MB of mostly meshes, cloned into the gitignored demo data.
 * Skipped rather than failed when absent, the same rule the loader's drift
 * guards follow.
 */
const SAMPLES = new URL(
  "../../../demo/data/_tiles/cesium-samples/",
  import.meta.url,
).pathname;
const HAS_SAMPLES = existsSync(`${SAMPLES}1.0/TilesetWithRequestVolume/tileset.json`);

function sample(path: string): TilesetJson {
  return JSON.parse(readFileSync(`${SAMPLES}${path}`, "utf8")) as TilesetJson;
}

const BASE = "https://example.test/t/tileset.json";

/** A minimal box volume: unit cube about the origin. */
const UNIT = { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };

function tileset(root: unknown, geometricError = 64): TilesetJson {
  return {
    asset: { version: "1.1" },
    geometricError,
    root,
  } as TilesetJson;
}

describe("classifyContent", () => {
  it("reads the extension, and treats a bare URI as glTF", () => {
    expect(classifyContent("a/b/points.pnts")).toBe("pnts");
    expect(classifyContent("tile.glb?v=2")).toBe("gltf");
    expect(classifyContent("model.gltf")).toBe("gltf");
    expect(classifyContent("sub/tileset.json")).toBe("tileset");
    expect(classifyContent("mesh.b3dm")).toBe("unsupported");
    expect(classifyContent("content/5/3/1")).toBe("gltf");
  });
});

describe("the geometric error enters shifted (DEC-T2)", () => {
  it("scores the root by the TILESET's error and a child by its parent's", () => {
    const parsed = parseTileset(
      tileset(
        {
          boundingVolume: UNIT,
          geometricError: 16,
          refine: "ADD",
          children: [{ boundingVolume: UNIT, geometricError: 4 }],
        },
        64,
      ),
      { baseUrl: BASE },
    );
    const [root, child] = parsed.tiles;
    expect(root!.geometricError).toBe(16);
    expect(root!.refinementError).toBe(64);
    expect(child!.geometricError).toBe(4);
    expect(child!.refinementError).toBe(16);
  });

  it("gives a zero-error leaf a NON-ZERO score", () => {
    // The failure this shift exists for. A leaf declares geometricError 0, and
    // the scheduler admits a child when its own error still projects above the
    // target — so unshifted, the finest level of every tileset is unreachable,
    // silently. Shifted, the leaf is scored by its parent and drawn.
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 16,
        refine: "REPLACE",
        children: [
          {
            boundingVolume: UNIT,
            geometricError: 0,
            content: { uri: "leaf.pnts" },
          },
        ],
      }),
      { baseUrl: BASE },
    );
    const leaf = parsed.tiles[1]!;
    expect(leaf.geometricError).toBe(0);
    expect(leaf.refinementError).toBe(16);
    expect(leaf.pitch).toBeGreaterThan(0);
  });

  it("keeps the score monotonic down the tree", () => {
    // What the scheduler assumes and does not re-check.
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 16,
        refine: "ADD",
        children: [
          {
            boundingVolume: UNIT,
            geometricError: 8,
            children: [{ boundingVolume: UNIT, geometricError: 2 }],
          },
        ],
      }),
      { baseUrl: BASE },
    );
    const scores = parsed.tiles.map((t) => t.refinementError);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});

describe("tolerated anomalies", () => {
  it("clamps a child whose error EXCEEDS its parent's, and says so", () => {
    // The spec forbids it; files do it. Throwing reads nothing, ignoring lies,
    // so it is clamped and reported.
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 8,
        refine: "ADD",
        children: [{ boundingVolume: UNIT, geometricError: 100 }],
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles[1]!.geometricError).toBe(8);
    expect(parsed.warnings.map((w) => w.code)).toContain(
      "geometric-error-not-monotonic",
    );
  });

  it("inherits the parent's box when a tile's volume is unreadable", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
        geometricError: 8,
        refine: "ADD",
        children: [{ geometricError: 4 }],
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles).toHaveLength(2);
    expect(parsed.tiles[1]!.bounds.maxX).toBe(5);
    expect(parsed.warnings.map((w) => w.code)).toContain(
      "tile-missing-bounding-volume",
    );
  });

  it("warns when the root declares no refine", () => {
    const parsed = parseTileset(
      tileset({ boundingVolume: UNIT, geometricError: 8 }),
      { baseUrl: BASE },
    );
    expect(parsed.warnings.map((w) => w.code)).toContain("refine-missing-on-root");
    expect(parsed.tiles[0]!.refine).toBe("REPLACE");
  });

  it("warns on a required extension it cannot honour", () => {
    const json = {
      ...tileset({ boundingVolume: UNIT, geometricError: 8, refine: "ADD" }),
      extensionsRequired: ["3DTILES_draco_point_compression"],
    } as TilesetJson;
    const parsed = parseTileset(json, { baseUrl: BASE });
    const w = parsed.warnings.find((x) => x.code === "extension-unsupported");
    expect(w?.message).toContain("3DTILES_draco_point_compression");
  });

  it("names the unreadable content instead of dropping the tile", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 8,
        refine: "ADD",
        content: { uri: "building.b3dm" },
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles).toHaveLength(1);
    expect(parsed.tiles[0]!.contentKind).toBe("unsupported");
    expect(parsed.warnings.map((w) => w.code)).toContain("content-unsupported");
  });
});

describe("refine, transforms and URIs", () => {
  it("inherits refine from the nearest ancestor that declares it", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 16,
        refine: "REPLACE",
        children: [
          {
            boundingVolume: UNIT,
            geometricError: 8,
            refine: "ADD",
            children: [{ boundingVolume: UNIT, geometricError: 4 }],
          },
          { boundingVolume: UNIT, geometricError: 8 },
        ],
      }),
      { baseUrl: BASE },
    );
    const byName = new Map(parsed.tiles.map((t) => [t.name, t]));
    expect(byName.get("r")!.refine).toBe("REPLACE");
    expect(byName.get("r/0")!.refine).toBe("ADD");
    // Inherited from r/0, NOT from the root.
    expect(byName.get("r/0/0")!.refine).toBe("ADD");
    expect(byName.get("r/1")!.refine).toBe("REPLACE");
  });

  it("accepts lowercase refine", () => {
    const parsed = parseTileset(
      tileset({ boundingVolume: UNIT, geometricError: 8, refine: "add" }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles[0]!.refine).toBe("ADD");
  });

  it("composes the transform chain down the tree", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 16,
        refine: "ADD",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
        children: [
          {
            boundingVolume: UNIT,
            geometricError: 8,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
          },
        ],
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles[0]!.bounds.centreX).toBeCloseTo(10, 12);
    expect(parsed.tiles[1]!.bounds.centreX).toBeCloseTo(15, 12);
  });

  it("resolves content URIs against the DECLARING document", () => {
    // The classic 3D Tiles bug: a nested tileset changes the base, and a URI
    // resolved against the top-level document lands nowhere.
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 8,
        refine: "ADD",
        content: { uri: "points/0.pnts" },
      }),
      { baseUrl: "https://example.test/deep/sub/tileset.json" },
    );
    expect(parsed.tiles[0]!.contentUri).toBe(
      "https://example.test/deep/sub/points/0.pnts",
    );
  });

  it("reads 1.0's `url` spelling as well as 1.1's `uri`", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 8,
        refine: "ADD",
        content: { url: "old.pnts" } as never,
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles[0]!.contentKind).toBe("pnts");
  });

  it("names tiles by their path, in declared order", () => {
    const parsed = parseTileset(
      tileset({
        boundingVolume: UNIT,
        geometricError: 16,
        refine: "ADD",
        children: [
          { boundingVolume: UNIT, geometricError: 8 },
          { boundingVolume: UNIT, geometricError: 8 },
          { boundingVolume: UNIT, geometricError: 8 },
        ],
      }),
      { baseUrl: BASE },
    );
    expect(parsed.tiles.map((t) => t.name)).toEqual(["r", "r/0", "r/1", "r/2"]);
    expect(parsed.tiles[0]!.childIndices).toEqual([1, 2, 3]);
  });
});

describe.skipIf(!HAS_SAMPLES)("against the Cesium sample tilesets", () => {
  it("reads a 1.0 tileset with a .pnts child", () => {
    const parsed = parseTileset(sample("1.0/TilesetWithRequestVolume/tileset.json"), {
      baseUrl: `file://${SAMPLES}1.0/TilesetWithRequestVolume/tileset.json`,
    });
    expect(parsed.version).toBe("1.0");
    const pnts = parsed.tiles.filter((t) => t.contentKind === "pnts");
    expect(pnts).toHaveLength(1);
    expect(pnts[0]!.contentUri).toContain("points.pnts");
    // The same tileset refers out to a nested one, which is the case a driver
    // that resolves against the top-level document gets wrong.
    expect(parsed.tiles.some((t) => t.contentKind === "tileset")).toBe(true);
  });

  it("reads a georeferenced tileset as georeferenced", () => {
    const parsed = parseTileset(sample("1.0/TilesetWithDiscreteLOD/tileset.json"), {
      baseUrl: `file://${SAMPLES}1.0/TilesetWithDiscreteLOD/tileset.json`,
    });
    expect(parsed.georeferenced).toBe(true);
    // ECEF: every coordinate is a planet radius from the origin.
    const r = Math.hypot(
      parsed.tiles[0]!.bounds.centreX,
      parsed.tiles[0]!.bounds.centreY,
      parsed.tiles[0]!.bounds.centreZ,
    );
    expect(r).toBeGreaterThan(6_000_000);
    expect(r).toBeLessThan(6_500_000);
  });

  it("reads a local tileset as NOT georeferenced", () => {
    const parsed = parseTileset(sample("1.1/SparseImplicitQuadtree/tileset.json"), {
      baseUrl: `file://${SAMPLES}1.1/SparseImplicitQuadtree/tileset.json`,
    });
    expect(parsed.georeferenced).toBe(false);
  });

  it("carries implicitTiling through without resolving it", () => {
    // T4 starts here: the parse records the declaration, and nothing here
    // fetches a subtree.
    const parsed = parseTileset(sample("1.1/SparseImplicitOctree/tileset.json"), {
      baseUrl: `file://${SAMPLES}1.1/SparseImplicitOctree/tileset.json`,
    });
    const implicit = parsed.tiles.find((t) => t.implicitTiling !== undefined)!;
    expect(implicit.implicitTiling!.subdivisionScheme).toBe("OCTREE");
    expect(implicit.implicitTiling!.subtreeLevels).toBeGreaterThan(0);
    expect(parsed.tiles).toHaveLength(1);
  });

  it("parses every sample tileset without throwing", () => {
    // Breadth over depth: 27 documents written by the people who wrote the
    // spec, including ones this driver will refuse to draw. Refusing is fine;
    // throwing is not.
    const files = [
      "1.0/TilesetWithDiscreteLOD/tileset.json",
      "1.0/TilesetWithRequestVolume/tileset.json",
      "1.0/TilesetWithTreeBillboards/tileset.json",
      "1.1/MetadataGranularities/tileset.json",
      "1.1/MultipleContents/tileset.json",
      "1.1/SparseImplicitOctree/tileset.json",
      "1.1/SparseImplicitQuadtree/tileset.json",
      "1.1/TilesetWithFullMetadata/tileset.json",
    ];
    for (const f of files) {
      const parsed = parseTileset(sample(f), { baseUrl: `file://${SAMPLES}${f}` });
      expect(parsed.tiles.length, f).toBeGreaterThan(0);
      for (const t of parsed.tiles) {
        expect(Number.isFinite(t.bounds.minX), `${f} ${t.name}`).toBe(true);
        expect(t.bounds.radius, `${f} ${t.name}`).toBeGreaterThan(0);
        expect(t.pitch, `${f} ${t.name}`).toBeGreaterThan(0);
      }
    }
  });
});
