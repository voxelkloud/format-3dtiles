import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IDENTITY } from "./bounds.js";
import { decodePnts, pntsExtensions, readPntsHeader } from "./pnts.js";
import { parseTileset } from "./tileset.js";
import type { TilesetJson } from "./types.js";

const DATA = new URL("../../../demo/data/_tiles/", import.meta.url).pathname;
const SAMPLE = `${DATA}cesium-samples/1.0/TilesetWithRequestVolume/points.pnts`;
/**
 * TWO tilings of the same cloud, and the difference between them is a finding.
 *
 * `lion-las` is py3dtiles over a plain LAS and is the FIDELITY oracle: its
 * distinct world positions are exactly the source's. `lion` is py3dtiles over
 * the COPC twin of that same file and is NOT — it is kept because it is
 * pathological in ways a healthy tiling is not (a chain of content-less tiles,
 * and one leaf holding 241,983 records at a SINGLE coordinate), which is
 * exactly the input a driver has to survive. See the note in `plano-3d-tiles.md`.
 */
const LION = `${DATA}lion-las/tileset.json`;
const LION_BROKEN = `${DATA}lion/tileset.json`;
const HAS_SAMPLE = existsSync(SAMPLE);
const HAS_LION = existsSync(LION);
const HAS_BROKEN = existsSync(LION_BROKEN);

const ORIGIN: [number, number, number] = [0, 0, 0];

/** Build a `.pnts` in memory, so the decoder is tested on inputs we control. */
function buildPnts(
  featureTable: Record<string, unknown>,
  binary: Uint8Array,
  batchTable: Record<string, unknown> = {},
  batchBinary = new Uint8Array(0),
): Uint8Array {
  const enc = new TextEncoder();
  const pad = (b: Uint8Array) => {
    // The spec pads JSON sections to 8-byte boundaries with spaces.
    const extra = (8 - (b.byteLength % 8)) % 8;
    if (extra === 0) return b;
    const out = new Uint8Array(b.byteLength + extra);
    out.set(b);
    out.fill(0x20, b.byteLength);
    return out;
  };
  const ftJson = pad(enc.encode(JSON.stringify(featureTable)));
  const btJson =
    Object.keys(batchTable).length === 0
      ? new Uint8Array(0)
      : pad(enc.encode(JSON.stringify(batchTable)));
  const total =
    28 + ftJson.byteLength + binary.byteLength + btJson.byteLength + batchBinary.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(enc.encode("pnts"), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, ftJson.byteLength, true);
  dv.setUint32(16, binary.byteLength, true);
  dv.setUint32(20, btJson.byteLength, true);
  dv.setUint32(24, batchBinary.byteLength, true);
  let at = 28;
  out.set(ftJson, at);
  at += ftJson.byteLength;
  out.set(binary, at);
  at += binary.byteLength;
  out.set(btJson, at);
  at += btJson.byteLength;
  out.set(batchBinary, at);
  return out;
}

function f32(values: number[]): Uint8Array {
  const a = new Float32Array(values);
  return new Uint8Array(a.buffer);
}

describe("readPntsHeader", () => {
  it("splits the four sections", () => {
    const bytes = buildPnts(
      { POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } },
      f32([1, 2, 3]),
      { name: ["a"] },
      new Uint8Array([7, 7]),
    );
    const h = readPntsHeader(bytes);
    expect(h.version).toBe(1);
    expect(h.byteLength).toBe(bytes.byteLength);
    expect(h.featureTable.POINTS_LENGTH).toBe(1);
    expect(h.featureBinary.byteLength).toBe(12);
    expect(h.batchTable['name']).toEqual(["a"]);
    expect(Array.from(h.batchBinary)).toEqual([7, 7]);
  });

  it("refuses something that is not a .pnts", () => {
    const glb = new Uint8Array(32);
    glb.set(new TextEncoder().encode("glTF"), 0);
    expect(() => readPntsHeader(glb)).toThrow(/Not a \.pnts/);
    expect(() => readPntsHeader(new Uint8Array(4))).toThrow(/at least 28 bytes/);
  });
});

