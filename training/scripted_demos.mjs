// Generates raw Handover episodes (docs/episode_schema.md) with a scripted player that
// drives the game's own Sim, Teleop, task scoring and Recorder, so the output is what the
// browser exports. The cup start position and the motion are randomized per episode.
// Useful to bootstrap a first policy and to test the pipeline without playing by hand.
//
//   node training/scripted_demos.mjs --out data/raw --episodes 50 --seed 0
//
// Writes one .jsonl.gz per run (one episode per line), like the browser's download.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { Sim } = await import(path.join(WEB, 'src/sim.js'));
const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { TASKS } = await import(path.join(WEB, 'src/task.js'));
const { Recorder } = await import(path.join(WEB, 'src/recorder.js'));

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((s) => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? 'true']));
const OUT = path.resolve(args.out ?? 'data/raw');
const N = Number(args.episodes ?? 50);
const KEEP_FAILED = args['keep-failed'] === 'true';
let seed = Number(args.seed ?? 0) >>> 0;

// Small seeded PRNG (mulberry32) so runs are reproducible.
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uniform = (lo, hi) => lo + (hi - lo) * rand();

const LEVEL = 'models/kitchen.xml';
const RENDER_FPS = 60; // the browser game loop rate
const Z = 0.035;       // grasp height of the cup, meters

// Sim loads the level over HTTP like the browser does, so serve web/ briefly.
const server = http.createServer(async (req, res) => {
  try { res.end(await readFile(path.join(WEB, decodeURIComponent(req.url)))); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const sim = await Sim.create(`http://localhost:${server.address().port}/${LEVEL}`);
server.close();
const teleop = new Teleop(sim);
const task = TASKS.map((T) => new T(sim, teleop.ik)).find((t) => t.id === 'cup_on_tray');
const recorder = new Recorder(sim, teleop, { level: LEVEL });
const { model, data } = sim;

const bodyPos = (n) => { const i = sim.id('BODY', n); return Array.from(data.xpos.slice(3 * i, 3 * i + 3)); };

function runEpisode() {
  sim.reset();
  // Shift the cup up to 4 cm in x and y from where the level places it.
  const cupAdr = sim.qposAdr('cup_free');
  const cupXY = [data.qpos[cupAdr] + uniform(-0.04, 0.04), data.qpos[cupAdr + 1] + uniform(-0.04, 0.04)];
  data.qpos[cupAdr] = cupXY[0];
  data.qpos[cupAdr + 1] = cupXY[1];
  sim.mj.mj_forward(model, data);
  teleop.reset();
  task.reset();
  recorder.start(task);
  recorder.noteInput('script');

  let lag = 0;
  // One game-loop frame, in the same order as web/src/main.js.
  function frame() {
    const dt = 1 / RENDER_FPS;
    teleop.apply(dt);
    for (lag += dt; lag >= sim.dt; lag -= sim.dt) { sim.step(); recorder.update(); }
    task.update();
  }
  const speed = uniform(0.09, 0.15);
  // Move the target in a straight line, then hold, like a player tapping keys.
  function moveTo(pos, hold = uniform(0.2, 0.5), v = speed) {
    const start = teleop.target.slice();
    const T = Math.max(1e-6, Math.hypot(...pos.map((x, i) => x - start[i])) / v);
    for (let t = 0; t < T + hold && task.state === 'playing'; t += 1 / RENDER_FPS) {
      const a = Math.min(1, t / T), s = a * a * (3 - 2 * a); // smoothstep: no jerk at the ends
      for (let i = 0; i < 3; i++) teleop.target[i] = start[i] + (pos[i] - start[i]) * s;
      frame();
    }
  }

  const cup = bodyPos('cup'), tray = bodyPos('tray');
  const above = uniform(0.06, 0.1);
  const drop = [tray[0] + uniform(-0.02, 0.02), tray[1] + uniform(-0.015, 0.015)];
  moveTo([cup[0], cup[1], Z + above]);
  moveTo([cup[0], cup[1], Z], uniform(0.2, 0.5), speed / 2); // slow final approach, as in tests/harness.mjs
  teleop.setGrip(true); moveTo([cup[0], cup[1], Z], 0.8);
  moveTo([cup[0], cup[1], Z + above]);
  moveTo([drop[0], drop[1], Z + above]);
  moveTo([drop[0], drop[1], Z + 0.012]);
  teleop.setGrip(false); moveTo([drop[0], drop[1], Z + 0.012], 0.8);
  moveTo([drop[0], drop[1], Z + 0.1], 2);

  const result = task.state === 'playing' ? { success: false, score: 0, reason: 'script ended' } : task.result;
  const ep = recorder.finish(result, task.events);
  ep.metrics.cup_start = cupXY;
  return ep;
}

await mkdir(OUT, { recursive: true });
const episodes = [];
let tries = 0;
while (episodes.length < N && tries < 3 * N) {
  tries++;
  const ep = runEpisode();
  console.log(`episode ${tries}: ${ep.success ? `success, score ${ep.score}` : `failed (${ep.metrics.reason})`}, ${ep.frames.time.length} frames`);
  if (ep.success || KEEP_FAILED) episodes.push(ep);
}
const file = path.join(OUT, `scripted-${new Date().toISOString().replace(/[:.]/g, '-')}-seed${args.seed ?? 0}.jsonl.gz`);
await writeFile(file, gzipSync(episodes.map((e) => JSON.stringify(e)).join('\n') + '\n'));
console.log(`${episodes.length}/${tries} episodes written to ${file}`);
