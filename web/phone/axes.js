// Phone axes page: live sensor readout, what the controller makes of it, and
// calibration of the player's own moves (see calibration.js).

import { Motion } from './motion.js';
import {
  Calibration, STEPS, MIN_ANGLE, relativeRotation, quatFromEvent, describeAxis, report,
} from './calibration.js';

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;

const motion = new Motion();
let q = null, q0 = null, raw = null, accel = null;

// --- Bars -------------------------------------------------------------------

function makeBars(el, rows) {
  el.innerHTML = rows.map((r) => `
    <div class="bar"><div class="head"><span>${r.label}</span><span id="${r.id}v">–</span></div>
    <div class="track"><div class="fill" id="${r.id}f"></div></div>
    <div class="hint">${r.hint}</div></div>`).join('');
}

function setBar(id, value, range, text) {
  const f = $(id + 'f');
  const x = Math.max(-1, Math.min(1, value / range)) * 50;
  f.style.left = `${x < 0 ? 50 + x : 50}%`;
  f.style.width = `${Math.abs(x)}%`;
  $(id + 'v').textContent = text;
}

makeBars($('phoneBars'), [
  { id: 'px', label: 'About x (the right-edge axis)', hint: '+ top edge tips toward the screen side · − toward the back' },
  { id: 'py', label: 'About y (the top-edge axis)', hint: '+ right edge dips toward the back · − toward the screen side' },
  { id: 'pz', label: 'About z (out of the screen)', hint: '+ spins counter-clockwise · − clockwise, seen looking at the screen' },
]);
makeBars($('gripBars'), [
  { id: 'gx', label: 'Gripper right / left', hint: '+ right · − left' },
  { id: 'gy', label: 'Gripper away / toward you', hint: '+ away · − toward you' },
  { id: 'gr', label: 'Wrist roll', hint: '+ clockwise on screen · − counter-clockwise' },
]);

function mappingNote() {
  const c = motion.calibration;
  $('mappingNote').innerHTML = c
    ? `<span class="ok">Using your taught moves.</span> Right = ${describeAxis(c.axes.right)}; away = ${
      describeAxis(c.axes.forward)}; roll = ${describeAxis(c.axes.roll)}.`
    : `<span class="warn">Using the built-in mapping</span> for a phone held ${motion.hold === 'flat' ? 'flat' : 'upright'}: `
      + 'tip the top away to go forward, dip the right side to go right, turn the phone right to roll clockwise. '
      + 'Teach your own moves below if that feels wrong. Tap Zero after changing your hold.';
}

function render() {
  if (raw) {
    $('raw').textContent = `α ${raw.alpha.toFixed(0)} β ${raw.beta.toFixed(0)} γ ${raw.gamma.toFixed(0)} · screen ${raw.screen}°`;
  }
  if (q && q0) {
    const { rv } = relativeRotation(q0, q);
    setBar('px', rv[0] * DEG, 90, `${(rv[0] * DEG).toFixed(0)}°`);
    setBar('py', rv[1] * DEG, 90, `${(rv[1] * DEG).toFixed(0)}°`);
    setBar('pz', rv[2] * DEG, 90, `${(rv[2] * DEG).toFixed(0)}°`);
  }
  if (!motion.held && motion.q) motion.press();
  if (motion.held) {
    setBar('gx', motion.pos.x, 0.3, `${(motion.pos.x * 100).toFixed(0)} cm`);
    setBar('gy', motion.pos.y, 0.3, `${(motion.pos.y * 100).toFixed(0)} cm`);
    setBar('gr', motion.roll * DEG, 90, `${(motion.roll * DEG).toFixed(0)}°`);
  }
  if (accel) $('accel').textContent = `x ${accel.x.toFixed(2)}  y ${accel.y.toFixed(2)}  z ${accel.z.toFixed(2)}`;
  requestAnimationFrame(render);
}

// --- Sensors ----------------------------------------------------------------

function screenAngle() {
  return screen.orientation?.angle ?? window.orientation ?? 0;
}

