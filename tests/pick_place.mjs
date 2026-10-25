// Headless check that the game's own Sim + Teleop code can pick up the cup and set it
// upright on the tray. Runs in Node (no browser, no GPU):  node tests/pick_place.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { Sim } = await import(path.join(WEB, 'src/sim.js'));
const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { CupOnTrayTask } = await import(path.join(WEB, 'src/task.js'));
const { Recorder, FPS: REC_FPS } = await import(path.join(WEB, 'src/recorder.js'));

// Sim loads the level over HTTP like the browser does, so serve web/ briefly.
const server = http.createServer(async (req, res) => {
  try { res.end(await readFile(path.join(WEB, decodeURIComponent(req.url)))); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const FPS = 60, SPEED = 0.12, Z = 0.035; // grasp height of the cup, meters
const sim = await Sim.create(`${base}/models/kitchen.xml`);
server.close();
const teleop = new Teleop(sim);
const task = new CupOnTrayTask(sim, teleop.ik);
const recorder = new Recorder(sim, teleop, { level: 'models/kitchen.xml' });
recorder.start(task);
recorder.noteInput('script');

const bodyPos = (n) => { const i = sim.id('BODY', n); return Array.from(sim.data.xpos.slice(3 * i, 3 * i + 3)); };
let lag = 0;
function frame(dt) {
  teleop.apply(dt);
  for (lag += dt; lag >= sim.dt; lag -= sim.dt) sim.step();
  task.update();
  recorder.update();
  if (task.state !== 'playing' && recorder.current) recorder.finish(task.result);
}
// Move the target in a straight line at SPEED, then hold.
function moveTo(pos, hold = 0.6) {
  const start = teleop.target.slice(), dt = 1 / FPS;
  const T = Math.max(1e-6, Math.hypot(...pos.map((v, i) => v - start[i])) / SPEED);
  for (let t = 0; t < T + hold; t += dt) {
    const a = Math.min(1, t / T);
    for (let i = 0; i < 3; i++) teleop.target[i] = start[i] + (pos[i] - start[i]) * a;
    frame(dt);
  }
}

const cup = bodyPos('cup'), tray = bodyPos('tray');
moveTo([cup[0], cup[1], Z + 0.08]);
moveTo([cup[0], cup[1], Z]);
teleop.setGrip(true); moveTo([cup[0], cup[1], Z], 1);
moveTo([cup[0], cup[1], Z + 0.08]);
const lifted = bodyPos('cup')[2];
moveTo([tray[0], tray[1], Z + 0.08]);
moveTo([tray[0], tray[1], Z + 0.012]);
teleop.setGrip(false); moveTo([tray[0], tray[1], Z + 0.012], 1);
moveTo([tray[0], tray[1], Z + 0.1]);

const end = bodyPos('cup'), id = sim.id('BODY', 'cup'), upright = sim.data.xmat[9 * id + 8];
const checks = [
  ['cup lifted > 5 cm', lifted > 0.05],
  ['cup over tray', Math.abs(end[0] - tray[0]) < 0.06 && Math.abs(end[1] - tray[1]) < 0.045],
  ['cup resting on tray floor', end[2] > 0 && end[2] < 0.02],
  ['cup upright', upright > 0.97],
  ['task reports success', task.state === 'success'],
];
const ep = recorder.episodes[0];
const f = ep ? ep.frames : { time: [], qpos: [], qvel: [], ctrl: [] };
const T = f.time.length, rate = T > 1 ? (T - 1) / (f.time[T - 1] - f.time[0]) : 0;
checks.push(
  ['episode recorded as a success', !!ep && ep.success === true && ep.score > 0],
  [`episode at ${REC_FPS} fps (got ${rate.toFixed(2)})`, Math.abs(rate - REC_FPS) < 0.5],
  ['full sim state per frame', [f.qpos, f.qvel, f.ctrl].every((c) => c.length === T) &&
    f.qpos.every((q) => q.length === sim.model.nq) && f.qvel.every((v) => v.length === sim.model.nv) &&
    f.ctrl.every((u) => u.length === sim.model.nu)],
);
// Optionally save the episode, e.g. as converter input:  node tests/pick_place.mjs out.jsonl
if (ep && process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(ep) + '\n');
console.log('score', JSON.stringify(task.result));
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
