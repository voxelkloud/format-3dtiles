// The driver end to end, over a local file server that is only `fetch`.
//
// The point of this file is that NOTHING below it knows the format: the tree is
// a `PointCloudTreeBase`, the reader is a `PointReader`, and what comes out is
// the same `DecodedPointData` the Potree, COPC and EPT drivers produce. If the
// seams from A5/A6/B2 hold, this is the last file that says "3D Tiles".

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tilesetFormat } from "./format.js";
import type { TilesetTree } from "./hierarchy.js";
import type { TilesetSource } from "./types.js";

const LION_DIR = new URL("../../../demo/data/_tiles/lion-las/", import.meta.url)
  .pathname;
const HAS_LION = existsSync(`${LION_DIR}tileset.json`);
const BROKEN_DIR = new URL("../../../demo/data/_tiles/lion/", import.meta.url).pathname;
const HAS_BROKEN = existsSync(`${BROKEN_DIR}tileset.json`);
const SAMPLES = new URL("../../../demo/data/_tiles/cesium-samples/", import.meta.url)
  .pathname;
const HAS_SAMPLES = existsSync(`${SAMPLES}1.0/TilesetWithRequestVolume/tileset.json`);

/**
 * `fetch` over the filesystem, with Range support.
 *
 * Not a mock of the driver's own behaviour: the driver issues real requests
 * with real headers and this answers them the way a static host does, which is
 * what makes the ranged attribute probe a thing that is actually exercised.
 */
