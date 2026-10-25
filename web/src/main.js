import { Sim } from './sim.js';
import { Teleop } from './teleop.js';
import { Renderer } from './render.js';
import { Keyboard, KEY_HELP } from './keyboard.js';
import { ROBOT } from './robot.js';
import { CupOnTrayTask, WEIGHTS } from './task.js';

const LEVEL = 'models/kitchen.xml';
const MAX_STEPS_PER_FRAME = 50; // don't spiral if a frame takes too long

const $ = (id) => document.getElementById(id);

async function main() {
  const sim = await Sim.create(LEVEL);
  const teleop = new Teleop(sim);
  const view = new Renderer($('view'), sim);
  const task = new CupOnTrayTask(sim, teleop.ik);

  const reset = () => { sim.reset(); teleop.reset(); task.reset(); $('result').hidden = true; };
  const keys = new Keyboard({ onToggleGrip: () => teleop.toggleGrip(), onReset: reset });

  $('task-title').textContent = task.title;
  $('task-hint').textContent = task.hint;
  $('help').innerHTML = KEY_HELP.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('');
  $('loading').remove();

  // Exposed for debugging and automated tests.
  window.handover = { sim, teleop, view, keys, task, reset };

  let last = performance.now(), simLag = 0, fps = 0, frames = 0, fpsT = last;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    teleop.command(keys.command(view.groundAxes()), dt);
    teleop.apply(dt);

    simLag += dt;
    let n = 0;
    while (simLag >= sim.dt && n < MAX_STEPS_PER_FRAME) { sim.step(); simLag -= sim.dt; n++; }
    if (n === MAX_STEPS_PER_FRAME) simLag = 0;

    task.update();
    view.draw(teleop.target);
    showTask(task);

    frames++;
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    const t = teleop.target;
    $('status').textContent =
      `${ROBOT.name} · gripper ${teleop.gripClosed ? 'closed' : 'open'} · ` +
      `target ${t.map((x) => (x * 100).toFixed(1)).join(', ')} cm · ` +
      `tilt ${Math.round((teleop.pitch * 180) / Math.PI)}° · ` +
      (teleop.ikError > 0.01 ? 'out of reach · ' : '') +
      `${fps.toFixed(0)} fps`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const CHECK_LABELS = { onTray: 'Cup on the tray', upright: 'Upright', released: 'Gripper let go', settled: 'Resting still' };
const METRIC_LABELS = { time: 'Speed', smoothness: 'Smooth motion', gentleness: 'No bumps', spill: 'Kept level', drops: 'No drops' };
let shownState = null;

function showTask(task) {
  $('task-time').textContent = `${task.time.toFixed(1)} s`;
  $('task-checks').innerHTML = Object.entries(CHECK_LABELS)
    .map(([k, label]) => `<li class="${task.checks[k] ? 'ok' : ''}">${label}</li>`).join('');
  if (task.state === shownState) return;
  shownState = task.state;
  if (task.state === 'playing') return;
  const r = task.result;
  $('result').hidden = false;
  if (!r.success) {
    $('result').innerHTML = `<h2>Try again</h2><p>${r.reason}</p><p class="dim">Press <kbd>R</kbd> to reset.</p>`;
    return;
  }
  const best = bestScore(r.score);
  const rows = Object.entries(METRIC_LABELS).map(([k, label]) =>
    `<tr><td>${label}</td><td><meter min="0" max="1" value="${r.metrics[k]}"></meter></td>` +
    `<td>${Math.round(100 * r.metrics[k])}</td><td class="dim">×${WEIGHTS[k]}</td></tr>`).join('');
  $('result').innerHTML =
    `<h2>Task complete</h2><div class="score">${r.score}<span>/100</span></div>` +
    `<p class="dim">${task.time.toFixed(1)} s · ${r.raw.bumps} bumps · max tilt ${r.raw.maxCarryTiltDeg.toFixed(0)}°` +
    ` · best ${best}</p><table>${rows}</table><p class="dim">Press <kbd>R</kbd> to play again.</p>`;
}

// Best score is a per-browser convenience; storage may be unavailable.
function bestScore(score) {
  let best = score;
  try {
    best = Math.max(score, Number(localStorage.getItem('handover.best.cupOnTray')) || 0);
    localStorage.setItem('handover.best.cupOnTray', String(best));
  } catch { /* ignore */ }
  return best;
}

main().catch((err) => {
  console.error(err);
  $('loading').textContent = `Failed to start: ${err.message}`;
});
