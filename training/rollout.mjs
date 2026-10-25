// Lets a trained policy play a Handover task in the game's own simulation and scoring
// code (headless, in Node), talking to policy_server.py for actions. Reports the success
// rate and saves every attempt as raw episodes, which the converter can turn into data
// (e.g. to add corrected attempts later, DAgger-style).
//
//   python training/policy_server.py --policy <checkpoint> &
//   node training/rollout.mjs --task cup_on_tray --episodes 20 --out runs/smolvla.jsonl.gz
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { Sim } = await import(path.join(WEB, 'src/sim.js'));
const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { TASKS } = await import(path.join(WEB, 'src/task.js'));
const { Recorder, FPS } = await import(path.join(WEB, 'src/recorder.js'));

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((s) => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? 'true']));
const SERVER = args.server ?? 'http://127.0.0.1:8765';
const TASK_ID = args.task ?? 'cup_on_tray';
const N = Number(args.episodes ?? 10);
const MAX_S = Number(args['max-seconds'] ?? 40);
const OUT = args.out ? path.resolve(args.out) : null;
let seed = Number(args.seed ?? 1000) >>> 0; // differs from scripted_demos' default: unseen starts

function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uniform = (lo, hi) => lo + (hi - lo) * rand();

async function call(route, body) {
  const res = await fetch(SERVER + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${route}: ${json.error}`);
  return json;
}

const LEVEL = 'models/kitchen.xml';
const server = http.createServer(async (req, res) => {
  try { res.end(await readFile(path.join(WEB, decodeURIComponent(req.url)))); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const sim = await Sim.create(`http://localhost:${server.address().port}/${LEVEL}`);
server.close();
const teleop = new Teleop(sim); // only for its IK, which the task uses to track the gripper
const task = TASKS.map((T) => new T(sim, teleop.ik)).find((t) => t.id === TASK_ID);
if (!task) throw new Error(`unknown task ${TASK_ID}; one of ${TASKS.map((T) => new T(sim, teleop.ik).id)}`);
const recorder = new Recorder(sim, teleop, { level: LEVEL });
const { model, data } = sim;

const info = await call('/info');
console.log(`policy ${info.policy} on ${info.device}, ${info.chunk} actions per chunk`);

// Same start randomization as scripted_demos.mjs for the cup task; other tasks start
// from the level's keyframe.
function randomizeStart() {
  if (TASK_ID !== 'cup_on_tray') return;
  const adr = sim.qposAdr('cup_free');
  data.qpos[adr] = uniform(0.16, 0.28);
  data.qpos[adr + 1] = uniform(0.05, 0.16);
  sim.mj.mj_forward(model, data);
}

// Actions come back in this order (handover_train/schema.py JOINTS).
const act = info.joints.map((n) => sim.id('ACTUATOR', n));

async function runEpisode() {
  sim.reset();
  randomizeStart();
  teleop.reset();
  task.reset();
  recorder.start(task);
  recorder.noteInput('policy');
  await call('/reset', {});

  const queue = [];
  let latency = 0, calls = 0, nextAction = sim.time;
  const stepsPerFrame = Math.round(1 / 60 / sim.dt);
  while (task.state === 'playing' && sim.time - task.start < MAX_S) {
    for (let s = 0; s < stepsPerFrame; s++) {
      // A new servo target every 1/30 s of sim time, as in the recorded demos.
      if (sim.time + 1e-9 >= nextAction) {
        if (!queue.length) {
          const r = await call('/act', { qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), task: task.instruction, model: LEVEL });
          queue.push(...r.actions);
          latency += r.latency_ms; calls++;
        }
        const a = queue.shift();
        for (let i = 0; i < act.length; i++) data.ctrl[act[i]] = a[i];
        nextAction += 1 / FPS;
      }
      sim.step();
      recorder.update();
    }
    task.update();
  }
  const result = task.state === 'playing' ? { success: false, score: 0, reason: `timed out after ${MAX_S} s` } : task.result;
  const ep = recorder.finish(result, task.events);
  return { ep, result, latency: latency / Math.max(1, calls) };
}

const episodes = [];
let wins = 0;
for (let i = 1; i <= N; i++) {
  const { ep, result, latency } = await runEpisode();
  if (result.success) wins++;
  if (ep) episodes.push(ep);
  console.log(`episode ${i}: ${result.success ? `success, score ${result.score}` : `fail (${result.reason})`}` +
    `, ${(sim.time - task.start).toFixed(1)} s, policy ${latency.toFixed(0)} ms per chunk`);
}
console.log(`${TASK_ID}: ${wins}/${N} successful (${((100 * wins) / N).toFixed(0)}%)`);
if (OUT) {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, gzipSync(episodes.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  console.log(`attempts saved to ${OUT}`);
}
