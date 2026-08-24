import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  availabilityIndex,
  fillTemplate,
  morton2,
  morton3,
  mortonOf,
  readSubtree,
} from "./subtree.js";

const SAMPLES = new URL("../../../demo/data/_tiles/cesium-samples/1.1/", import.meta.url)
  .pathname;
const QUAD = `${SAMPLES}SparseImplicitQuadtree/`;
const OCT = `${SAMPLES}SparseImplicitOctree/`;
const HAS = existsSync(`${QUAD}subtrees/0.0.0.subtree`);

/** Build a `.subtree` in memory, so the parser is tested on inputs we control. */
function buildSubtree(
  json: Record<string, unknown>,
  binary = new Uint8Array(0),
): Uint8Array {
  const enc = new TextEncoder();
  const jsonBytes = enc.encode(JSON.stringify(json));
  // The spec pads the JSON chunk to 8 bytes with spaces.
  const pad = (8 - (jsonBytes.byteLength % 8)) % 8;
  const jsonPadded = new Uint8Array(jsonBytes.byteLength + pad);
  jsonPadded.set(jsonBytes);
  jsonPadded.fill(0x20, jsonBytes.byteLength);

  const out = new Uint8Array(24 + jsonPadded.byteLength + binary.byteLength);
  const dv = new DataView(out.buffer);
  out.set(enc.encode("subt"), 0);
  dv.setUint32(4, 1, true);
  dv.setBigUint64(8, BigInt(jsonPadded.byteLength), true);
  dv.setBigUint64(16, BigInt(binary.byteLength), true);
  out.set(jsonPadded, 24);
  out.set(binary, 24 + jsonPadded.byteLength);
  return out;
}

describe("morton codes", () => {
  it("interleaves two coordinates for a quadtree", () => {
    expect(morton2(0, 0)).toBe(0);
    expect(morton2(1, 0)).toBe(1);
    expect(morton2(0, 1)).toBe(2);
    expect(morton2(1, 1)).toBe(3);
    expect(morton2(3, 3)).toBe(15);
    // x contributes the even bits, y the odd ones.
    expect(morton2(2, 0)).toBe(4);
    expect(morton2(0, 2)).toBe(8);
  });

  it("interleaves three for an octree", () => {
    expect(morton3(0, 0, 0)).toBe(0);
    expect(morton3(1, 0, 0)).toBe(1);
    expect(morton3(0, 1, 0)).toBe(2);
    expect(morton3(0, 0, 1)).toBe(4);
    expect(morton3(1, 1, 1)).toBe(7);
    expect(morton3(3, 3, 3)).toBe(63);
  });

  it("ignores z under a quadtree", () => {
    expect(mortonOf("QUADTREE", 1, 1, 5)).toBe(morton2(1, 1));
    expect(mortonOf("OCTREE", 1, 1, 5)).toBe(morton3(1, 1, 5));
  });
});

describe("availabilityIndex", () => {
  it("lays levels out one after another, Morton within each", () => {
    // A quadtree: 1 node on level 0, 4 on level 1, 16 on level 2.
    expect(availabilityIndex(4, 0, 0)).toBe(0);
    expect(availabilityIndex(4, 1, 0)).toBe(1);
    expect(availabilityIndex(4, 1, 3)).toBe(4);
    expect(availabilityIndex(4, 2, 0)).toBe(5);
    expect(availabilityIndex(4, 2, 15)).toBe(20);
    // An octree: 1, 8, 64.
    expect(availabilityIndex(8, 1, 0)).toBe(1);
    expect(availabilityIndex(8, 2, 0)).toBe(9);
    expect(availabilityIndex(8, 2, 63)).toBe(72);
  });
});