const samples = []; // raw readings during a calibration move, sent with the result
let recording = false;

window.addEventListener('deviceorientation', (e) => {
  if (e.beta == null) return;
  q = quatFromEvent(e);
  raw = { alpha: e.alpha || 0, beta: e.beta, gamma: e.gamma, screen: screenAngle() };
  if (!q0) zero();
  if (recording && samples.length < 600) samples.push([+(performance.now() / 1000).toFixed(3), raw.alpha, raw.beta, raw.gamma]);
});
window.addEventListener('devicemotion', (e) => {
  const a = e.acceleration;
  if (a && a.x != null) accel = a;
});

function zero() {
  q0 = q;
  motion.press(); // the page keeps "Hold to move" pressed, measured from here
  mappingNote();
}

$('start').addEventListener('click', async () => {
  try {
    await motion.enable(); // asks iPhone for motion access (covers this page's listeners too)
    $('start').hidden = true;
    $('sensorState').textContent = 'Sensors on';
    $('hold').disabled = false;
    setTimeout(() => { if (!q) $('sensorState').textContent = 'No sensor readings: is this the https:// address?'; }, 1500);
    showStep();
  } catch (err) {
    $('sensorState').textContent = err.message;
  }
});
$('zero').addEventListener('click', () => { if (q) zero(); });

// --- Calibration ------------------------------------------------------------

let step = 0;
let results = {};
let start = null;

function showStep(msg = '') {
  $('steps').innerHTML = STEPS.map((s, i) => {
    const r = results[s.id];
    const state = r ? `<span class="ok">✓ ${describeAxis(r.axis)}, ${r.deg}°</span>` : i === step ? '← now' : '';
    return `<li>${s.label} ${state}</li>`;
  }).join('');
  $('hold').textContent = step < STEPS.length ? `Hold, ${STEPS[step].label}, let go` : 'Done';
  $('hold').disabled = step >= STEPS.length || $('start').hidden === false;
  $('calibMsg').innerHTML = msg;
  mappingNote();
}

const hold = $('hold');
let holdPointer = null;
hold.addEventListener('pointerdown', (e) => {
  if (hold.disabled || !q) return;
  e.preventDefault();
  holdPointer = e.pointerId;
  hold.setPointerCapture?.(e.pointerId);
  hold.classList.add('active');
  start = q;
  samples.length = 0;
  recording = true;
});
for (const type of ['pointerup', 'pointercancel']) {
  hold.addEventListener(type, (e) => {
    if (e.pointerId !== holdPointer) return;
    holdPointer = null;
    hold.classList.remove('active');
    recording = false;
    finishMove();
  });
}

function finishMove() {
  const { axis, angle } = relativeRotation(start, q);
  if (angle < MIN_ANGLE) {
    showStep(`<span class="warn">That was only ${(angle * DEG).toFixed(0)}°. Make the move a bit bigger and try again.</span>`);
    return;
  }
  const s = STEPS[step];
  results[s.id] = { axis, deg: Math.round(angle * DEG), samples: samples.slice() };
  step++;
  if (step < STEPS.length) { showStep(); return; }

  const cal = new Calibration({ right: results.right.axis, forward: results.forward.axis, roll: results.roll.axis });
  report('calibration', { valid: cal.valid, results, screen: screenAngle() });
  if (!cal.valid) {
    results = {};
    step = 0;
    showStep('<span class="bad">Two of the moves were too similar to tell apart. Try three clearly different moves.</span>');
    return;
  }
  cal.save();
  motion.calibration = cal;
  zero();
  showStep('<span class="ok">Saved. The controller now uses your moves. Check section 2, then go back to the controller.</span>');
}

$('restart').addEventListener('click', () => { results = {}; step = 0; showStep(); });
$('builtin').addEventListener('click', () => {
  Calibration.clear();
  motion.calibration = null;
  results = {};
  step = 0;
  zero();
  showStep('Back to the built-in mapping.');
});

showStep();
render();
window.handoverAxes = { motion, get q() { return q; } };
