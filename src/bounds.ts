// The three bounding volumes 3D Tiles defines, reduced to what the scheduler
// reads: an axis-aligned box, plus the volume's OWN radius.
//
// The neutral node carries `minX..maxZ` and nothing else, and that is not an
// accident — a scheduler that had to understand three volume types would be a
// scheduler that understands formats. So the reduction happens here.
//
// It costs something, and the cost is named: the AABB of a thin box rotated 45
// degrees is much larger than the box, the distance term `|cam - centre| - r`
// then comes out too small, the key too big, and the tile OVER-refines. Safe,
// never the reverse, but not free — which is why `radius` is computed from the
// volume itself and not from the box. `nodeBoundingRadius` exists precisely so
// that the conservative box culls while the true radius scores.

/** WGS 84. `region` is defined in EPSG:4979, which rides on this ellipsoid. */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
/** First eccentricity squared, `1 - (b/a)^2`. */
const E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface VolumeBounds extends Aabb {
  /**
   * The radius of the smallest sphere about the volume's own centre that
   * contains it — EXACT for `box` and `sphere`, and the box half-diagonal for
   * `region`, where a tight radius would cost more than it buys.
   *
   * Always `<=` the AABB half-diagonal, and strictly less whenever the volume
   * is rotated relative to the axes. That difference is the whole reason this
   * field is carried rather than derived downstream.
   */
  readonly radius: number;
  readonly centreX: number;
  readonly centreY: number;
  readonly centreZ: number;
}

/** A tile's `boundingVolume`, as it appears in the JSON. */
export interface BoundingVolumeJson {
  /** 12 numbers: centre, then three half-axis VECTORS. Not extents. */
  readonly box?: readonly number[];
  /** 6 numbers: west, south, east, north in RADIANS, then min/max height. */
  readonly region?: readonly number[];
  /** 4 numbers: centre, then radius. */
  readonly sphere?: readonly number[];
}

/** Column-major 4x4, the same layout the JSON uses and three expects. */
export type Mat4 = readonly number[];

export const IDENTITY: Mat4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** `a` then `b`, i.e. the matrix that applies `b` to the result of `a`. */
export function multiply(b: Mat4, a: Mat4): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        b[r]! * a[c * 4]! +
        b[4 + r]! * a[c * 4 + 1]! +
        b[8 + r]! * a[c * 4 + 2]! +
        b[12 + r]! * a[c * 4 + 3]!;
    }
  }
  return out;
}

