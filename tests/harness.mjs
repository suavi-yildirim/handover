// Shared setup for headless tests: loads the game's own Sim, Teleop, task and recorder
// code in Node (no browser, no GPU) and drives the gripper target like a player would.
import path from 'node:path';
import { WEB, loadSim } from '../tools/headless.mjs';

const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { TASKS } = await import(path.join(WEB, 'src/task.js'));
const { Recorder, FPS: REC_FPS } = await import(path.join(WEB, 'src/recorder.js'));

export { REC_FPS };
export const FPS = 60;

export async function setup(taskId) {
  const sim = await loadSim('models/kitchen.xml');
  const teleop = new Teleop(sim);
  const task = TASKS.map((T) => new T(sim, teleop.ik)).find((t) => t.id === taskId);
  const recorder = new Recorder(sim, teleop, { level: 'models/kitchen.xml' });
  recorder.start(task);
  recorder.noteInput('script');

  let lag = 0;
  function frame(dt) {
    teleop.apply(dt);
    for (lag += dt; lag >= sim.dt; lag -= sim.dt) { sim.step(); recorder.update(); }
    task.update();
    if (task.state !== 'playing' && recorder.current) recorder.finish(task.result, task.events);
  }
  // Move the target in a straight line at `speed` m/s, then hold.
  function moveTo(pos, { hold = 0.6, speed = 0.12 } = {}) {
    const start = teleop.target.slice(), dt = 1 / FPS;
    const T = Math.max(1e-6, Math.hypot(...pos.map((v, i) => v - start[i])) / speed);
    for (let t = 0; t < T + hold; t += dt) {
      const a = Math.min(1, t / T);
      for (let i = 0; i < 3; i++) teleop.target[i] = start[i] + (pos[i] - start[i]) * a;
      frame(dt);
    }
  }
  // Level-gripper grasp: hover over the object with the jaws open, then lower them around it.
  // (A level SO-101 gripper reaches low only about 28 cm or more from the shoulder, so a
  // horizontal slide-in from a standoff is out of reach for objects at about 30 cm.)
  function reachIn(pos, { above = 0.06 } = {}) {
    moveTo([pos[0], pos[1], pos[2] + above]);
    moveTo(pos, { speed: 0.06 });
  }
  const bodyPos = (n) => { const i = sim.id('BODY', n); return Array.from(sim.data.xpos.slice(3 * i, 3 * i + 3)); };
  const sitePos = (n) => { const i = sim.id('SITE', n); return Array.from(sim.data.site_xpos.slice(3 * i, 3 * i + 3)); };
  return { sim, teleop, task, recorder, moveTo, reachIn, bodyPos, sitePos };
}

// Checks every recorded episode should pass.
export function episodeChecks(recorder, sim) {
  const ep = recorder.episodes[0];
  const f = ep ? ep.frames : { time: [], qpos: [], qvel: [], ctrl: [] };
  const T = f.time.length, rate = T > 1 ? (T - 1) / (f.time[T - 1] - f.time[0]) : 0;
  return [
    ['episode recorded as a success', !!ep && ep.success === true && ep.score > 0],
    [`episode at ${REC_FPS} fps (got ${rate.toFixed(2)})`, Math.abs(rate - REC_FPS) < 0.5],
    ['frames within one physics step of the 30 Hz grid', f.time.every((t, i) => i === 0 ||
      Math.abs(t - f.time[i - 1] - 1 / REC_FPS) <= sim.dt + 1e-6)],
    ['full sim state per frame', [f.qpos, f.qvel, f.ctrl].every((c) => c.length === T) &&
      f.qpos.every((q) => q.length === sim.model.nq) && f.qvel.every((v) => v.length === sim.model.nv) &&
      f.ctrl.every((u) => u.length === sim.model.nu)],
  ];
}

export async function report(checks, task, recorder) {
  // Optionally save the episode, e.g. as converter input:  node tests/x.mjs out.jsonl
  if (recorder.episodes[0] && process.argv[2]) {
    (await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(recorder.episodes[0]) + '\n');
  }
  console.log('score', JSON.stringify(task.result));
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}
