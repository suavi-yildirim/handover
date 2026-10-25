# Kitchen realism notes

What the kitchen level models, and where the numbers come from. Physics first:
these values change the recorded data, the visuals do not.

## Layout (web/models/kitchen/room.xml)

Frame: table top z = 0, robot base at the origin facing +x, floor z = -0.75.

| Item | Size | Source |
|---|---|---|
| Kitchen table | 75 cm high, 70 x 90 cm | Common small kitchen table |
| Base cabinets | 60 cm deep, worktop at 90 cm, 4 cm worktop, 10 cm plinth | DIN 68935 / typical EU kitchen |
| Wall cabinets | 35 cm deep, 55 cm above the worktop, 70 cm tall | Typical EU kitchen |
| Room | 2.6 m ceiling height, about 3.5 x 3.8 m | Typical apartment kitchen |
| Window | 1.2 x 1.2 m, sill at 90 cm | Typical |
| Chair | seat at 45 cm | Typical dining chair |

The kitchen units stand along the wall the robot faces, so the play camera sees
them. The person receiving a handover sits on the +y side of the table, next to
the hand zone. Only the floor collides; everything else in the room is visual,
and nothing in it is a free body, so the "ready" keyframe does not change.

## Task objects (web/models/kitchen.xml)

| Object | Real thing | Mass | Notes |
|---|---|---|---|
| cup | Porcelain espresso-size cup, 4 cm x 7 cm, 3 mm walls, 5 mm base, handle | 73 g | Porcelain 2300 kg/m^3. Hollow-shell inertia, centre of mass 3.1 cm up |
| pill_bottle | PP pharmacy vial 3 cm x 6 cm, 1.2 mm walls, 10 g of tablets, cap | 20 g | Centre of mass 2.5 cm up (tablets at the bottom) |
| tray | Small melamine tray, fixed to the table | - | Fixed so "cup on tray" is well defined |

Inertias are computed by `tools/kitchen_inertia.py`.

## Contact and friction

| Pair | Coulomb mu | Why |
|---|---|---|
| Cup / bottle on table or tray | 0.4 | Glazed ceramic or PP plastic on lacquered wood / melamine is about 0.3-0.5. Previously 1.0, which made objects tip over instead of sliding |
| Objects on floor tiles | 0.6 | |
| Gripper jaws on objects | 0.4 | Bare 3D-printed PLA jaws on ceramic or plastic (was 1.0 in Menagerie). With grip tape on the real jaws, raise to about 0.9 |

Torsional friction 0.004 m (about mu times the contact patch radius) and rolling
friction 0.0001 m (hard objects). `solref 0.01 1` on the objects keeps resting
penetration under 0.2 mm at the 2 ms timestep.

## Robot strength (web/models/so101/so101.xml)

The simulated arm must not be stronger than the real one, or players record motions
a real SO-101 can't repeat.

| Setting | Value | Why |
|---|---|---|
| Arm joint torque limit | 1.91 N.m | Stall torque of the 7.4 V STS3215 (1/345 gear, 19.5 kg.cm). The 12 V servo gives 2.94 N.m, which is what Menagerie uses. We use the weaker one, so anything recorded is possible on either real arm |
| Gripper torque limit | 0.95 N.m | LeRobot's SO-101 follower sets the gripper's Max_Torque_Limit to 50% so it can hold objects without overheating |
| Position gains | kp 998, kv 2.73 (Menagerie) | They assume LeRobot's P coefficient of 16. Not system-identified yet |
| Backlash | none | Menagerie defines 0.5 deg backlash but applies it to no joint. Leave it until there is a real arm to measure |

Margins: holding the 73 g cup, the worst static gravity torque anywhere above the
table is 1.15 N.m (shoulder lift), 60% of the limit. All task tests pass with these
limits, and still pass with jaw friction 0.3 or a 0.6 N.m gripper.

## Checks

- `python3 tools/check_kitchen_physics.py`: masses, settling, sinking, slides-not-tips, speed.
- `node tests/pick_place.mjs`: the game's own controls still pick the cup and set it on the tray.

## Visuals (web/src/look.js)

Physically based materials from the MJCF material attributes (MJCF colours read
as sRGB), MuJoCo's built-in tile textures, the level's own MJCF lights (window
daylight and a pendant lamp, both with soft shadows), AgX tone mapping, and a
reflection map baked once from the room. Static geoms are posed once instead of
every frame. Cost: about 250 draw calls with two 2048 shadow maps, fine on an M2.

## Later (domain randomization, CLAUDE.md section 4.5)

Good ranges to randomize per episode: object mass +-20%, table friction 0.3-0.6,
cup radius 1.8-2.2 cm, light direction and colour temperature, worktop and
cabinet colours.
