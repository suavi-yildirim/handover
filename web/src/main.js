import { Sim } from './sim.js';
import { Teleop } from './teleop.js';
import { Renderer } from './render.js';
import { Keyboard, KEY_HELP } from './keyboard.js';
import { ROBOT } from './robot.js';
import { PhoneInput, addCommands } from './phone.js';
import { SpaceMouseInput } from './spacemouse.js';
import { TASKS } from './task.js';
import { Recorder, contributorId } from './recorder.js';
import { Sharer } from './upload.js';

const LEVEL = 'models/kitchen.xml';
const MAX_STEPS_PER_FRAME = 50; // don't spiral if a frame takes too long

const $ = (id) => document.getElementById(id);

async function main() {
  const sim = await Sim.create(LEVEL);
  const teleop = new Teleop(sim);
  const view = new Renderer($('view'), sim);
  const tasks = TASKS.map((T) => new T(sim, teleop.ik));
  let task = tasks[Math.min(tasks.length - 1, Math.max(0, Number(load('handover.task')) || 0))];

  const recorder = new Recorder(sim, teleop, { level: LEVEL });
  const sharer = new Sharer(recorder);

  const reset = () => {
    if (recorder.current) sharer.add(recorder.finish({ success: false, reason: 'reset before finishing' }, task.events));
    sim.reset(); teleop.reset(); task.reset();
    recorder.start(task);
    $('result').hidden = true;
    shownState = null;
    showEpisodes(recorder);
  };
  const selectTask = (i) => {
    task = tasks[i];
    save('handover.task', String(i));
    $('task-select').value = String(i);
    $('task-hint').textContent = task.hint;
    window.handover.task = task;
    reset();
  };
  recorder.start(task);
  $('download').addEventListener('click', (e) => { recorder.download(); e.currentTarget.blur(); });
  $('welcome-download').addEventListener('click', () => recorder.download());
  setupShare(sharer);
  const keys = new Keyboard({ onToggleGrip: () => teleop.toggleGrip(), onReset: reset });
  window.addEventListener('keydown', (e) => {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < tasks.length && !e.repeat) selectTask(i);
    if (e.code === 'KeyM' && !e.repeat) setMenu(!drawer.classList.contains('open'));
    if (e.code === 'KeyC' && !e.repeat && view.wrist) view.showWrist = !view.showWrist;
    if (e.code === 'KeyV' && !e.repeat) setLayout(view.layout === 'quad' ? 'single' : 'quad');
  });
  const phone = new PhoneInput({ onGrip: (closed) => teleop.setGrip(closed), getGrip: () => teleop.gripClosed });
  phone.showBadge(document.body, { bottom: 64 });
  const spacemouse = new SpaceMouseInput({ onToggleGrip: () => teleop.toggleGrip() });
  const smButton = $('spacemouse');
  spacemouse.onChange = () => {
    smButton.textContent = spacemouse.connected
      ? `✓ ${spacemouse.name}${spacemouse.fine ? ' · precise' : ''}`
      : 'Connect 3D mouse';
  };
  spacemouse.onChange();
  smButton.hidden = !spacemouse.supported;
  smButton.addEventListener('click', (e) => { spacemouse.connect().catch(console.error); e.currentTarget.blur(); });

  $('task-select').innerHTML = tasks.map((t, i) => `<option value="${i}">${i + 1}. ${t.title}</option>`).join('');
  $('task-select').value = String(tasks.indexOf(task));
  $('task-select').addEventListener('change', (e) => { selectTask(Number(e.target.value)); e.target.blur(); });
  $('task-hint').textContent = task.hint;
  $('help-keys').innerHTML = KEY_HELP.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('');
  $('loading').remove();

  // Side menu (title, task, controls): slides in from the left. M or the button toggles it.
  const drawer = $('drawer'), menuBtn = $('menu-toggle');
  function setMenu(open) {
    drawer.classList.toggle('open', open);
    menuBtn.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.textContent = open ? '✕' : '☰';
    save('handover.menu', open ? 'open' : 'closed');
  }
  menuBtn.addEventListener('click', () => setMenu(!drawer.classList.contains('open')));
  setMenu(load('handover.menu') === 'open');

  // Precision slider: scales every input (keys, phone, 3D mouse), so the arm can be moved slowly.
  const speedSlider = $('speed-slider'), speedOut = $('speed-out');
  let speed = Math.min(1, Math.max(0.2, Number(load('handover.speed')) || 1));
  function setSpeed(s) {
    speed = s;
    speedSlider.value = String(s);
    speedOut.textContent = `${Math.round(s * 100)}%`;
    save('handover.speed', String(s));
  }
  speedSlider.addEventListener('input', () => setSpeed(Number(speedSlider.value)));
  speedSlider.addEventListener('change', () => speedSlider.blur()); // keep keys for driving
  setSpeed(speed);

  // View layout: one 3D view, or four views (top, 3D, front, side). Remembered per browser.
  const viewLabels = $('view-labels');
  function setLayout(layout) {
    view.layout = layout;
    document.body.classList.toggle('quad', layout === 'quad');
    try { localStorage.setItem('handover.layout', layout); } catch {}
    viewLabels.dataset.at = '';
  }
  function placeViewLabels() {
    const { H } = view.size(), vs = view.views(), key = vs.map((v) => `${v.x},${v.y},${v.w}`).join(' ') + H;
    if (viewLabels.dataset.at === key) return;
    viewLabels.dataset.at = key;
    viewLabels.innerHTML = vs.length < 2 ? '' : vs.map((v) =>
      `<div style="left:${v.x + v.w / 2}px;top:${H - v.y - v.h + 8}px">${v.label}</div>`).join('');
  }
  let savedLayout = null;
  try { savedLayout = localStorage.getItem('handover.layout'); } catch {}
  setLayout(savedLayout === 'quad' ? 'quad' : 'single');

  const wristLabel = $('wrist-label');
  function placeWristLabel() {
    wristLabel.hidden = !view.wristVisible;
    const r = view.wristRect(), css = `${r.x + 6}px,${r.top + 4}px`;
    if (wristLabel.dataset.at !== css) {
      wristLabel.dataset.at = css;
      wristLabel.style.left = `${r.x + 6}px`; wristLabel.style.top = `${r.top + 4}px`;
    }
  }

  // Exposed for debugging and automated tests.
  window.handover = { sim, teleop, view, keys, phone, spacemouse, task, recorder, sharer, reset };

  let last = performance.now(), simLag = 0, fps = 0, frames = 0, fpsT = last;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const axes = view.groundAxes();
    const cmd = addCommands(addCommands(keys.command(axes), phone.command(axes, dt)), spacemouse.command(axes));
    teleop.command(scaleCommand(cmd, speed), dt);
    if (keys.active) recorder.noteInput('keyboard');
    if (phone.active) recorder.noteInput('phone');
    if (spacemouse.active) recorder.noteInput('spacemouse');
    teleop.apply(dt);

    simLag += dt;
    let n = 0;
    while (simLag >= sim.dt && n < MAX_STEPS_PER_FRAME) { sim.step(); recorder.update(); simLag -= sim.dt; n++; }
    if (n === MAX_STEPS_PER_FRAME) simLag = 0;

    task.update();
    if (task.state !== 'playing' && recorder.current) {
      sharer.add(recorder.finish(task.result, task.events));
      showEpisodes(recorder);
    }
    view.draw(teleop.target);
    placeWristLabel();
    placeViewLabels();
    showTask(task);

    frames++;
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    const t = teleop.target;
    $('status').textContent =
      `${ROBOT.name} · gripper ${teleop.gripClosed ? 'closed' : 'open'} · ` +
      `target ${t.map((x) => (x * 100).toFixed(1)).join(', ')} cm · ` +
      `tilt ${Math.round((teleop.pitch * 180) / Math.PI)}° · ` +
      (teleop.blocked ? 'out of reach · ' : '') +
      `${fps.toFixed(0)} fps`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

