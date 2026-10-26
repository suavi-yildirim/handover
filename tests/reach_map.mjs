// Prints where a level gripper can reach the table: for each grid point, can the arm
// hover above it and then lower the open jaws to grasp height?   node tests/reach_map.mjs [z]
import { setup } from './harness.mjs';
import { ROBOT } from '../web/src/robot.js';

const { sim, teleop } = await setup('cup_on_tray');
const Z = Number(process.argv[2] ?? 0.035), ABOVE = 0.06;
const ok = (x, y) => {
  teleop.reset();
  teleop.pitch = ROBOT.defaultPitch; teleop.roll = ROBOT.defaultRoll;
  // Walk the target there in small steps like a player would (IK is a local solver).
  const p0 = teleop.target.slice();
  const path = [];
  for (let i = 1; i <= 20; i++) { const a = i / 20; path.push([p0[0] + (x - p0[0]) * a, p0[1] + (y - p0[1]) * a, p0[2] + (Z + ABOVE - p0[2]) * a]); }
  for (let i = 1; i <= 10; i++) path.push([x, y, Z + ABOVE - ABOVE * i / 10]);
  for (const t of path) { teleop.target = t; if (!teleop.trySolve(t)) return false; }
  return true;
};
const ys = [], xs = [];
for (let y = -0.40; y <= 0.401; y += 0.04) ys.push(Math.round(y * 100) / 100);
for (let x = 0.10; x <= 0.481; x += 0.02) xs.push(Math.round(x * 100) / 100);
console.log(`z=${Z}  rows: x (m), columns: y from ${ys[0]} to ${ys.at(-1)} step 0.04   # = reachable`);
for (const x of xs) console.log(x.toFixed(2), ys.map((y) => (ok(x, y) ? '#' : '.')).join(' '));
process.exit(0);
