# Tasks: success predicates and scoring

Every task defines success as predicates on simulator state, plus quality metrics that make
up the score. Design rule: **game score = data-quality score**. Code: `web/src/task.js`.
Keep this file and the code in sync.

## Rules shared by every task

- **Leave other things alone.** The episode **fails** if any loose object that isn't part
  of the task (cup, medicine bottle, glasses case) tips more than 60° from vertical or falls
  off the table, for example when a carried object swings into it.
- **Bumps** count each new contact between the robot and anything other than the task
  object, and each new contact between the task object and another loose object.

## Task 1: Put the cup on the tray (kitchen)

The player picks up the blue cup and sets it down upright on the green tray.

### Success

All of these must hold continuously for **0.5 s** (simulation time):

| Predicate | Definition |
|---|---|
| Cup on the tray | Cup center within ±5.5 cm (x) and ±4 cm (y) of the tray center, and cup origin below 1.5 cm above the table (it rests on the tray floor at 0.6 cm) |
| Upright | Cup axis within 15° of vertical |
| Gripper let go | No contact between the cup and either gripper jaw |
| Resting still | Cup linear speed below 2 cm/s |

The episode **fails** immediately if the cup tilts more than 60° from vertical (tipped over).

### Score (0–100, only on success)

Score = 100 × Σ weight × metric. Each metric is between 0 and 1.

| Metric | Weight | Formula | Why it matters for data |
|---|---|---|---|
| Speed | 0.15 | 1 up to 20 s, falling linearly to 0 at 90 s | Efficient demos, less idle time |
| Smooth motion | 0.20 | exp(−RMS jerk / 60 m/s³) of the grasp point, sampled every 40 ms of sim time | Smooth trajectories are easier to learn and safe on real hardware |
| No bumps | 0.25 | 1 − 0.2 × number of bumps (see shared rules) | Care robots must never bump people or objects |
| Kept level | 0.25 | 1 up to 10° max tilt while the cup is carried, falling linearly to 0 at 45° | Proxy for spilling |
| No drops | 0.15 | 1 − 0.5 × number of times the cup was let go while more than 3 cm up and unsupported | Drops and regrasps are low-quality demos |

Task id `cup_on_tray`, policy prompt "Put the cup on the tray." A scripted,
straight-line demo (hover over the cup, lower the open jaws around it) scores about 96 (`node tests/pick_place.mjs`).

### Tuning notes

- The jerk scale (60 m/s³) was calibrated on scripted runs: 0.12 m/s straight-line moves
  give ~16 m/s³ RMS jerk, 0.25 m/s moves ~60–90 m/s³.
- Keyboard input passes through a 0.15 s velocity filter in `teleop.js`, so on/off keys
  still give smooth motion.
- Later layers from CLAUDE.md (robot feasibility replay, gold levels, peer review) are not
  in the score yet.

## Task 2: Bring the medication (kitchen)

Task id `bring_medication`, policy prompt "Hand the medicine bottle to the person." The
player picks up the orange medicine bottle and holds it in the pink hand zone (a 4 cm
radius sphere where a person's hand waits) so the person can take it.

### Success

All of these must hold continuously for **1.5 s** (simulation time):

| Predicate | Definition |
|---|---|
| Holding the bottle | Both gripper jaws touch the bottle |
| In the hand zone | Bottle center (origin + 3.6 cm) within the hand zone sphere |
| Upright | Bottle axis within 30° of vertical |
| Holding still | Bottle linear speed below 3 cm/s |

The episode **fails** if the bottle is let go while more than 3 cm up and unsupported
(dropped), or tilts more than 60° from vertical.

### Score (0–100, only on success)

| Metric | Weight | Formula | Why it matters for data |
|---|---|---|---|
| Speed | 0.15 | as task 1 | |
| Smooth motion | 0.20 | as task 1 | |
| No bumps | 0.20 | as task 1 | |
| Gentle approach | 0.25 | 1 when the bottle first enters the zone below 5 cm/s, falling linearly to 0 at 25 cm/s | A handover must never jab at a person's hand |
| Steady hold | 0.20 | 1 − mean bottle speed during the final hold / 3 cm/s | The person needs a still object to take |

A scripted demo with a 4 cm/s final approach scores about 95 (`node tests/medication.mjs`).

## Task 3: Tidy a fall hazard (kitchen)

Task id `tidy_fall_hazard`, policy prompt "Move the glasses case away from the table edge
to the safe spot." A glasses case (14 × 4 × 3.6 cm, 45 g) lies on the red edge strip on
the person's side of the table, where an elbow or sleeve could knock it to the floor. The
player lifts it and sets it down flat in the green safe spot at the back of the table.
(A table-mounted SO-101 can't reach the floor, so the hazard is on the table edge.)

### Success

All of these must hold continuously for **0.5 s**:

| Predicate | Definition |
|---|---|
| In the safe spot | Case center within the safe zone (12 × 10 cm) |
| Lying flat | Case origin below 1 cm and its short axis within 15° of vertical |
| Gripper let go | No contact between the case and either jaw |
| Resting still | Case linear speed below 2 cm/s |

The episode **fails** if the case falls off the table.

### Score (0–100, only on success)

| Metric | Weight | Formula | Why it matters for data |
|---|---|---|---|
| Speed | 0.15 | as task 1 | |
| Smooth motion | 0.20 | as task 1 | |
| No bumps | 0.25 | as task 1 | |
| Lifted, not pushed | 0.25 | share of the case's horizontal path traveled while held off the table: full marks at 90%, zero at 50% | Pushing things across a table is a poor, unsafe strategy to teach |
| No drops | 0.15 | as task 1 | |

A scripted demo scores about 89 (`node tests/fall_hazard.mjs`); its smoothness is lower
because the carry swings the arm around its base.

## Scene layout and start pose

The arm starts level with the wrist camera on top (wrist roll −90°), grasp point about
15 cm above the table at (0.26, 0). A level SO-101 gripper reaches the table only about
28 cm or more from the shoulder axis, so the objects sit about 30–36 cm out: cup
(0.33, 0.11), medicine bottle (0.34, −0.03), tray (0.32, −0.17), glasses case (0.22, 0.30),
safe spot (0.12, −0.31), hand zone (0.12, 0.28, 0.12). Targets the arm can't reach at the
commanded tilt are refused (the gripper slides along the reach limit or stops) instead of
letting the IK fold the arm into a different pose.

## Episode tags and events

Each recorded episode also carries `license` (`CC-BY-4.0`: recorded play data is released
under CC BY 4.0, attribution "Suavi Yildirim and the Handover contributors"), `contributor_id` (random, per browser), `inputs`,
`game_version`, `mujoco_version`, `scene_seed` (null until scenes are randomized), and an
`events` list of `{t, type}` with type `grasp`, `release`, `drop`, `success`, or `fail`.

## Ideas not in the score yet

From the research thread: path-length efficiency, partial credit for failed attempts,
handover form for task 2 (release only once the person holds the load), peak contact
force, and a robot-feasibility gate.