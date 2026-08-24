import { describe, expect, it } from "vitest";
import {
  ELLIPSOID,
  IDENTITY,
  boundingVolumeToBounds,
  cartographicToEcef,
  multiply,
  regionToEcefAabb,
  transformPoint,
} from "./bounds.js";

const DEG = Math.PI / 180;

/** Column-major rotation about Z, the layout the JSON uses. */
function rotZ(rad: number): number[] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function translate(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

describe("cartographicToEcef", () => {
  it("puts the equator at the semi-major axis", () => {
    // The two exact values on the ellipsoid: (a, 0, 0) and (0, 0, b). Anything
    // that gets the eccentricity backwards fails one of them.
    const [x, y, z] = cartographicToEcef(0, 0, 0);
    expect(x).toBeCloseTo(ELLIPSOID.a, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("puts the pole at the semi-minor axis", () => {
    const [x, y, z] = cartographicToEcef(0, Math.PI / 2, 0);
    expect(Math.hypot(x, y)).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(ELLIPSOID.b, 6);
    expect(ELLIPSOID.b).toBeCloseTo(6356752.314245, 5);
  });

  it("places 90 degrees east on the +Y axis", () => {
    const [x, y, z] = cartographicToEcef(Math.PI / 2, 0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(ELLIPSOID.a, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("adds height along the ellipsoid normal", () => {
    const [x] = cartographicToEcef(0, 0, 1000);
    expect(x).toBeCloseTo(ELLIPSOID.a + 1000, 6);
  });
});

describe("regionToEcefAabb", () => {
  /** Dense sampling, as the independent check on the analytic extremes. */
  function sampledAabb(region: readonly number[], n = 60) {
    const [w, s, e, no, minH, maxH] = region as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const span = e >= w ? e - w : e - w + 2 * Math.PI;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        for (const h of [minH, maxH]) {
          const lon = w + (span * i) / n;
          const lat = s + ((no - s) * j) / n;
          const [x, y, z] = cartographicToEcef(lon, lat, h);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /** Every sampled point must lie inside the analytic box. CONTAINMENT is the
   *  property that matters: a box that is too small culls what is on screen. */
  function expectContains(region: readonly number[]) {
    const box = regionToEcefAabb(region);
    const s = sampledAabb(region);
    const eps = 1e-6;
    expect(box.minX).toBeLessThanOrEqual(s.minX + eps);
    expect(box.minY).toBeLessThanOrEqual(s.minY + eps);
    expect(box.minZ).toBeLessThanOrEqual(s.minZ + eps);
    expect(box.maxX).toBeGreaterThanOrEqual(s.maxX - eps);
    expect(box.maxY).toBeGreaterThanOrEqual(s.maxY - eps);
    expect(box.maxZ).toBeGreaterThanOrEqual(s.maxZ - eps);
    return { box, s };
  }

  it("contains a small mid-latitude region and stays tight", () => {
    // Lyon, roughly: 0.02 rad across. A corner hull would be short here, which
    // is the failure this whole function exists to avoid.
    const region = [4.8 * DEG, 45.7 * DEG, 4.9 * DEG, 45.8 * DEG, 150, 400];
    const { box, s } = expectContains(region);
    // Tight to within a metre of the sampled truth: the analytic extremes ARE
    // the extremes, not a padded envelope.
    expect(box.maxX - s.maxX).toBeLessThan(1);
    expect(s.minX - box.minX).toBeLessThan(1);
  });

  it("contains a region that straddles the equator", () => {
    // `r` peaks at latitude 0, which is interior here — the unimodal case an
    // endpoints-only maximum gets wrong.
    const region = [-0.2, -0.3, 0.2, 0.4, 0, 5000];
    const { box, s } = expectContains(region);
    expect(box.maxX).toBeGreaterThan(s.maxX - 1);
  });

  it("contains a region that crosses the antimeridian", () => {
    // west > east: the arc wraps, and `pi` is interior. Read the other way
    // round, the box lands on the wrong half of the planet.
    const region = [170 * DEG, -10 * DEG, -170 * DEG, 10 * DEG, 0, 1000];
    const { box } = expectContains(region);
    expect(box.minX).toBeLessThan(0);
    expect(box.maxX).toBeLessThan(0);
  });

  it("contains a whole-globe region", () => {
    const region = [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2, 0, 0];
    const box = regionToEcefAabb(region);
    expect(box.minX).toBeCloseTo(-ELLIPSOID.a, 3);
    expect(box.maxX).toBeCloseTo(ELLIPSOID.a, 3);
    expect(box.minY).toBeCloseTo(-ELLIPSOID.a, 3);
    expect(box.maxY).toBeCloseTo(ELLIPSOID.a, 3);
    expect(box.minZ).toBeCloseTo(-ELLIPSOID.b, 3);
    expect(box.maxZ).toBeCloseTo(ELLIPSOID.b, 3);
  });

  it("contains a polar region", () => {
    expectContains([-Math.PI, 80 * DEG, Math.PI, Math.PI / 2, 0, 100]);
  });

  it("is NOT the hull of the eight corners", () => {
    // The bug this replaces, stated as a test: a corner hull under-covers a
    // region wide in longitude, because the surface bulges towards the camera
    // between the corners.
    const region = [-0.6, 0.1, 0.6, 0.3, 0, 0];
    const corners = [];
    for (const lon of [region[0]!, region[2]!]) {
      for (const lat of [region[1]!, region[3]!]) {
        for (const h of [region[4]!, region[5]!]) {
          corners.push(cartographicToEcef(lon, lat, h));
        }
      }
    }
    const cornerMaxX = Math.max(...corners.map((c) => c[0]));
    const box = regionToEcefAabb(region);
    expect(box.maxX).toBeGreaterThan(cornerMaxX + 1000);
  });
});

describe("boundingVolumeToBounds: box", () => {
  it("reads half-axis VECTORS, not extents", () => {
    const bounds = boundingVolumeToBounds(
      { box: [10, 20, 30, 2, 0, 0, 0, 3, 0, 0, 0, 4] },
      IDENTITY,
    )!;
    expect([bounds.minX, bounds.maxX]).toEqual([8, 12]);
    expect([bounds.minY, bounds.maxY]).toEqual([17, 23]);
    expect([bounds.minZ, bounds.maxZ]).toEqual([26, 34]);
    expect(bounds.radius).toBeCloseTo(Math.hypot(2, 3, 4), 12);
  });

  it("grows the AABB under rotation while the radius stays put", () => {
    // THE cost DEC-T6 names, as a number. A 45-degree rotation of a 10x1 slab
    // makes the AABB 7.8 wide where the box is 10 long — and the true radius,
    // which is what scores the tile, does not move at all.
    const flat = { box: [0, 0, 0, 10, 0, 0, 0, 1, 0, 0, 0, 1] };
    const straight = boundingVolumeToBounds(flat, IDENTITY)!;
    const turned = boundingVolumeToBounds(flat, rotZ(Math.PI / 4))!;

    expect(straight.maxX - straight.minX).toBeCloseTo(20, 12);
    expect(turned.maxX - turned.minX).toBeCloseTo(2 * (10 + 1) * Math.SQRT1_2, 12);
    expect(turned.radius).toBeCloseTo(straight.radius, 12);
    // And the conservative box is strictly bigger than the sphere that scores.
    const halfDiagonal =
      0.5 *
      Math.hypot(
        turned.maxX - turned.minX,
        turned.maxY - turned.minY,
        turned.maxZ - turned.minZ,
      );
    expect(halfDiagonal).toBeGreaterThan(turned.radius);
  });

  it("composes the transform chain, parent then child", () => {
    const chain = multiply(translate(100, 0, 0), rotZ(Math.PI / 2));
    const bounds = boundingVolumeToBounds(
      { box: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      chain,
    )!;
    // Rotate (1,0,0) a quarter turn to (0,1,0), then translate by +100 in X.
    expect(bounds.centreX).toBeCloseTo(100, 12);
    expect(bounds.centreY).toBeCloseTo(1, 12);
  });

  it("agrees with transformPoint on the composed chain", () => {
    const a = rotZ(0.3);
    const b = translate(5, -2, 7);
    const composed = multiply(b, a);
    const direct = transformPoint(b, ...transformPoint(a, 1, 2, 3));
    const viaChain = transformPoint(composed, 1, 2, 3);
    for (let i = 0; i < 3; i++) {
      expect(viaChain[i]).toBeCloseTo(direct[i]!, 12);
    }
  });
});

describe("boundingVolumeToBounds: sphere and region", () => {
  it("boxes a sphere and keeps its radius exactly", () => {
    const bounds = boundingVolumeToBounds({ sphere: [1, 2, 3, 4] }, IDENTITY)!;
    expect([bounds.minX, bounds.maxX]).toEqual([-3, 5]);
    expect(bounds.radius).toBe(4);
  });

  it("scales a sphere by the LARGEST axis scale", () => {
    // Under-covering here would cull a tile that is on screen; over-covering
    // only costs refinement.
    const scale = [3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bounds = boundingVolumeToBounds({ sphere: [0, 0, 0, 2] }, scale)!;
    expect(bounds.radius).toBeCloseTo(6, 12);
  });

  it("leaves a region alone under a transform", () => {
    // The spec's rule: a region is already georeferenced, so a tile transform
    // would move it off the ellipsoid it is defined against.
    const region = { region: [0, 0, 0.01, 0.01, 0, 10] };
    const plain = boundingVolumeToBounds(region, IDENTITY)!;
    const moved = boundingVolumeToBounds(region, translate(1e6, 1e6, 1e6))!;
    expect(moved.minX).toBeCloseTo(plain.minX, 9);
    expect(moved.maxZ).toBeCloseTo(plain.maxZ, 9);
  });

  it("returns undefined for a volume it cannot read", () => {
    expect(boundingVolumeToBounds({}, IDENTITY)).toBeUndefined();
    expect(boundingVolumeToBounds({ box: [1, 2, 3] }, IDENTITY)).toBeUndefined();
    expect(boundingVolumeToBounds(undefined, IDENTITY)).toBeUndefined();
  });
});
