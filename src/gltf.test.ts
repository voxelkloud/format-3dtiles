import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IDENTITY } from "./bounds.js";
import {
  Y_UP_TO_Z_UP,
  decodeGltfPoints,
  externalBufferUris,
  readGltf,
} from "./gltf.js";

const DATA = new URL("../../../demo/data/_tiles/", import.meta.url).pathname;
const LION_GLB = `${DATA}lion-points.glb`;
const SAMPLE_DIR = `${DATA}cesium-samples/glTF/EXT_structural_metadata/PropertyAttributesPointCloud/`;
const MESH_GLB = `${DATA}cesium-samples/1.1/SparseImplicitQuadtree/content/content_5__0_21.glb`;
const HAS_LION = existsSync(LION_GLB);
const HAS_SAMPLE = existsSync(`${SAMPLE_DIR}PropertyAttributesPointCloudTree.gltf`);
const HAS_MESH = existsSync(MESH_GLB);

const ORIGIN: [number, number, number] = [0, 0, 0];

/** Assemble a GLB around a JSON document and a binary chunk. */
function buildGlb(json: unknown, binary: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  let js = enc.encode(JSON.stringify(json));
  const jsPad = (4 - (js.byteLength % 4)) % 4;
  if (jsPad > 0) {
    const padded = new Uint8Array(js.byteLength + jsPad);
    padded.set(js);
    padded.fill(0x20, js.byteLength);
    js = padded;
  }
  const total = 12 + 8 + js.byteLength + 8 + binary.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, js.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20);
  dv.setUint32(20 + js.byteLength, binary.byteLength, true);
  dv.setUint32(24 + js.byteLength, 0x004e4942, true);
  out.set(binary, 28 + js.byteLength);
  return out;
}

/** A minimal POINTS document over a float32 position accessor. */
function pointsGlb(
  positions: number[],
  extra: Record<string, unknown> = {},
  binaryExtra = new Uint8Array(0),
): Uint8Array {
  const pos = new Uint8Array(new Float32Array(positions).buffer);
  const binary = new Uint8Array(pos.byteLength + binaryExtra.byteLength);
  binary.set(pos);
  binary.set(binaryExtra, pos.byteLength);
  return buildGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: positions.length / 3,
          type: "VEC3",
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
      buffers: [{ byteLength: binary.byteLength }],
      ...extra,
    },
    binary,
  );
}

describe("readGltf", () => {
  it("splits a GLB into its chunks", () => {
    const glb = pointsGlb([1, 2, 3]);
    const { json, binary } = readGltf(glb);
    expect(json.asset?.version).toBe("2.0");
    expect(binary.byteLength).toBe(12);
  });

  it("parses a plain .gltf, which has no binary chunk", () => {
    const doc = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" } }));
    expect(readGltf(doc).json.asset?.version).toBe("2.0");
    expect(readGltf(doc).binary.byteLength).toBe(0);
  });

  it("refuses a GLB that is not version 2", () => {
    const glb = pointsGlb([0, 0, 0]);
    new DataView(glb.buffer).setUint32(4, 1, true);
    expect(() => readGltf(glb)).toThrow(/version 1 is not version 2/);
  });

  it("refuses something that is neither", () => {
    expect(() => readGltf(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(
      /not JSON, so not a glTF/,
    );
  });
});

describe("decodeGltfPoints: the Y-up to Z-up rotation", () => {
  it("turns glTF's Y-up into 3D Tiles' Z-up", () => {
    // (x, y, z) becomes (x, -z, y). The one rotation a reader cannot skip:
    // without it a scan lies on its side, which looks like data.
    const d = decodeGltfPoints(pointsGlb([0, 1, 0, 0, 0, 1]), {
      transform: IDENTITY,
      origin: ORIGIN,
    });
    // glTF +Y (up) must come out as 3D Tiles +Z (up).
    expect(Array.from(d.positions.subarray(0, 3)).map(Math.round)).toEqual([0, 0, 1]);
    // glTF +Z must come out as -Y.
    expect(Array.from(d.positions.subarray(3, 6)).map(Math.round)).toEqual([0, -1, 0]);
  });

  it("is exactly the matrix the constant states", () => {
    expect(Array.from(Y_UP_TO_Z_UP)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  });

  it("composes the node chain under the rotation", () => {
    const glb = pointsGlb([1, 0, 0], {
      nodes: [{ mesh: 0, translation: [10, 0, 0] }],
    });
    const d = decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN });
    expect(d.positions[0]).toBeCloseTo(11, 4);
  });

  it("applies the TILE transform on top of the node chain", () => {
    const move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const d = decodeGltfPoints(pointsGlb([1, 0, 0]), {
      transform: move,
      origin: ORIGIN,
    });
    expect(d.positions[0]).toBeCloseTo(101, 4);
  });
});

describe("decodeGltfPoints: accessors", () => {
  it("reads an INTERLEAVED accessor by the view's byteStride", () => {
    // The failure this guards is quiet: reading interleaved data as packed
    // gives the right COUNT of plausible points, every one of them wrong.
    // Two points of (position, padding) at a stride of 16 bytes.
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    f[0] = 1; f[1] = 2; f[2] = 3; f[3] = 999;
    f[4] = 4; f[5] = 5; f[6] = 6; f[7] = 999;
    const glb = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: "VEC3" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 32, byteStride: 16 }],
        buffers: [{ byteLength: 32 }],
      },
      new Uint8Array(buf),
    );
    const d = decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN });
    expect(d.numPoints).toBe(2);
    // (1,2,3) rotated is (1,-3,2); (4,5,6) is (4,-6,5).
    expect(Array.from(d.positions).map(Math.round)).toEqual([1, -3, 2, 4, -6, 5]);
  });

  it("de-normalises an integer accessor", () => {
    // KHR_mesh_quantization writes positions as normalized shorts. Reading them
    // raw puts the cloud 32,767 times too far away.
    const quantized = new Int16Array([32767, 0, 0]);
    const glb = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5122,
            normalized: true,
            count: 1,
            type: "VEC3",
          },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
        buffers: [{ byteLength: 6 }],
      },
      new Uint8Array(quantized.buffer),
    );
    const d = decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN });
    expect(d.positions[0]).toBeCloseTo(1, 4);
  });

  it("refuses an accessor that runs past the buffer", () => {
    const bad = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 100, type: "VEC3" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
        buffers: [{ byteLength: 12 }],
      },
      new Uint8Array(12),
    );
    expect(() => decodeGltfPoints(bad, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /needs 1200 bytes/,
    );
  });

  it("refuses a sparse accessor by name", () => {
    const glb = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 1, type: "VEC3", sparse: {} },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
        buffers: [{ byteLength: 12 }],
      },
      new Uint8Array(12),
    );
    expect(() => decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /sparse/,
    );
  });
});

