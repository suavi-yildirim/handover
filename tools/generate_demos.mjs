// Generates automatic demos: for each seed, a randomized kitchen scene and a planner
// run of one task. Failed episodes are dropped. Runs headless on the Mac (no GPU).
//   node tools/generate_demos.mjs --tasks cup_on_tray,bring_medication,tidy_fall_hazard \
//        --count 100 --seed 1 --out demos.jsonl.gz
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { loadSim, WEB } from './headless.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const taskIds = (args.tasks || 'cup_on_tray,bring_medication,tidy_fall_hazard').split(',');
const count = Number(args.count || 10), seed0 = Number(args.seed || 1), out = args.out || 'demos.jsonl.gz';
const minScore = Number(args['min-score'] || 0);

const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { TASKS } = await import(path.join(WEB, 'src/task.js'));
const { Recorder } = await import(path.join(WEB, 'src/recorder.js'));
const { Planner } = await import(path.join(WEB, 'src/planner.js'));
const { sampleScene, resetScene, jitterScene } = await import(path.join(WEB, 'src/scene.js'));

const sim = await loadSim();
const teleop = new Teleop(sim);
const tasks = Object.fromEntries(TASKS.map((T) => new T(sim, teleop.ik)).map((t) => [t.id, t]));
const recorder = new Recorder(sim, teleop, { level: 'models/kitchen.xml' });

const FRAME = 1 / 60, MAX_SECONDS = 90;
const stats = {};
const gz = createGzip();
gz.pipe(createWriteStream(out));
let kept = 0;

for (let i = 0; i < count; i++) {
  for (const id of taskIds) {
    const seed = seed0 + i, task = tasks[id], stat = (stats[id] ??= { tried: 0, unreachable: 0, failed: 0, kept: 0, scores: [] });
    stat.tried++;
    // Layout from the seed, then a small move as on every reset in the game.
    const scene = jitterScene(sampleScene(seed), seed * 7919 + 1);
    resetScene(sim, scene);
    teleop.reset(); task.reset();
    const planner = new Planner(sim, teleop, task, { seed });
    if (!planner.reachable()) { stat.unreachable++; continue; }
    recorder.start(task, { scene, source: 'planner' });
    recorder.noteInput('planner');
    let lag = 0;
    for (let t = 0; t < MAX_SECONDS && task.state === 'playing' && planner.state === 'running'; t += FRAME) {
      planner.update(FRAME);
      teleop.apply(FRAME);
      for (lag += FRAME; lag >= sim.dt; lag -= sim.dt) { sim.step(); recorder.update(); }
      task.update();
    }
    const result = task.state === 'playing' ? { success: false, score: 0, reason: planner.reason || 'timed out' } : task.result;
    const ep = recorder.finish(result, task.events);
    if (!ep || !ep.success || ep.score < minScore) { stat.failed++; stat.lastFailure = `seed ${seed}: ${result.reason}`; continue; }
    ep.planner = { speed: planner.speed, retries: planner.retries };
    gz.write(JSON.stringify(ep) + '\n');
    stat.kept++; stat.scores.push(ep.score); kept++;
  }
}
gz.end();
for (const [id, s] of Object.entries(stats)) {
  const mean = s.scores.length ? (s.scores.reduce((a, b) => a + b, 0) / s.scores.length).toFixed(1) : '-';
  console.log(`${id}: kept ${s.kept}/${s.tried} (unreachable ${s.unreachable}, failed ${s.failed}), mean score ${mean}${s.lastFailure ? `, last failure ${s.lastFailure}` : ''}`);
}
console.log(`wrote ${kept} episodes to ${out}`);
