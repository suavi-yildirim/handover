// Task 2: a scripted player picks up the medicine bottle and holds it in the hand zone.
//   node tests/medication.mjs [episode-out.jsonl]
import { setup, episodeChecks, report } from './harness.mjs';

const { sim, teleop, task, recorder, moveTo, bodyPos, sitePos } = await setup('bring_medication');
const Z = 0.035; // grasp height on the bottle, meters

const bottle = bodyPos('pill_bottle'), zone = sitePos('hand_zone');
moveTo([bottle[0], bottle[1], Z + 0.08]);
moveTo([bottle[0], bottle[1], Z]);
teleop.setGrip(true); moveTo([bottle[0], bottle[1], Z], { hold: 1 });
moveTo([bottle[0], bottle[1], Z + 0.1]);
const lifted = bodyPos('pill_bottle')[2];
// Bring the bottle's center to the zone center: the grasp point sits ~Z above the bottle base,
// and the bottle center is 3.6 cm above its base.
const goal = [zone[0], zone[1], zone[2] - 0.036 + Z];
moveTo([goal[0], goal[1], goal[2] + 0.06]);
moveTo(goal, { speed: 0.04, hold: 2.5 });

await report([
  ['bottle lifted > 5 cm', lifted > 0.05],
  ['task reports success', task.state === 'success'],
  ...episodeChecks(recorder, sim),
], task, recorder);