describe("decodeGltfPoints: what it refuses, by name", () => {
  it("says a mesh is a mesh", () => {
    const glb = pointsGlb([1, 2, 3], {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    });
    expect(() => decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /no primitive with mode 0 \(POINTS\)/,
    );
  });

  it("names Draco rather than drawing nothing", () => {
    const glb = pointsGlb([1, 2, 3], {
      extensionsRequired: ["KHR_draco_mesh_compression"],
    });
    expect(() => decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /Draco/,
    );
  });

  it("names meshopt too", () => {
    const glb = pointsGlb([1, 2, 3], {
      extensionsRequired: ["EXT_meshopt_compression"],
    });
    expect(() => decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /meshopt/,
    );
  });

  it("says which buffer was not resolved", () => {
    const glb = pointsGlb([1, 2, 3], { buffers: [{ uri: "points.bin", byteLength: 12 }] });
    expect(() => decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN })).toThrow(
      /was not resolved/,
    );
  });
});

describe.skipIf(!HAS_MESH)("against a real Cesium mesh tile", () => {
  it("refuses it by name instead of drawing nothing", () => {
    // These are the tiles the implicit samples actually ship, and they are
    // triangles. Refusing them is correct; refusing them SILENTLY is not.
    const bytes = new Uint8Array(readFileSync(MESH_GLB));
    expect(() =>
      decodeGltfPoints(bytes, { transform: IDENTITY, origin: ORIGIN }),
    ).toThrow(/no primitive with mode 0/);
  });
});

describe.skipIf(!HAS_SAMPLE)("against Cesium's published glTF point clouds", () => {
  function read(name: string) {
    const doc = new Uint8Array(readFileSync(`${SAMPLE_DIR}${name}.gltf`));
    const { json } = readGltf(doc);
    const external = externalBufferUris(json);
    const buffers: (Uint8Array | undefined)[] = [];
    for (const { index, uri } of external) {
      buffers[index] = new Uint8Array(readFileSync(`${SAMPLE_DIR}${uri}`));
    }
    return decodeGltfPoints(doc, { transform: IDENTITY, origin: ORIGIN, buffers });
  }

  it("reads the tree, buffer and all", () => {
    // A plain `.gltf` with a sibling `.bin`, which is what the published point
    // clouds actually are — the single-file `.glb` is the exception here.
    const d = read("PropertyAttributesPointCloudTree");
    expect(d.numPoints).toBe(6876);
    expect(d.colors).toHaveLength(4 * 6876);
    expect(d.pitch).toBeGreaterThan(0);
  });

  it("reads the house", () => {
    const d = read("PropertyAttributesPointCloudHouse");
    expect(d.numPoints).toBe(22_462);
    expect(d.colors).toHaveLength(4 * 22_462);
  });

  it("reports the external buffer rather than reading zeroes", () => {
    const doc = new Uint8Array(
      readFileSync(`${SAMPLE_DIR}PropertyAttributesPointCloudTree.gltf`),
    );
    expect(externalBufferUris(readGltf(doc).json)).toEqual([
      { index: 0, uri: "PropertyAttributesPointCloudTree.bin" },
    ]);
    expect(() =>
      decodeGltfPoints(doc, { transform: IDENTITY, origin: ORIGIN }),
    ).toThrow(/was not resolved/);
  });

  it("turns COLOR_0 floats into 8-bit RGBA with opaque alpha", () => {
    const d = read("PropertyAttributesPointCloudTree");
    // VEC3 colour, so alpha is filled rather than read.
    for (let i = 0; i < 50; i++) expect(d.colors![4 * i + 3]).toBe(255);
    // And it is not all black or all white, which is what a mis-scaled read
    // would produce.
    const distinct = new Set<number>();
    for (let i = 0; i < 500; i++) distinct.add(d.colors![4 * i]!);
    expect(distinct.size).toBeGreaterThan(5);
  });
});

