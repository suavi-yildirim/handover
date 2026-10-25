// Task 3: a scripted player lifts the glasses case off the table edge and sets it down
// in the safe zone.   node tests/fall_hazard.mjs [episode-out.jsonl]
import { setup, episodeChecks, report } from './harness.mjs';

const { sim, teleop, task, recorder, moveTo, bodyPos } = await setup('tidy_fall_hazard');
const Z = 0.02; // grasp height on the case, meters

const box = bodyPos('glasses_case');
const g = sim.id('GEOM', 'safe_zone'), safe = Array.from(sim.data.geom_xpos.slice(3 * g, 3 * g + 3));
moveTo([box[0], box[1], Z + 0.08]);
moveTo([box[0], box[1], Z]);
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
