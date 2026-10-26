// Scene randomization and the automatic planner, headless.   node tests/scene_check.mjs [episode-out.jsonl]
//  - the standard layout, applied as a scene, equals the keyframe layout
//  - a seed always gives the same scene, and applying scenes never accumulates
//  - the planner finishes every task in random scenes, in a reasonable time, with a good score
//  - episodes carry the scene, the seed and who drove
import path from 'node:path';
import { loadSim, WEB } from '../tools/headless.mjs';

const { Teleop } = await import(path.join(WEB, 'src/teleop.js'));
const { TASKS } = await import(path.join(WEB, 'src/task.js'));
const { Recorder } = await import(path.join(WEB, 'src/recorder.js'));
const { Planner } = await import(path.join(WEB, 'src/planner.js'));
const { sampleScene, defaultScene, applyScene, resetScene, jitterScene, JITTER } = await import(path.join(WEB, 'src/scene.js'));

const sim = await loadSim();
const teleop = new Teleop(sim);
const tasks = TASKS.map((T) => new T(sim, teleop.ik));
const recorder = new Recorder(sim, teleop, { level: 'models/kitchen.xml' });
const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// Standard layout through applyScene == the keyframe.
sim.reset();
const keyframe = Array.from(sim.data.qpos);
resetScene(sim, defaultScene());
check('standard scene matches the keyframe', keyframe.every((q, i) => Math.abs(q - sim.data.qpos[i]) < 1e-6));

// Determinism and no accumulation.
check('same seed, same scene', JSON.stringify(sampleScene(7)) === JSON.stringify(sampleScene(7)));
check('different seeds differ', JSON.stringify(sampleScene(7)) !== JSON.stringify(sampleScene(8)));
const mass = (n) => sim.model.body_mass[sim.id('BODY', n)];
const scene = sampleScene(3);
resetScene(sim, scene); const m1 = mass('cup');
resetScene(sim, sampleScene(4)); resetScene(sim, scene);
check('applying scenes does not accumulate', Math.abs(mass('cup') - m1) < 1e-12);
resetScene(sim, null);
check('standard scene restores mass', Math.abs(mass('cup') - 0.073) < 1e-9);

// Jitter on reset: small, repeatable, and it records the layout it came from.
const layout = sampleScene(11);
const j1 = jitterScene(layout, 5), j2 = jitterScene(layout, 5);
check('same jitter seed, same move', JSON.stringify(j1) === JSON.stringify(j2));
check('jitter moves the scene', JSON.stringify(j1.objects) !== JSON.stringify(layout.objects));
const moves = ['cup', 'pill_bottle', 'glasses_case'].map((n) => Math.hypot(j1.objects[n].x - layout.objects[n].x, j1.objects[n].y - layout.objects[n].y));
check(`jitter stays within ${JITTER * 100} cm (largest ${(Math.max(...moves) * 100).toFixed(2)} cm)`, Math.max(...moves) <= JITTER + 1e-3);
check('jitter records layout and jitter seeds', j1.layout_seed === 11 && j1.jitter_seed === 5 && j1.seed === 11);
check('jitter does not change the layout it came from', JSON.stringify(layout) === JSON.stringify(sampleScene(11)));

// Planner in random scenes: every task, a few seeds.
const FRAME = 1 / 60;
let ok = 0, total = 0, worst = 100, slowest = 0;
const SEEDS = [1, 2, 3, 4, 5];
for (const task of tasks) {
  for (const seed of SEEDS) {
    total++;
    const sc = sampleScene(seed);
    resetScene(sim, sc); teleop.reset(); task.reset();
    const planner = new Planner(sim, teleop, task, { seed });
    if (!planner.reachable()) { console.log(`unreachable: ${task.id} seed ${seed}`); continue; }
    recorder.start(task, { scene: sc, source: 'planner' });
    let lag = 0;
    for (let t = 0; t < 90 && task.state === 'playing' && planner.state === 'running'; t += FRAME) {
      planner.update(FRAME); teleop.apply(FRAME);
      for (lag += FRAME; lag >= sim.dt; lag -= sim.dt) { sim.step(); recorder.update(); }
      task.update();
    }
    const ep = recorder.finish(task.result ?? { success: false, reason: planner.reason }, task.events);
    if (ep?.success) { ok++; worst = Math.min(worst, ep.score); slowest = Math.max(slowest, task.time); }
    else console.log(`failed: ${task.id} seed ${seed}: ${planner.reason ?? task.result?.reason}`);
  }
}
check(`planner succeeds in ${total} random scenes (got ${ok})`, ok === total);
check(`planner scores at least 80 (worst ${worst})`, worst >= 80);
check(`planner finishes within 30 s of sim time (slowest ${slowest.toFixed(1)} s)`, slowest <= 30);
const last = recorder.episodes.at(-1);
check('episode records scene, seed and source', last.scene?.seed === SEEDS.at(-1) && last.scene_seed === SEEDS.at(-1) && last.source === 'planner');
check('standard-layout episode has scene null', (() => { recorder.start(tasks[0]); const e = recorder.current; recorder.current = null; return e.scene === null && e.scene_seed === null && e.source === 'human'; })());

if (process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(last) + '\n');
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
