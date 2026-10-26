# Kitchen objects: real-world models

Standard household objects for the kitchen level. Step 1 is the rigid items from the YCB
Object and Model Set; step 2 (IKEA-style items measured by hand) and step 3 (cloth for
folding) come later.

## Licences

| Source | Licence | Used for |
|---|---|---|
| YCB Object and Model Set (https://www.ycbbenchmarks.com/, AWS registry entry checked) | CC BY 4.0 | mug, fork, spoon. Attribution in NOTICE |
| Google Scanned Objects (Google Research, checked) | CC BY 4.0 | Not used yet. Candidate for more everyday items |

Products such as IKEA's own models are not openly licensed, so step 2 is measured and
modelled by us.

## Step 1 objects

Sizes are from the scan (bounding boxes, real scale). Jaw fit uses the SO-101 jaw
opening of about 4 to 9 cm (see `web/src/robot.js` and the grasp notes in `docs/tasks.md`).

| Object | Size (cm) | Mass | Jaw fit | Notes |
|---|---|---|---|---|
| Mug (YCB 025) | 11.7 x 9.3 x 8.1, body 8 cm across | 300 g, estimate | Fits: lifted 9 cm in `tests/ycb_grasp.mjs` | Handle is C-shaped on the scan |
| Fork (YCB 030) | 19.8 x 2.7 x 1.6 | 35 g, estimate | Grasp the handle | Thin. Settles flat with 8 slabs and 64 points |
| Spoon (YCB 031) | 18.6 x 8.3 x 2.1 | 30 g, estimate | Grasp the handle | Thin. Settles flat with 8 slabs and 64 points |

Masses are estimates for a typical ceramic mug and cutlery. The bowl (YCB 024) and plate
(YCB 029) were removed from the set: the bowl flipped under a sideways push and neither
fits the jaw, so they were not worth keeping for step 1. Weigh the real items before any data
collection, and update `YCB_MASS` in `tools/check_kitchen_physics.py` and `MASS` in
`tools/object_hulls.py`.

## How they are modelled

`tools/object_hulls.py` turns each scan into MuJoCo collision hulls:
- hollow objects (mug) are cut into 8 angular sectors, so the cavity stays open;
- long thin objects (fork, spoon) are cut into 8 slabs along their length.

Each hull has at most 64 points, picked evenly along the scan so the output is repeatable.
32 points left the fork tilted 3.5 degrees; 64 settles it flat. Slab count changes how the
cutlery settles, so keep 8 slabs. Inertia comes from the hull geometry, scaled to the estimated mass.
Visuals use the same hulls for now, so they are coarse. Loading the full scan mesh needs a
loader change, since meshes are staged under `so101/assets` only.

Regenerate with:

    python3 tools/object_hulls.py <dir with the extracted YCB *_google_16k.tgz> > web/models/kitchen/objects_ycb.xml

## Where they are in the scene

`web/models/kitchen/objects_ycb.xml` is included before the level bodies, so the five free
joints come first in `qpos`. The ready keyframe in `kitchen.xml` lists them in that order
(mug, fork, spoon), then the cup, pill bottle and glasses case. They sit out of the way of
the three tasks (the fork on the right edge, the spoon near the front edge).

## Checks

- `python3 tools/check_kitchen_physics.py`: masses, settling (drift, tilt, penetration under 2 mm
  for scanned hulls), speed, torque margins and the cup and bottle push tests.
- `node tests/ycb_grasp.mjs`: the mug can be lifted 9 cm.
- All task tests still pass with the new objects in the scene.

## Known issues

- **Speed.** The browser build measured 0.14 ms per physics step with 64 points per hull
  (about 14.6x real time) in the same run where 32 points measured 0.16 ms. 60 fps needs 8.3
  steps per frame, so there is plenty of headroom, but this is the cost to watch as more
  objects arrive.
- **Cutlery is sensitive to the slab count.** 4 slabs made the fork and spoon rock by 5 to 16
  degrees at rest; 12 did too. 8 settles flat.
