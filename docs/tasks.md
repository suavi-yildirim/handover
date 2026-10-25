# Tasks: success predicates and scoring

Every task defines success as predicates on simulator state, plus quality metrics that make
up the score. Design rule: **game score = data-quality score**. Code: `web/src/task.js`.
Keep this file and the code in sync.

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
| No bumps | 0.25 | 1 − 0.2 × number of new robot contacts with anything other than the cup | Care robots must never bump people or objects |
| Kept level | 0.25 | 1 up to 10° max tilt while the cup is carried, falling linearly to 0 at 45° | Proxy for spilling |
| No drops | 0.15 | 1 − 0.5 × number of times the cup was let go while more than 3 cm up and unsupported | Drops and regrasps are low-quality demos |

Task id `cup_on_tray`, policy prompt "Put the cup on the tray." A scripted,
straight-line demo scores about 95 (`node tests/pick_place.mjs`).

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

A scripted demo with a 4 cm/s final approach scores about 94 (`node tests/medication.mjs`).

## Planned tasks

3. **Tidy a fall hazard**: move an object off the floor or walkway to a safe place. Needs
   a new object in the scene, so it waits for the kitchen realism work to land.
