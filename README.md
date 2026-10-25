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
2. ✅ Success check + score, the first playable demo. All three MVP tasks are in ([task definitions](docs/tasks.md)).
3. ✅ Phone control.
4. Episode logging (✅ recording in the game), training pipeline, and the model playing the level.

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
| C | show / hide the wrist camera view |
| R | reset the level |
| 1 / 2 / 3 | switch task |
| Mouse | orbit and zoom the camera |

The arm starts with the gripper level and the wrist camera on top, and the small view in
the corner shows what that camera sees, for lining up grasps. A level gripper reaches low
objects best about 30 cm out from the robot, so that is where the objects sit. Hover over
an object with the jaws open, lower them around it, and close. If you steer somewhere the
arm can't reach at the current tilt, the gripper stops (or slides along the reach limit)
and the status bar says "out of reach"; tilting the gripper down (I) reaches closer in.

Pick a task in the task panel (or press 1, 2 or 3):

1. **Put the cup on the tray**: pick up the blue cup and set it down upright on the green tray.
2. **Bring the medication**: hold the orange medicine bottle still and upright inside the
   pink hand zone so a person can take it. Approach slowly.
3. **Tidy a fall hazard**: lift the glasses case off the red strip at the table edge and set
   it down flat in the green safe spot.

For task 1: The panel on the
left shows which success checks are met; when all hold, you get a score out of 100 for
speed, smooth motion, no bumps, keeping the cup level, and no drops. Tip: lower the open
gripper around the cup with E/Q, press Space to grip, lift, move over the tray, lower,
and press Space again to let go.

### Control with your phone

Start the game with the phone server instead of `http.server` (still only Python 3):

```sh
python3 tools/phone_server.py
```

Open <http://localhost:8000> on the Mac. A card in the corner shows a QR code; scan it with
a phone on the same Wi-Fi (or type the `https://…:8443/phone/` address the server prints).
The first time, the phone warns about the certificate because it is a self-signed one made
for your Mac: tap *Show Details > visit this website* (iPhone) or *Advanced > Proceed*
(Android). If macOS asks whether Python may accept incoming connections, allow it.

The phone opens in **Motion** mode: hold *Hold to move* and move the phone, let go to
reposition your hand (like lifting a mouse). Two styles, switched with the *Style* button:

| Style | What moves the gripper |
|---|---|
| Aim (default) | turn the phone left / right to slide, tip it up / down to reach farther / closer, turn it like a key to roll the wrist; the slider sets the height |
| Push β | move the phone itself and the gripper follows in 3D. Experimental: phone accelerometers drift, so short moves work best |

Hold the phone flat (top edge toward the screen) or upright (back toward the screen); both
work. True 6-DoF tracking of an iPhone needs a native ARKit app, which is a later step.

*Mode: Sticks* switches to on-screen controls:

| Phone | Action |
|---|---|
| Left joystick | move the gripper (relative to the camera, like WASD) |
| Right slider | up / down |
| Grip | close / open the gripper |
| Tilt: on | tip the phone away / toward you to tilt the gripper, turn it like a steering wheel to roll the wrist |
| Recenter | make the current way you hold the phone the neutral pose |

Keyboard and phone work at the same time. The arm stops if the phone locks, switches apps,
or drops off Wi-Fi. `http://localhost:8000/phone/demo.html` shows what the phone sends
without the robot, for checking the connection.

### Control with a 3D mouse

A 3Dconnexion SpaceMouse works in **Chrome or Edge** (they support WebHID; Safari doesn't).
Click **Connect 3D mouse** under the key list and pick the device once; the page reconnects
to it after that. If it doesn't show up or doesn't respond on a Mac, quit the 3Dconnexion
driver app (3DxWare) so the browser can open the device.

| 3D mouse | Action |
|---|---|
| Push / pull the cap | gripper forward / back (relative to the camera) |
| Slide the cap left / right | gripper left / right |
| Lift / press the cap | up / down |
| Tilt the cap forward / back | tilt the gripper |
| Twist the cap | roll the wrist |
| Left button | open / close the gripper |
| Right button | precise (slow) mode on / off |

Keyboard, phone and 3D mouse all work at the same time.

### Recording episodes

Every attempt is recorded as an episode: the full simulator state 30 times per second
(sim-native units), what the player was steering toward, and the task result and score.
When at least one episode has finished, a **Download episodes** button appears in the task
panel. It saves all episodes from this session as one `.jsonl.gz` file (one episode per
line) for the training pipeline, which renders camera views and writes a LeRobot dataset.
Episodes stay in the page until downloaded, so download before closing the tab. A sample
episode is in `tests/fixtures/`.

## Tests

```sh
node tests/pick_place.mjs
node tests/medication.mjs
node tests/fall_hazard.mjs
node tests/spacemouse.mjs
```

Runs the game's own simulation and control code headlessly and checks that a scripted
player can complete each task (cup on the tray, medication handover, fall hazard), get a success and a
score, and record a clean 30 fps episode. Needs Node 18+.

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
    spacemouse.js       3D mouse input (WebHID)
    phone.js            phone input (game side): same commands as the keyboard
    task.js             success predicates and scoring
    recorder.js         episode recording (30 fps raw sim state)
    render.js           three.js rendering of the MuJoCo scene
    main.js             game loop and HUD
  phone/                phone controller page (motion, joystick, tilt, Grip) + demo.html
  models/
    kitchen.xml         level 1: kitchen table, cup, tray, medicine bottle, glasses case
    so101/              SO-101 arm (MuJoCo Menagerie, Apache-2.0)
  vendor/               MuJoCo WASM 3.16.0 and three.js 0.186.1, pinned
tools/
  phone_server.py       local server: HTTP for the Mac, HTTPS + WebSocket relay for the phone
tests/
  harness.mjs           shared headless test setup
  pick_place.mjs        task 1: pick-and-place, scoring and recording check
  medication.mjs        task 2: handover check
  fall_hazard.mjs       task 3: fall-hazard check
  fixtures/             one scripted episode per task, for the training pipeline
docs/
  tasks.md              success predicates and score weights for each task
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