describe("readSubtree: the container", () => {
  it("reads a constant channel without a byte of payload", () => {
    // A sparse tileset is mostly this, and materialising it would allocate
    // megabytes to say "no".
    const s = readSubtree(
      buildSubtree({
        tileAvailability: { constant: 1 },
        contentAvailability: [{ constant: 0 }],
        childSubtreeAvailability: { constant: 0 },
      }),
      { scheme: "QUADTREE", subtreeLevels: 3 },
    );
    expect(s.isTileAvailable(0, 0)).toBe(true);
    expect(s.isTileAvailable(2, 15)).toBe(true);
    expect(s.isContentAvailable(0, 0)).toBe(false);
    expect(s.isChildSubtreeAvailable(0)).toBe(false);
  });

  it("reads bits LSB first inside each byte", () => {
    // The spec's order, and the opposite of how a bitstream is usually drawn.
    // MSB-first does not fail — it returns a different, plausible set of tiles.
    const s = readSubtree(
      buildSubtree(
        {
          buffers: [{ byteLength: 8 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
          tileAvailability: { bitstream: 0 },
        },
        new Uint8Array([0b0000_0101, 0, 0, 0, 0, 0, 0, 0]),
      ),
      { scheme: "QUADTREE", subtreeLevels: 3 },
    );
    expect(s.isTileAvailable(0, 0)).toBe(true); // bit 0
    expect(s.isTileAvailable(1, 0)).toBe(false); // bit 1
    expect(s.isTileAvailable(1, 1)).toBe(true); // bit 2
    expect(s.isTileAvailable(1, 2)).toBe(false); // bit 3
  });

  it("refuses an external buffer by name", () => {
    // Skipping it would report every tile as unavailable, which looks like an
    // empty tileset rather than like a missing file.
    expect(() =>
      readSubtree(
        buildSubtree({
          buffers: [{ uri: "availability.bin", byteLength: 64 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3 }],
          tileAvailability: { bitstream: 0 },
        }),
        { scheme: "QUADTREE", subtreeLevels: 3 },
      ),
    ).toThrow(/external file \(availability\.bin\)/);
  });

  it("refuses a bufferView that runs past the binary chunk", () => {
    expect(() =>
      readSubtree(
        buildSubtree(
          {
            buffers: [{ byteLength: 2 }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 64 }],
            tileAvailability: { bitstream: 0 },
          },
          new Uint8Array(2),
        ),
        { scheme: "QUADTREE", subtreeLevels: 3 },
      ),
    ).toThrow(/binary chunk/);
  });

  it("refuses something that is not a .subtree", () => {
    const glb = new Uint8Array(32);
    glb.set(new TextEncoder().encode("glTF"), 0);
    expect(() => readSubtree(glb, { scheme: "OCTREE", subtreeLevels: 2 })).toThrow(
      /Not a \.subtree/,
    );
    expect(() =>
      readSubtree(new Uint8Array(8), { scheme: "OCTREE", subtreeLevels: 2 }),
    ).toThrow(/at least 24 bytes/);
  });

  it("treats a missing channel as unavailable rather than throwing", () => {
    const s = readSubtree(buildSubtree({ tileAvailability: { constant: 1 } }), {
      scheme: "OCTREE",
      subtreeLevels: 2,
    });
    expect(s.contentCount).toBe(0);
    expect(s.isContentAvailable(0, 0)).toBe(false);
    expect(s.isChildSubtreeAvailable(0)).toBe(false);
  });

  it("accepts contentAvailability written as a bare object", () => {
    // 1.0's extension spelled it singular; 1.1 made it an array.
    const s = readSubtree(
      buildSubtree({
        tileAvailability: { constant: 1 },
        contentAvailability: { constant: 1 } as never,
      }),
      { scheme: "OCTREE", subtreeLevels: 2 },
    );
    expect(s.contentCount).toBe(1);
    expect(s.isContentAvailable(0, 0)).toBe(true);
  });

  it("says no outside the subtree's own levels", () => {
    const s = readSubtree(buildSubtree({ tileAvailability: { constant: 1 } }), {
      scheme: "QUADTREE",
      subtreeLevels: 3,
    });
    expect(s.isTileAvailable(3, 0)).toBe(false);
    expect(s.isTileAvailable(-1, 0)).toBe(false);
  });
});

describe.skipIf(!HAS)("against Cesium's own sparse subtrees", () => {
  function read(dir: string, file: string, scheme: "QUADTREE" | "OCTREE") {
    const bytes = new Uint8Array(readFileSync(`${dir}subtrees/${file}`));
    return readSubtree(bytes, { scheme, subtreeLevels: 3, path: file });
  }

  it("counts exactly the tiles the file says are available", () => {
    // `availableCount` is metadata the parser deliberately does NOT use — it
    // reads the bits. Counting them back and comparing is what makes the bit
    // order and the level-order layout load-bearing rather than assumed.
    const s = read(QUAD, "0.0.0.subtree", "QUADTREE");
    let n = 0;
    for (let level = 0; level < 3; level++) {
      for (let m = 0; m < 4 ** level; m++) if (s.isTileAvailable(level, m)) n++;
    }
    expect(n).toBe(7);

    let children = 0;
    for (let m = 0; m < 4 ** 3; m++) if (s.isChildSubtreeAvailable(m)) children++;
    expect(children).toBe(8);
  });

  it("finds content where the leaf subtrees say it is", () => {
    const s = read(QUAD, "3.0.5.subtree", "QUADTREE");
    let content = 0;
    for (let level = 0; level < 3; level++) {
      for (let m = 0; m < 4 ** level; m++) if (s.isContentAvailable(level, m)) content++;
    }
    expect(content).toBe(4);
    // A leaf subtree hangs nothing below it.
    for (let m = 0; m < 4 ** 3; m++) {
      expect(s.isChildSubtreeAvailable(m)).toBe(false);
    }
  });

  it("reads every quadtree subtree in the sample without throwing", () => {
    const files = readdirSync(`${QUAD}subtrees`).filter((f) => f.endsWith(".subtree"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const s = read(QUAD, f, "QUADTREE");
      expect(s.branching, f).toBe(4);
    }
  });

  it("reads the octree sample, where branching is eight", () => {
    const files = readdirSync(`${OCT}subtrees`).filter((f) => f.endsWith(".subtree"));
    const s = read(OCT, files[0]!, "OCTREE");
    expect(s.branching).toBe(8);
    let n = 0;
    for (let level = 0; level < 3; level++) {
      for (let m = 0; m < 8 ** level; m++) if (s.isTileAvailable(level, m)) n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it("resolves the sample's content template to files that exist", () => {
    // The end of the arithmetic: a bit says a tile has content, the template
    // says where, and the file is there. Getting the Morton decode or the
    // level-order offset wrong lands on a name that does not exist.
    const root = read(QUAD, "0.0.0.subtree", "QUADTREE");
    expect(root.isContentAvailable(0, 0)).toBe(false);

    const leaf = read(QUAD, "3.0.5.subtree", "QUADTREE");
    // The subtree at (3, 0, 5) covers levels 3..5. Level 0 within it is the
    // tile (3, 0, 5) itself.
    let found = 0;
    for (let level = 0; level < 3; level++) {
      const size = 2 ** level;
      for (let ly = 0; ly < size; ly++) {
        for (let lx = 0; lx < size; lx++) {
          if (!leaf.isContentAvailable(level, morton2(lx, ly))) continue;
          const uri = fillTemplate(
            "content/content_{level}__{x}_{y}.glb",
            3 + level,
            0 * size + lx,
            5 * size + ly,
            undefined,
          );
          expect(existsSync(`${QUAD}${uri}`), uri).toBe(true);
          found++;
        }
      }
    }
    expect(found).toBe(4);
  });
});

describe("fillTemplate", () => {
  it("fills every occurrence", () => {
    expect(fillTemplate("c/{level}__{x}_{y}.glb", 5, 29, 8, undefined)).toBe(
      "c/5__29_8.glb",
    );
    expect(fillTemplate("s/{level}.{x}.{y}.{z}.subtree", 3, 1, 2, 4)).toBe(
      "s/3.1.2.4.subtree",
    );
  });

  it("leaves {z} alone for a quadtree", () => {
    // Substituting 0 into a template that has no {z} is harmless; inventing a
    // path segment for one that does is not.
    expect(fillTemplate("{x}_{y}_{z}", 0, 1, 2, undefined)).toBe("1_2_{z}");
  });
});