describe("decodePnts: positions", () => {
  it("emits float32 relative to the cloud origin", () => {
    const bytes = buildPnts(
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 } },
      f32([1, 2, 3, 4, 5, 6]),
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: [1, 1, 1] });
    expect(Array.from(d.positions)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(d.bounds.min).toEqual([1, 2, 3]);
    expect(d.bounds.max).toEqual([4, 5, 6]);
  });

  it("applies RTC_CENTER BEFORE the transform", () => {
    // Order matters and is easy to get backwards: RTC is in the tile's own
    // frame, so a rotation must turn it too. Reversed, a rotated tile with an
    // RTC centre lands somewhere else entirely.
    const rot = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // +90 about Z
    const bytes = buildPnts(
      { POINTS_LENGTH: 1, POSITION: { byteOffset: 0 }, RTC_CENTER: [10, 0, 0] },
      f32([1, 0, 0]),
    );
    const d = decodePnts(bytes, { transform: rot, origin: ORIGIN });
    // (1,0,0) + (10,0,0) = (11,0,0), turned a quarter turn -> (0,11,0).
    expect(d.positions[0]).toBeCloseTo(0, 4);
    expect(d.positions[1]).toBeCloseTo(11, 4);
  });

  it("decodes POSITION_QUANTIZED across the full uint16 range", () => {
    const q = new Uint16Array([0, 0, 0, 65535, 65535, 65535, 32768, 0, 0]);
    const bytes = buildPnts(
      {
        POINTS_LENGTH: 3,
        POSITION_QUANTIZED: { byteOffset: 0 },
        QUANTIZED_VOLUME_OFFSET: [-10, -10, -10],
        QUANTIZED_VOLUME_SCALE: [20, 20, 20],
      },
      new Uint8Array(q.buffer),
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    // 0 maps to the offset and 65535 to offset + scale, EXACTLY. Dividing by
    // 65536 instead would leave the far corner short by one quantum.
    expect(d.positions[0]).toBeCloseTo(-10, 4);
    expect(d.positions[3]).toBeCloseTo(10, 4);
    // The midpoint 32768 is a hair PAST centre, because 65535 is odd:
    // 32768/65535 * 20 - 10 = 1.5259e-4, not 0.
    expect(d.positions[6]).toBeCloseTo(1.5259e-4, 7);
  });

  it("refuses quantized positions with no volume", () => {
    const bytes = buildPnts(
      { POINTS_LENGTH: 1, POSITION_QUANTIZED: { byteOffset: 0 } },
      new Uint8Array(6),
    );
    expect(() => decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /QUANTIZED_VOLUME/,
    );
  });

  it("refuses a tile with no positions at all", () => {
    const bytes = buildPnts({ POINTS_LENGTH: 1 }, new Uint8Array(0));
    expect(() => decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /neither POSITION nor POSITION_QUANTIZED/,
    );
  });

  it("refuses an offset that runs past the section", () => {
    // Silently reading zeroes would put a cloud of points at the origin, which
    // is the failure mode that looks like data.
    const bytes = buildPnts(
      { POINTS_LENGTH: 100, POSITION: { byteOffset: 0 } },
      f32([1, 2, 3]),
    );
    expect(() => decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /feature table binary/,
    );
  });
});

