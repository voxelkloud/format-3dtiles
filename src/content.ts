// What a decoded tile is, whichever spelling it arrived in.
//
// `.pnts` and glTF are addressed completely differently — a feature table with
// byte offsets against four levels of accessor indirection — and produce the
// same thing. Naming that thing once is what lets the reader above dispatch on
// the extension and then stop caring.

export interface DecodedTileContent {
  readonly numPoints: number;
  /** `3 * numPoints`, relative to the cloud origin, in the tile's frame. */
  readonly positions: Float32Array;
  /** RGBA, `4 * numPoints`. `undefined` when the tile declares no colour. */
  readonly colors: Uint8Array | undefined;
  /** Tight extent in ABSOLUTE coordinates, from the data. */
  readonly bounds: {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
  };
  /**
   * MEASURED point pitch: the cube root of the volume per point over the tile's
   * own extent.
   *
   * A tileset declares no such thing, and `geometricError` is only a proxy —
   * one a leaf sets to 0, which would size every point at nothing. So it is
   * measured from the points that arrived, the one moment it is knowable.
   */
  readonly pitch: number;
}