let shownState = null;

function showTask(task) {
  $('task-time').textContent = `${task.time.toFixed(1)} s`;
  $('task-checks').innerHTML = Object.entries(task.checkLabels)
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
  const best = bestScore(task.id, r.score);
  const rows = Object.entries(task.metricLabels).map(([k, label]) =>
    `<tr><td>${label}</td><td><meter min="0" max="1" value="${r.metrics[k]}"></meter></td>` +
    `<td>${Math.round(100 * r.metrics[k])}</td><td class="dim">×${task.weights[k]}</td></tr>`).join('');
  $('result').innerHTML =
    `<h2>Task complete</h2><div class="score">${r.score}<span>/100</span></div>` +
    `<p class="dim">${task.time.toFixed(1)} s · ${r.raw.bumps} bumps · best ${best}</p>` +
    `<table>${rows}</table><p class="dim">Press <kbd>R</kbd> to play again.</p>`;
}

function showEpisodes(recorder) {
  const label = `Download ${recorder.count} episode${recorder.count === 1 ? '' : 's'}`;
  $('download').hidden = recorder.count === 0;
  $('download').textContent = label;
  $('welcome-download').hidden = recorder.count === 0;
  $('welcome-download').textContent = label;
}

// Sharing is opt-in: the consent dialog says what an episode holds, that episodes are
// published under CC-BY-4.0, and how to get them removed. Only after the box is ticked does
// the Sharer send episodes, each one as it finishes. "Not now" sends nothing; Download still
// works. Turning sharing off needs no dialog. See docs/upload.md.
function setupShare(sharer) {
  const button = $('send-episodes'), status = $('share-status'), toast = $('share-toast');
  const dialog = $('send-dialog'), consent = $('send-consent'), go = $('send-go');
  const welcome = $('welcome'), welcomeShare = $('welcome-share');
  let toastTimer = 0;
  function show() {
    button.hidden = false;
    button.disabled = !sharer.available;
    button.textContent = !sharer.available ? 'Sharing isn\'t set up yet'
      : sharer.enabled ? 'Sharing on · click to stop' : 'Share my episodes';
    // The welcome card asks once per page load; it goes away once sharing is on.
    if (sharer.enabled) welcome.hidden = true;
    welcomeShare.disabled = !sharer.available;
    welcomeShare.textContent = !sharer.available ? 'Sharing isn\'t set up yet'
      : sharer.enabled ? 'Sharing is on · thank you!' : 'Share my episodes';
    status.hidden = !sharer.message;
    status.textContent = sharer.message;
    status.classList.toggle('error', sharer.state === 'error');
    if (sharer.message && sharer.state !== 'off') {
      toast.hidden = false;
      toast.textContent = sharer.message;
      toast.classList.toggle('error', sharer.state === 'error');
      clearTimeout(toastTimer);
      if (sharer.state !== 'sending') toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
    }
  }
  sharer.onChange = show;
  show();
  button.addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (sharer.enabled) { sharer.disable(); return; }
    const n = sharer.recorder.count;
    consent.checked = false;
    go.disabled = true;
    $('send-summary').textContent = n ? `Turning it on also sends the ${n} episode${n === 1 ? '' : 's'} ` +
      'you played in this window.' : '';
    $('send-id').textContent = contributorId() ?? '(not available in this browser)';
    dialog.showModal();
  });
  welcomeShare.addEventListener('click', () => {
    if (sharer.enabled) return;
    button.click();
  });
  $('welcome-play').addEventListener('click', () => { welcome.hidden = true; });
  consent.addEventListener('change', () => { go.disabled = !consent.checked; });
  go.addEventListener('click', () => {
    dialog.close();
    sharer.enable();
  });
}

// Best scores and the chosen task are per-browser conveniences; storage may be unavailable.
// Scales a movement command by the precision slider (0.2 = very slow, 1 = full speed).
function scaleCommand(c, s) {
  return { v: c.v.map((x) => x * s), pitchRate: c.pitchRate * s, rollRate: c.rollRate * s };
}

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
function bestScore(taskId, score) {
  const best = Math.max(score, Number(load(`handover.best.${taskId}`)) || 0);
  save(`handover.best.${taskId}`, String(best));
  return best;
}

main().catch((err) => {
  console.error(err);
  $('loading').textContent = `Failed to start: ${err.message}`;
});