describe("decodePnts: colour, in all four spellings", () => {
  const positions = f32([0, 0, 0, 1, 1, 1]);

  it("reads RGBA verbatim", () => {
    const bytes = buildPnts(
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RGBA: { byteOffset: 24 } },
      new Uint8Array([...positions, 1, 2, 3, 4, 5, 6, 7, 8]),
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("widens RGB with opaque alpha", () => {
    const bytes = buildPnts(
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RGB: { byteOffset: 24 } },
      new Uint8Array([...positions, 1, 2, 3, 4, 5, 6]),
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("widens RGB565 so full scale reaches 255", () => {
    // White must come out (255,255,255), not (248,252,248). Shifting instead of
    // scaling is the mistake, and it tints every bright surface.
    const white = 0xffff;
    const black = 0x0000;
    const rgb565 = new Uint16Array([white, black]);
    const bytes = buildPnts(
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RGB565: { byteOffset: 24 } },
      new Uint8Array([...positions, ...new Uint8Array(rgb565.buffer)]),
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(d.colors!.subarray(4, 8))).toEqual([0, 0, 0, 255]);
  });

  it("expands CONSTANT_RGBA to every point", () => {
    const bytes = buildPnts(
      {
        POINTS_LENGTH: 2,
        POSITION: { byteOffset: 0 },
        CONSTANT_RGBA: [10, 20, 30, 40],
      },
      positions,
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!)).toEqual([10, 20, 30, 40, 10, 20, 30, 40]);
  });

  it("returns no colour when the tile declares none", () => {
    const bytes = buildPnts({ POINTS_LENGTH: 2, POSITION: { byteOffset: 0 } }, positions);
    expect(decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN }).colors).toBeUndefined();
  });

  it("never aliases the input buffer", () => {
    // Every array must own fresh memory: the input may be detached the instant
    // a worker transfers it.
    const bin = new Uint8Array([...positions, 1, 2, 3, 4, 5, 6, 7, 8]);
    const bytes = buildPnts(
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RGBA: { byteOffset: 24 } },
      bin,
    );
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(d.colors!.buffer).not.toBe(bytes.buffer);
    expect(d.positions.buffer).not.toBe(bytes.buffer);
  });
});

describe.skipIf(!HAS_SAMPLE)("against Cesium's own points.pnts", () => {
  it("decodes 125,000 points with colour", () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE));
    const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(d.numPoints).toBe(125_000);
    expect(d.positions).toHaveLength(375_000);
    expect(d.colors).toHaveLength(500_000);
    expect(d.pitch).toBeGreaterThan(0);
    // The sample is a cube of points about the tile origin.
    for (const v of d.bounds.min) expect(v).toBeGreaterThan(-20);
    for (const v of d.bounds.max) expect(v).toBeLessThan(20);
  });
});

