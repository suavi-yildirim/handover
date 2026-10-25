# Handover

**Teach a robot to care, by playing a game.**

Handover is a free, open-source game where players teach a simulated robot arm everyday
care tasks: bring medication, hand over a cup safely, tidy a fall hazard, set a table.
Every episode a player completes becomes training data for open Vision-Language-Action
(VLA) robot models.

Aging populations and a shortage of caregivers make home-assistance robots important, and
the main bottleneck is not hardware or models but large, diverse, high-quality
demonstration data. A game lets many people produce that data cheaply. The score is
designed to equal data quality, so players chasing high scores produce good training data.

## How it works

- You steer a real robot arm model (the low-cost **SO-101**, from MuJoCo Menagerie) in a
  physics simulation. Keyboard today; phone control and Meta Quest 3 later.
- The simulator knows the ground truth, so each episode is checked automatically: task
  success, smoothness, collisions and contact forces, drops, and whether a real robot
  could execute the motion.
- Episodes are logged as robot states and actions (not video) in a
  [LeRobot](https://github.com/huggingface/lerobot)-compatible format, then released as an
  open dataset.
- A compact VLA (SmolVLA) is trained on the demos and plays the levels itself; players
  can watch it and correct it ("coach mode").

## MVP scope

One kitchen level, one robot arm, three care tasks, phone control, automatic success
checks and scoring, episode logging, and one trained policy that plays the level.

Build order:

1. ✅ Arm in a browser kitchen scene, keyboard-controlled.
2. Success check + score, the first playable demo.
3. Phone control.
4. Episode logging, training pipeline, and the model playing the level.

## Play it

Requirements: any modern browser and Python 3 (already on macOS). No MuJoCo install, no
GPU, no build step: the physics engine runs in the browser as WebAssembly.

```sh
cd web
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

| Key | Action |
|---|---|
| W A S D | move the gripper (relative to the camera) |
| E / Q | up / down |
| I / K | tilt the gripper down / up |
| J / L | roll the wrist |
| Space | open / close the gripper |
| Shift | slow, precise moves |
| R | reset the level |
| Mouse | orbit and zoom the camera |

Try it: open the gripper above the blue cup, lower it around the cup, press Space to
grip, lift, and set the cup down upright on the green tray.

## Tests

```sh
node tests/pick_place.mjs
```

Runs the game's own simulation and control code headlessly and checks that a scripted
player can pick up the cup and place it upright on the tray. Needs Node 18+.

## Project layout

```
web/
  index.html            game page
  src/
    robot.js            everything specific to the robot arm (swap arms here)
    sim.js              loads MuJoCo WASM, the level, and its meshes
    ik.js               end-effector inverse kinematics (damped least squares)
    teleop.js           turns "move the gripper" commands into servo targets
    keyboard.js         keyboard input
    render.js           three.js rendering of the MuJoCo scene
    main.js             game loop and HUD
  models/
    kitchen.xml         level 1: kitchen table, cup, tray, medicine bottle
    so101/              SO-101 arm (MuJoCo Menagerie, Apache-2.0)
  vendor/               MuJoCo WASM 3.16.0 and three.js 0.186.1, pinned
tests/
  pick_place.mjs        headless pick-and-place check
CLAUDE.md               full product and technical context
```

World frame: meters, z up, the kitchen table top is at z = 0, and the robot sits at the
origin facing +x.

## Technical choices

- **Physics:** MuJoCo, native on macOS and as WASM in the browser. Physics accuracy comes
  before graphics.
- **Robot:** SO-101 joint names match LeRobot's SO-101 datasets. Robot-specific settings
  live in `web/src/robot.js`, so changing arms is a small code change; recorded data is
  arm-specific, though.
- **Policy:** SmolVLA via LeRobot, with MLX ports for fast inference on Apple Silicon.

See [CLAUDE.md](CLAUDE.md) for the full vision, evaluation layers, training loop, and
related research.

## License

Handover is meant to be open source; a license for its own code hasn't been picked yet
(Apache-2.0 would match MuJoCo and the robot model). The SO-101 model (`web/models/so101`) is Apache-2.0 from
[MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie); MuJoCo is
Apache-2.0 and three.js is MIT, with their licenses in `web/vendor`.
