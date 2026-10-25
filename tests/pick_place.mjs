// Task 1: a scripted player picks up the cup and sets it upright on the tray.
//   node tests/pick_place.mjs [episode-out.jsonl]
import { setup, episodeChecks, report } from './harness.mjs';

const { sim, teleop, task, recorder, moveTo, bodyPos } = await setup('cup_on_tray');
const Z = 0.035; // grasp height on the cup, meters

const cup = bodyPos('cup'), tray = bodyPos('tray');
moveTo([cup[0], cup[1], Z + 0.08]);
moveTo([cup[0], cup[1], Z]);
teleop.setGrip(true); moveTo([cup[0], cup[1], Z], { hold: 1 });
moveTo([cup[0], cup[1], Z + 0.08]);
const lifted = bodyPos('cup')[2];
moveTo([tray[0], tray[1], Z + 0.08]);
moveTo([tray[0], tray[1], Z + 0.012]);
teleop.setGrip(false); moveTo([tray[0], tray[1], Z + 0.012], { hold: 1 });
moveTo([tray[0], tray[1], Z + 0.1]);

const end = bodyPos('cup'), id = sim.id('BODY', 'cup'), upright = sim.data.xmat[9 * id + 8];
await report([
  ['cup lifted > 5 cm', lifted > 0.05],
  ['cup over tray', Math.abs(end[0] - tray[0]) < 0.06 && Math.abs(end[1] - tray[1]) < 0.045],
  ['cup resting on tray floor', end[2] > 0 && end[2] < 0.02],
  ['cup upright', upright > 0.97],
  ['task reports success', task.state === 'success'],
  ...episodeChecks(recorder, sim),
], task, recorder);
