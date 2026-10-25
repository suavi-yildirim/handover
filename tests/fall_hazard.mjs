// Task 3: a scripted player lifts the glasses case off the table edge and sets it down
// in the safe zone.   node tests/fall_hazard.mjs [episode-out.jsonl]
import { setup, episodeChecks, report } from './harness.mjs';

const { sim, teleop, task, recorder, moveTo, reachIn, bodyPos } = await setup('tidy_fall_hazard');
const Z = 0.02; // grasp height on the case, meters

// The case lies with its long axis pointing at the robot: grip its near end.
const c = bodyPos('glasses_case'), u = Math.hypot(c[0] - 0.0388, c[1]);
const box = [c[0] - 0.04 * (c[0] - 0.0388) / u, c[1] - 0.04 * c[1] / u];
const g = sim.id('GEOM', 'safe_zone'), safe = Array.from(sim.data.geom_xpos.slice(3 * g, 3 * g + 3));
reachIn([box[0], box[1], Z]);
teleop.setGrip(true); moveTo([box[0], box[1], Z], { hold: 1 });
moveTo([box[0], box[1], Z + 0.1]);
const lifted = bodyPos('glasses_case')[2];
moveTo([safe[0], safe[1], Z + 0.1]);
moveTo([safe[0], safe[1], Z + 0.008]);
teleop.setGrip(false); moveTo([safe[0], safe[1], Z + 0.008], { hold: 1 });
moveTo([safe[0], safe[1], Z + 0.1]);

await report([
  ['case lifted > 5 cm', lifted > 0.05],
  ['task reports success', task.state === 'success'],
  ...episodeChecks(recorder, sim),
], task, recorder);
