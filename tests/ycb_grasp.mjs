// Can the SO-101 pick up the YCB mug? The mug is moved into reach first, because the level
// places it out of the way of the other tasks.
//   node tests/ycb_grasp.mjs
import { setup } from './harness.mjs';

const results = [];
for (const [name, x, y] of [['mug', 0.28, 0.20]]) {
  const { sim, teleop, moveTo, reachIn, bodyPos } = await setup('bring_medication');
  const adr = sim.qposAdr(`${name}_free`);
  sim.data.qpos[adr] = x; sim.data.qpos[adr + 1] = y; sim.data.qpos[adr + 2] = 0;
  sim.mj.mj_forward(sim.model, sim.data);
  const start = bodyPos(name);
  const grip = [start[0], start[1], 0.045]; // grip the body about 4.5 cm up
  reachIn(grip);
  teleop.setGrip(true); moveTo(grip, { hold: 1 });
  moveTo([grip[0], grip[1], grip[2] + 0.1]);
  const lifted = bodyPos(name)[2] - start[2];
  results.push([name, lifted]);
}
let fails = 0;
for (const [name, lifted] of results) {
  const ok = lifted > 0.05;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} lifted ${(lifted * 100).toFixed(1)} cm`);
}
console.log(`${fails} failure(s)`);
process.exit(fails ? 1 : 0);