export function transformPoint(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Rotation and scale only — for a half-axis, which is a direction and a length. */
function transformVector(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

/**
 * Geodetic (EPSG:4979) to geocentric (EPSG:4978). Longitude and latitude in
 * RADIANS, height in metres above the ellipsoid.
 *
 * The closed form, not an iteration: this direction has one.
 */
export function cartographicToEcef(
  lon: number,
  lat: number,
  height: number,
): [number, number, number] {
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  // Radius of curvature in the prime vertical.
  const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (n + height) * cosLat;
  return [r * Math.cos(lon), r * Math.sin(lon), (n * (1 - E2) + height) * sinLat];
}

const TWO_PI = 2 * Math.PI;
const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * How far the arc runs eastward from `west` to `east`.
 *
 * Three cases and all three occur in real tilesets: an ordinary arc, one that
 * WRAPS the antimeridian (`west > east`, which the spec allows), and the whole
 * circle, which a root region writes as `-pi .. pi`.
 *
 * The whole circle is the case that has to be special: `(east - west) mod 2pi`
 * is ZERO for it, indistinguishable from an arc of no width, and a root tile
 * whose longitude range collapses is a root tile that culls the planet.
 */
function arcSpan(west: number, east: number): number {
  const raw = east - west;
  if (raw >= TWO_PI - 1e-12) return TWO_PI;
  return raw >= 0 ? raw : raw + TWO_PI;
}

/** Whether `angle` lies inside the arc from `west` to `east` going EAST. */
function arcContains(west: number, east: number, angle: number): boolean {
  const span = arcSpan(west, east);
  if (span >= TWO_PI - 1e-12) return true;
  return norm(angle - west) <= span + 1e-15;
}

/** Exact min and max of `f` over the longitude arc. */
function trigRange(
  west: number,
  east: number,
  f: (a: number) => number,
  critical: readonly number[],
): [number, number] {
  let lo = Math.min(f(west), f(east));
  let hi = Math.max(f(west), f(east));
  for (const c of critical) {
    if (!arcContains(west, east, c)) continue;
    const v = f(c);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** `[min, max]` of the product of two intervals. */
function productRange(
  [aLo, aHi]: [number, number],
  [bLo, bHi]: [number, number],
): [number, number] {
  const p = [aLo * bLo, aLo * bHi, aHi * bLo, aHi * bHi];
  return [Math.min(...p), Math.max(...p)];
}

/**
 * The EXACT axis-aligned box of a `region`, in ECEF.
 *
 * Not the box of the eight corners: an ellipsoidal region bulges OUTWARD
 * between its corners, so a corner hull is too small and culls tiles that are
 * on screen. The extremes are found analytically instead —
 *
 *   x = r(lat, h) * cos(lon),  y = r(lat, h) * sin(lon),  r >= 0
 *   z = (N(lat)(1 - e^2) + h) * sin(lat)
 *
 * `r` is unimodal in latitude with its peak at the equator and monotone in
 * height, so its range is three evaluations; `cos` and `sin` over an arc are
 * their endpoints plus whichever of 0, +/-pi/2, pi the arc contains; and `z` is
 * monotone in both latitude and height, so the four corners of that rectangle
 * bound it.
 */
export function regionToEcefAabb(region: readonly number[]): Aabb {
  const west = region[0]!;
  const south = region[1]!;
  const east = region[2]!;
  const north = region[3]!;
  const minH = region[4]!;
  const maxH = region[5]!;

  const rAt = (lat: number, h: number) => {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
    return (n + h) * Math.cos(lat);
  };
  const zAt = (lat: number, h: number) => {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
    return (n * (1 - E2) + h) * sinLat;
  };

  // r peaks at the latitude closest to the equator, and grows with height.
  const latNearestEquator = south > 0 ? south : north < 0 ? north : 0;
  const rMax = rAt(latNearestEquator, maxH);
  const rMin = Math.min(rAt(south, minH), rAt(north, minH));

  const HALF_PI = Math.PI / 2;
  const cosRange = trigRange(west, east, Math.cos, [0, Math.PI, -Math.PI]);
  const sinRange = trigRange(west, east, Math.sin, [HALF_PI, -HALF_PI]);

  const [minX, maxX] = productRange([rMin, rMax], cosRange);
  const [minY, maxY] = productRange([rMin, rMax], sinRange);

  const zs = [
    zAt(south, minH),
    zAt(south, maxH),
    zAt(north, minH),
    zAt(north, maxH),
  ];
  return {
    minX,
    minY,
    minZ: Math.min(...zs),
    maxX,
    maxY,
    maxZ: Math.max(...zs),
  };
}

function fromAabb(box: Aabb, radius?: number): VolumeBounds {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  return {
    ...box,
    centreX: cx,
    centreY: cy,
    centreZ: cz,
    radius:
      radius ??
      0.5 *
        Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ),
  };
}

/**
 * One tile's bounding volume, in the frame `transform` maps into.
 *
 * `region` IGNORES the transform, and that is the spec's rule rather than an
 * omission: a region is already georeferenced, so a tile transform would move
 * it off the ellipsoid it is defined against. Cesium does the same.
 *
 * Returns `undefined` for a volume this driver cannot read, so the caller can
 * warn and fall back to the parent's rather than throwing on a tileset that is
 * otherwise fine.
 */
export function boundingVolumeToBounds(
  volume: BoundingVolumeJson | undefined,
  transform: Mat4,
): VolumeBounds | undefined {
  if (volume === undefined) return undefined;

  if (volume.box !== undefined && volume.box.length >= 12) {
    const b = volume.box;
    const [cx, cy, cz] = transformPoint(transform, b[0]!, b[1]!, b[2]!);
    const axes: Array<[number, number, number]> = [
      transformVector(transform, b[3]!, b[4]!, b[5]!),
      transformVector(transform, b[6]!, b[7]!, b[8]!),
      transformVector(transform, b[9]!, b[10]!, b[11]!),
    ];
    // The AABB half-extent on each axis is the sum of the absolute components:
    // every corner is centre +/- h0 +/- h1 +/- h2, so the extreme on X is
    // reached by choosing each sign to agree.
    const hx = Math.abs(axes[0]![0]) + Math.abs(axes[1]![0]) + Math.abs(axes[2]![0]);
    const hy = Math.abs(axes[0]![1]) + Math.abs(axes[1]![1]) + Math.abs(axes[2]![1]);
    const hz = Math.abs(axes[0]![2]) + Math.abs(axes[1]![2]) + Math.abs(axes[2]![2]);
    // The TRUE radius: the farthest of the eight corners, which for a rotated
    // box is strictly less than the AABB half-diagonal.
    let radius = 0;
    for (let s = 0; s < 8; s++) {
      const sx = s & 1 ? 1 : -1;
      const sy = s & 2 ? 1 : -1;
      const sz = s & 4 ? 1 : -1;
      const dx = sx * axes[0]![0] + sy * axes[1]![0] + sz * axes[2]![0];
      const dy = sx * axes[0]![1] + sy * axes[1]![1] + sz * axes[2]![1];
      const dz = sx * axes[0]![2] + sy * axes[1]![2] + sz * axes[2]![2];
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) radius = d;
    }
    return {
      minX: cx - hx,
      minY: cy - hy,
      minZ: cz - hz,
      maxX: cx + hx,
      maxY: cy + hy,
      maxZ: cz + hz,
      centreX: cx,
      centreY: cy,
      centreZ: cz,
      radius,
    };
  }

  if (volume.sphere !== undefined && volume.sphere.length >= 4) {
    const s = volume.sphere;
    const [cx, cy, cz] = transformPoint(transform, s[0]!, s[1]!, s[2]!);
    // A transform may scale non-uniformly; the containing sphere takes the
    // LARGEST axis scale, which is the only choice that cannot under-cover.
    const sx = Math.hypot(transform[0]!, transform[1]!, transform[2]!);
    const sy = Math.hypot(transform[4]!, transform[5]!, transform[6]!);
    const sz = Math.hypot(transform[8]!, transform[9]!, transform[10]!);
    const r = s[3]! * Math.max(sx, sy, sz);
    return {
      minX: cx - r,
      minY: cy - r,
      minZ: cz - r,
      maxX: cx + r,
      maxY: cy + r,
      maxZ: cz + r,
      centreX: cx,
      centreY: cy,
      centreZ: cz,
      radius: r,
    };
  }

  if (volume.region !== undefined && volume.region.length >= 6) {
    return fromAabb(regionToEcefAabb(volume.region));
  }

  return undefined;
}

/** Whether a volume is a `region`, which is georeferenced BY DEFINITION. */
export function isRegion(volume: BoundingVolumeJson | undefined): boolean {
  return volume?.region !== undefined && volume.region.length >= 6;
}

/**
 * Whether a point looks like it is in ECEF, i.e. near the WGS 84 ellipsoid.
 *
 * A `region` says "georeferenced" outright, and it is the case everyone reaches
 * for when explaining the format — but it is NOT the common one. Cesium's own
 * `TilesetWithDiscreteLOD` sample, and most tilesets a real pipeline emits, use
 * a local `box` under a root `transform` whose translation is an ECEF position:
 * that sample sits at (1215107.8, -4736682.9, 4081926.1), 6,378 km from the
 * centre of the Earth. A driver that only looks for `region` calls those
 * tilesets local and hands the viewer a cloud it cannot place next to anything.
 *
 * So the test is geometric: how far the point is from the ellipsoid SURFACE
 * along its own direction. The band is deliberately loose — a hundred
 * kilometres either way — because it only has to separate "on the planet" from
 * "in a scanner's local frame near the origin", and those differ by six orders
 * of magnitude.
 */
export function looksEcef(x: number, y: number, z: number): boolean {
  const r = Math.hypot(x, y, z);
  if (!(r > 0)) return false;
  // Radius of the ellipsoid in this geocentric direction.
  const sin2 = (z * z) / (r * r);
  const cos2 = 1 - sin2;
  const surface =
    (WGS84_A * WGS84_B) /
    Math.sqrt(WGS84_B * WGS84_B * cos2 + WGS84_A * WGS84_A * sin2);
  return Math.abs(r - surface) < 100_000;
}

export const ELLIPSOID = { a: WGS84_A, b: WGS84_B, e2: E2 } as const;