describe.skipIf(!HAS_LION)("the differential: lion_takanawa as glTF POINTS", () => {
  it("round-trips the cloud through the Y-up convention", () => {
    // The same cloud this repo reads as COPC, rebuilds in the browser, and
    // tiles as `.pnts`. Written here Y-up on purpose: the rotation the decoder
    // applies has to land it back on the source, so getting the rotation
    // backwards shows up as a cloud on its side rather than as a pass.
    const bytes = new Uint8Array(readFileSync(LION_GLB));
    const d = decodeGltfPoints(bytes, { transform: IDENTITY, origin: ORIGIN });
    expect(d.numPoints).toBe(341_989);

    const distinct = new Set<string>();
    for (let i = 0; i < d.numPoints; i++) {
      distinct.add(
        `${d.positions[3 * i]!.toFixed(3)},` +
          `${d.positions[3 * i + 1]!.toFixed(3)},` +
          `${d.positions[3 * i + 2]!.toFixed(3)}`,
      );
    }
    expect(distinct.size).toBe(275_855);
  });

  it("lands in the same box the LAS declares", () => {
    const bytes = new Uint8Array(readFileSync(LION_GLB));
    const d = decodeGltfPoints(bytes, { transform: IDENTITY, origin: ORIGIN });
    // The lion's true DATA extent, which is not its indexing cube: the
    // converter's cube runs -4.985 .. 0.700 on X and the points only reach
    // -0.79. Asserting the cube here would have passed on a cloud shifted by
    // 1.5 m.
    expect(d.bounds.min[0]).toBeCloseTo(-4.99, 2);
    expect(d.bounds.max[0]).toBeCloseTo(-0.79, 2);
    expect(d.bounds.min[1]).toBeCloseTo(1.04, 2);
    expect(d.bounds.max[2]).toBeCloseTo(1.12, 2);
  });
});

describe("COLOR_0 when the file lies about normalization", () => {
  it("normalises an integer colour whatever the flag says", () => {
    // glTF does not allow an unnormalised integer COLOR_0 — a colour is 0..1 —
    // and py3dtiles writes `normalized: false` on a ubyte one anyway. Read
    // literally, every channel above 1 clamps to full scale and the cloud comes
    // out saturated white, which reads as a lighting bug rather than a decode
    // one. Half grey must stay half grey.
    const positions = new Float32Array([0, 0, 0]);
    const colors = new Uint8Array([128, 64, 255]);
    const binary = new Uint8Array(12 + 3);
    binary.set(new Uint8Array(positions.buffer));
    binary.set(colors, 12);
    const glb = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, mode: 0 }] },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 1, type: "VEC3" },
          {
            bufferView: 1,
            componentType: 5121,
            normalized: false,
            count: 1,
            type: "VEC3",
          },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 12 },
          { buffer: 0, byteOffset: 12, byteLength: 3 },
        ],
        buffers: [{ byteLength: 15 }],
      },
      binary,
    );
    const d = decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!)).toEqual([128, 64, 255, 255]);
  });

  it("still reads a float colour as 0..1", () => {
    // The other half: a float COLOR_0 is already in the right range and must
    // NOT be divided by anything.
    const binary = new Uint8Array(24);
    new Float32Array(binary.buffer).set([0, 0, 0, 1, 0.5, 0]);
    const glb = buildGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, mode: 0 }] },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 1, type: "VEC3" },
          { bufferView: 1, componentType: 5126, count: 1, type: "VEC3" },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 12 },
          { buffer: 0, byteOffset: 12, byteLength: 12 },
        ],
        buffers: [{ byteLength: 24 }],
      },
      binary,
    );
    const d = decodeGltfPoints(glb, { transform: IDENTITY, origin: ORIGIN });
    expect(Array.from(d.colors!)).toEqual([255, 128, 0, 255]);
  });
});
