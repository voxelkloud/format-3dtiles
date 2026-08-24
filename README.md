# @voxelkloud/format-3dtiles

The [3D Tiles](https://www.ogc.org/standard/3dtiles/) driver for
[voxelkloud](https://github.com/voxelkloud/voxelkloud).

```sh
npm install @voxelkloud/format-3dtiles
```

```ts
import { tilesetFormat } from "@voxelkloud/format-3dtiles";
import { formats, loadPointCloud } from "@voxelkloud/loader";

formats.register(tilesetFormat);

const { source, tree, openPoints } = await loadPointCloud(
  "https://cdn.example/tileset.json",
);
view.addCloud(source, tree, openPoints);
```

NOT registered by default. That is a bundle decision, not a judgement: an app
that only reads Potree should not carry a glTF parser to find that out.

## What it is

3D Tiles is the one format here whose tree is not an octree, and most of what
this driver does follows from that.

- **`tileset.json`, and external tilesets.** A tile's content may be another
  tileset, which grafts a second document's root into the first document's tree.
  The driver resolves those transitively, so a survey split across many files
  opens as one cloud.
- **Implicit tiling.** A tileset may describe its subdivision instead of listing
  it, with availability packed into `.subtree` files. Tiles are generated on
  demand as the camera descends rather than materialised up front.
- **`.pnts` and glTF `POINTS`.** Both content types decode to the same
  `DecodedPointData` every other driver produces, including quantised positions,
  Draco-free attribute layouts and the RTC centre.

### Geometric error is not a point pitch

The scheduler that drives voxelkloud is calibrated in point spacing, and a
tileset's `geometricError` is its own quantity with its own units. Feeding one
into the other is what makes a tileset either refuse to refine or fetch its whole
depth on the first frame. The tree reports its own default screen-error target,
and the view adopts it only when the caller named none.

### REPLACE refinement

Every other format here is ADDITIVE — a node's points and its children's points
are different points, and drawing both is the picture. 3D Tiles also has
`refine: "REPLACE"`, where a tile is a coarse STAND-IN for its children and
drawing both draws the same ground twice. Hiding the parent needs to know its
children are already resident, so it happens between selection and draw rather
than in the scheduler: dropping a parent before its children land opens a hole
exactly where the picture was about to improve.

## Licence

MIT