describe.skipIf(!HAS_LION)("the differential: lion_takanawa through a third tool", () => {
  /** Every tile of a tileset, decoded into ABSOLUTE coordinates. */
  function readTiles(manifest: string) {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as TilesetJson;
    const parsed = parseTileset(json, { baseUrl: `file://${manifest}` });
    return parsed.tiles.map((t) => {
      if (t.contentUri === undefined || t.contentKind !== "pnts") {
        return { tile: t, decoded: undefined };
      }
      const bytes = new Uint8Array(readFileSync(t.contentUri.replace("file://", "")));
      return {
        tile: t,
        decoded: decodePnts(bytes, {
          transform: t.transform,
          origin: ORIGIN,
          path: t.name,
        }),
      };
    });
  }

  /** Distinct positions to a tenth of a millimetre, across every tile. */
  function distinctPositions(manifest: string): Set<string> {
    const out = new Set<string>();
    for (const { decoded } of readTiles(manifest)) {
      if (decoded === undefined) continue;
      for (let i = 0; i < decoded.numPoints; i++) {
        out.add(
          `${decoded.positions[3 * i]!.toFixed(3)},` +
            `${decoded.positions[3 * i + 1]!.toFixed(3)},` +
            `${decoded.positions[3 * i + 2]!.toFixed(3)}`,
        );
      }
    }
    return out;
  }

  it("reproduces the source cloud's distinct positions exactly", () => {
    // THE DIFFERENTIAL, and it is about POSITIONS rather than record counts.
    // The source has 341,989 records at 275,855 distinct positions — a scan
    // quantised to 0.01 m has coincident points, which is normal. A faithful
    // tiling of it must contain those same 275,855 and no others.
    //
    // Counting records instead would have passed on a tiling where 71% of them
    // were one coordinate repeated. That is not hypothetical: see LION_BROKEN.
    expect(distinctPositions(LION).size).toBe(275_855);
  });

  it("parses what py3dtiles wrote, N-ary and all", () => {
    const tiles = readTiles(LION).map((t) => t.tile);
    expect(tiles.length).toBe(67);
    // Every fanout from 1 to 8 appears. A driver that counted to eight would
    // survive this file; one that assumed eight would not.
    const fanouts = new Set(tiles.map((t) => t.childIndices.length));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(fanouts.has(n), `fanout ${n}`).toBe(true);
    }
  });

  it("gives every leaf a non-zero score, which py3dtiles does not", () => {
    // DEC-T2 against a real generator rather than the spec: ALL 55 leaves here
    // declare geometricError 0. Unshifted, none would ever be drawn.
    const tiles = readTiles(LION).map((t) => t.tile);
    const leaves = tiles.filter((t) => t.childIndices.length === 0);
    expect(leaves).toHaveLength(55);
    for (const leaf of leaves) {
      expect(leaf.geometricError, leaf.name).toBe(0);
      expect(leaf.refinementError, leaf.name).toBeGreaterThan(0);
      expect(leaf.pitch, leaf.name).toBeGreaterThan(0);
    }
  });

  it("puts every tile's points inside the box the tileset declared", () => {
    // The transform chain, checked against the tileset's own arithmetic: the
    // bounding volume and the points go through DIFFERENT code paths here, so
    // agreement is evidence and not a tautology.
    let checked = 0;
    for (const { tile, decoded } of readTiles(LION)) {
      if (decoded === undefined || decoded.numPoints === 0) continue;
      const slack = 1e-3;
      expect(decoded.bounds.min[0], tile.name).toBeGreaterThanOrEqual(
        tile.bounds.minX - slack,
      );
      expect(decoded.bounds.max[0], tile.name).toBeLessThanOrEqual(
        tile.bounds.maxX + slack,
      );
      expect(decoded.bounds.min[2], tile.name).toBeGreaterThanOrEqual(
        tile.bounds.minZ - slack,
      );
      expect(decoded.bounds.max[2], tile.name).toBeLessThanOrEqual(
        tile.bounds.maxZ + slack,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("measures a pitch finer than the tile's own geometric error", () => {
    const internal = readTiles(LION).filter(
      (t) =>
        t.decoded !== undefined &&
        t.tile.geometricError > 0 &&
        t.decoded.numPoints > 500,
    );
    expect(internal.length).toBeGreaterThan(0);
    for (const { tile, decoded } of internal) {
      expect(decoded!.pitch, tile.name).toBeLessThan(tile.geometricError * 4);
    }
  });
});

describe.skipIf(!HAS_BROKEN)("a tiling that is wrong, and must not crash anything", () => {
  // py3dtiles reading the COPC twin of the same cloud produces this. It is kept
  // as a fixture precisely BECAUSE it is broken: a driver meets files like it,
  // and the failure has to be visible in the data rather than in a stack trace.
  function tiles() {
    const json = JSON.parse(readFileSync(LION_BROKEN, "utf8")) as TilesetJson;
    return parseTileset(json, { baseUrl: `file://${LION_BROKEN}` }).tiles;
  }

  it("parses a chain of content-less tiles", () => {
    const withoutContent = tiles().filter((t) => t.contentUri === undefined);
    expect(withoutContent).toHaveLength(5);
    for (const t of withoutContent) {
      // DEGENERATE, and legitimately so: every point below this tile is at one
      // coordinate, so its box has zero extent and its radius is 0. The
      // scheduler survives it — `d = max(|cam - centre| - 0, nearFloor)` — but
      // the PITCH must still be positive, or the arena would bucket a slab on
      // log2(0) and the material would draw points of no size.
      expect(t.bounds.radius).toBe(0);
      expect(t.pitch).toBeGreaterThan(0);
      expect(Number.isFinite(t.pitch)).toBe(true);
    }
  });

  it("decodes a tile whose points are all at one coordinate", () => {
    // 241,983 records, ONE distinct position. The decode must not divide by a
    // zero extent, and the measured pitch must stay finite and positive or the
    // arena would key a slab on NaN.
    const tile = tiles().find((t) => t.contentUri?.endsWith("r5544444.pnts"))!;
    const bytes = new Uint8Array(
      readFileSync(tile.contentUri!.replace("file://", "")),
    );
    const d = decodePnts(bytes, { transform: tile.transform, origin: ORIGIN });
    expect(d.numPoints).toBe(241_983);
    expect(d.bounds.min).toEqual(d.bounds.max);
    expect(Number.isFinite(d.pitch)).toBe(true);
    expect(d.pitch).toBeGreaterThan(0);
  });
});

const SURVEY = `${DATA}survey/`;
const HAS_SURVEY = existsSync(`${SURVEY}PointCloudRGB-pointCloudRGB.pnts`);

describe.skipIf(!HAS_SURVEY)("against every point cloud Cesium publishes", () => {
  // Six tilesets, downloaded rather than vendored, and between them they cover
  // the semantics a `.pnts` actually uses in the wild: RTC_CENTER on five of
  // six, CONSTANT_RGBA, NORMAL, BATCH_ID, and one Draco.
  const cases: Array<[string, number, boolean]> = [
    ["PointCloudRGB-pointCloudRGB", 1000, true],
    ["PointCloudBatched-pointCloudBatched", 1000, false],
    ["PointCloudConstantColor-pointCloudConstantColor", 1000, true],
    ["PointCloudNormals-pointCloudNormals", 1000, true],
    ["PointCloudWithPerPointProperties-pointCloudWithPerPointProperties", 1000, true],
  ];

  for (const [name, count, hasColor] of cases) {
    it(`decodes ${name.split("-")[0]}`, () => {
      const bytes = new Uint8Array(readFileSync(`${SURVEY}${name}.pnts`));
      const d = decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN });
      expect(d.numPoints).toBe(count);
      expect(d.colors !== undefined).toBe(hasColor);
      expect(d.pitch).toBeGreaterThan(0);
      // RTC_CENTER puts these tiles on the planet. A decoder that ignored it
      // would pile every tile at the origin, which is the classic 3D Tiles
      // symptom and looks like a camera bug rather than a decode bug.
      const r = Math.hypot(
        (d.bounds.min[0] + d.bounds.max[0]) / 2,
        (d.bounds.min[1] + d.bounds.max[1]) / 2,
        (d.bounds.min[2] + d.bounds.max[2]) / 2,
      );
      if (name.startsWith("PointCloudWithPerPoint")) {
        expect(r).toBeLessThan(100);
      } else {
        expect(r).toBeGreaterThan(6_000_000);
      }
    });
  }

  it("names Draco instead of drawing nothing", () => {
    // The one file of the six that needs a decoder this driver does not carry.
    // Kept as the fixture T6 will be written against.
    const bytes = new Uint8Array(
      readFileSync(`${SURVEY}PointCloudDraco-pointCloudDraco.pnts`),
    );
    const { featureTable } = readPntsHeader(bytes);
    expect(pntsExtensions(featureTable)).toEqual(["3DTILES_draco_point_compression"]);
    // And it must be caught BEFORE the position read: the file declares
    // POSITION at byteOffset 0 as a placeholder, so a decoder that trusted it
    // would return 1000 points of decompressed noise and no error at all.
    expect(() => decodePnts(bytes, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /Draco-compressed/,
    );
  });
});