function fileFetch(root: string) {
  const served: string[] = [];
  const fn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    served.push(path.replace(root, ""));
    if (!existsSync(path)) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
    const body = new Uint8Array(readFileSync(path));
    const range = new Headers(init?.headers).get("Range");
    if (range !== null) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m !== null) {
        const start = Number(m[1]);
        const end = m[2] === "" ? body.byteLength - 1 : Number(m[2]);
        const slice = body.subarray(start, Math.min(end + 1, body.byteLength));
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${start + slice.byteLength - 1}/${body.byteLength}`,
          },
        });
      }
    }
    return new Response(body, { status: 200 });
  };
  return { fn, served };
}

describe("the registry entry", () => {
  it("ranks a tileset.json above a bare directory", () => {
    expect(tilesetFormat.sniffUrl("https://x.test/a/tileset.json")).toBe(2);
    expect(tilesetFormat.sniffUrl("https://x.test/a/")).toBe(1);
    expect(tilesetFormat.sniffUrl("https://x.test/a/ept.json")).toBe(0);
    expect(tilesetFormat.sniffUrl("https://x.test/a.copc.laz")).toBe(0);
  });

  it("asks for tileset.json under a bare directory", () => {
    expect(tilesetFormat.probeUrl("https://x.test/a/")).toBe(
      "https://x.test/a/tileset.json",
    );
    expect(tilesetFormat.probeUrl("https://x.test/a/tileset.json")).toBe(
      "https://x.test/a/tileset.json",
    );
  });

  const probe = (json: unknown) => ({
    url: "https://x.test/tileset.json",
    json,
    head: "",
    bytes: undefined,
    contentType: "application/json",
  });

  it("claims a tileset and declines everything else", () => {
    expect(
      tilesetFormat.sniff(
        probe({
          asset: { version: "1.1" },
          root: { geometricError: 4, boundingVolume: { box: [] } },
        }),
      ),
    ).toBe(3);
    // A glTF also has an `asset`, and is a document this driver reads — but not
    // a tileset. Claiming it would take the load away from whoever should get it.
    expect(tilesetFormat.sniff(probe({ asset: { version: "2.0" }, meshes: [] }))).toBe(0);
    expect(tilesetFormat.sniff(probe({ dataType: "laszip", hierarchyType: "json" }))).toBe(0);
    expect(tilesetFormat.sniff(probe(undefined))).toBe(0);
  });
});

describe.skipIf(!HAS_LION)("end to end over the lion tileset", () => {
  async function open() {
    const { fn, served } = fileFetch(LION_DIR);
    const source = (await tilesetFormat.load(`file://${LION_DIR}tileset.json`, {
      fetch: fn as never,
    })) as TilesetSource;
    return { source, served };
  }

  it("loads a source the renderer can read without knowing the format", async () => {
    const { source } = await open();
    expect(source.pointCount).toBeGreaterThan(0);
    expect(source.bounds.min).toHaveLength(3);
    expect(source.tightBoundingBox.max[2]).toBeGreaterThan(source.bounds.min[2]);
    expect(source.attributes.map((a) => a.name)).toEqual(["position", "rgb"]);
    expect(source.attributes[1]!.role).toBe("color");
    // py3dtiles writes a LOCAL tileset — no region, and a root transform that is
    // not an ECEF position — so there is no CRS to declare.
    expect(source.georeferenced).toBe(false);
    expect(source.crs).toBeUndefined();
  });

  it("costs exactly two requests to open", async () => {
    // The document, and the ranged probe of the first content tile. Anything
    // more is a round trip the driver invented.
    const { served } = await open();
    expect(served).toHaveLength(2);
    expect(served[0]).toBe("tileset.json");
    expect(served[1]).toBe("preview.pnts");
  });

  it("says the point count is an estimate rather than pretending", async () => {
    const { source } = await open();
    expect(source.warnings.map((w) => w.code)).toContain("point-count-estimated");
  });

  it("opens a tree and reads a tile through the neutral contract", async () => {
    const { source } = await open();
    const tree = await tilesetFormat.openTree(source);
    const reader = tilesetFormat.openPoints(source);

    expect(tree.nodeCount).toBe(67);
    expect(tree.defaultScreenError).toBe(16);

    // The largest tile in the tiling, 18,803 points.
    const biggest = tree.node(15)!;
    expect(biggest.name).toBe("r/0/2");
    expect(reader.hasPayload(biggest)).toBe(true);

    const data = await reader.read(biggest, { computeBounds: true });
    expect(data.numPoints).toBe(18_803);
    expect(data.positions).toHaveLength(3 * 18_803);
    expect(data.colors!.array).toHaveLength(4 * 18_803);
    expect(data.frame.originPolicy).toBe("cloud");
    expect(data.frame.origin).toEqual([
      source.bounds.min[0],
      source.bounds.min[1],
      source.bounds.min[2],
    ]);
    // Sub-millimetre, because the positions are relative. Absolute float32 at
    // this magnitude would already be coarser than the cloud's own detail.
    expect(data.frame.maxPositionError).toBeLessThan(1e-3);
    expect(data.bounds).toBeDefined();
    expect(data.transferList).toHaveLength(2);
    reader.dispose();
    tree.dispose();
  });

  it("corrects the tree's nominal count from the decode", async () => {
    // DEC-T3's second half, end to end: the scheduler charges the nominal until
    // a tile is read, and the real number the moment one is.
    const { source } = await open();
    const tree = await tilesetFormat.openTree(source);
    const reader = tilesetFormat.openPoints(source);

    const node = tree.node(2)!; // points/r0.pnts, 2,621 points
    expect(node.numPoints).toBe(65_536);
    const before = tree.nodePointSpacing![2];

    await reader.read(node);
    expect(tree.node(2)!.numPoints).toBe(2621);
    expect(tree.nodePointCount![2]).toBe(2621);
    // And the pitch is now MEASURED rather than the tile's declared error.
    expect(tree.nodePointSpacing![2]).not.toBe(before);
    expect(tree.nodePointSpacing![2]).toBeGreaterThan(0);
    reader.dispose();
    tree.dispose();
  });

  it("answers hasPayload for every tile of a healthy tiling", async () => {
    const { source } = await open();
    const tree = await tilesetFormat.openTree(source);
    const reader = tilesetFormat.openPoints(source);
    for (let i = 0; i < tree.nodeCount; i++) {
      expect(reader.hasPayload(tree.node(i)!), `node ${i}`).toBe(true);
    }
    reader.dispose();
    tree.dispose();
  });

  it("answers hasPayload FALSE for a content-less tile, and says 0 points", async () => {
    // The other tiling of the same cloud has a chain of five tiles with no
    // content at all. Not "no points yet" — no bytes, ever: the scheduler must
    // not dispatch them, and `view.ts` asks before it does.
    if (!HAS_BROKEN) return;
    const { fn } = fileFetch(BROKEN_DIR);
    const source = (await tilesetFormat.load(`file://${BROKEN_DIR}tileset.json`, {
      fetch: fn as never,
    })) as TilesetSource;
    const tree = await tilesetFormat.openTree(source);
    const reader = tilesetFormat.openPoints(source);
    let structural = 0;
    for (let i = 0; i < tree.nodeCount; i++) {
      const node = tree.node(i)!;
      if (!reader.hasPayload(node)) {
        expect(node.numPoints, node.name).toBe(0);
        structural++;
      }
    }
    expect(structural).toBe(5);
    reader.dispose();
    tree.dispose();
  });

  it("reads every tile, and the cloud comes back whole", async () => {
    // The differential again, but through the DRIVER rather than the parser:
    // fetch, decode, transform and write-back all run, and the 341,989 points
    // survive the round trip.
    const { source } = await open();
    const tree = await tilesetFormat.openTree(source);
    const reader = tilesetFormat.openPoints(source);

    let total = 0;
    let standIns = 0;
    for (let i = 0; i < tree.nodeCount; i++) {
      const node = tree.node(i)!;
      if (!reader.hasPayload(node)) continue;
      const data = await reader.read(node);
      total += data.numPoints;
      if (node.name === "r" || node.name === "r/0") standIns += data.numPoints;
    }
    expect(total - standIns).toBe(341_989);
    // `openTree` returns the NEUTRAL contract, so reaching for a driver-specific
    // fact is a deliberate cast rather than something the renderer could do.
    expect((tree as TilesetTree).countsExact).toBe(true);
    reader.dispose();
    tree.dispose();
  });
});

describe.skipIf(!HAS_SAMPLES)("external tilesets, end to end", () => {
  it("follows the reference and grafts the document on", async () => {
    const dir = `${SAMPLES}1.0/TilesetWithRequestVolume/`;
    const { fn } = fileFetch(dir);
    const source = (await tilesetFormat.load(`file://${dir}tileset.json`, {
      fetch: fn as never,
    })) as TilesetSource;
    const tree = await tilesetFormat.openTree(source);

    const before = tree.nodeCount;
    await tree.expandAll();
    expect(tree.nodeCount).toBeGreaterThan(before);
    // Everything is settled: no node still waiting to be asked about.
    for (let i = 0; i < tree.nodeCount; i++) {
      expect(tree.node(i)!.childMask, `node ${i}`).not.toBeUndefined();
    }
    tree.dispose();
  });
});
