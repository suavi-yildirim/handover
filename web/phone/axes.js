// Phone setup page: the player does six moves once (roll, pitch, yaw turns and
// right, forward, up slides) and the controller learns them (calibration.js).
// The controller page sends players here until this is done.

import { Motion } from './motion.js';
import {
  Calibration, STEPS, MIN_ANGLE, MIN_SPEED, relativeRotation, quatFromEvent, slideDirection, describe, report,
} from './calibration.js';

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;

const motion = new Motion();
let q = null;

// --- Sensors ------------------------------------------------------------------

let recording = null; // { start quaternion, raw orientation samples, acceleration samples }
window.addEventListener('deviceorientation', (e) => {
  if (e.beta == null) return;
  q = quatFromEvent(e);
  if (recording && recording.orient.length < 600) {
    recording.orient.push([+(performance.now() / 1000).toFixed(3), e.alpha || 0, e.beta, e.gamma]);
  }
});
window.addEventListener('devicemotion', (e) => {
  const a = e.acceleration;
  if (!recording || !a || a.x == null || recording.accel.length >= 1200) return;
  const dt = Math.min(0.05, e.interval > 1 ? e.interval / 1000 : e.interval || 1 / 60);
  recording.accel.push([dt, a.x, a.y, a.z]);
});

$('start').addEventListener('click', async () => {
  try {
    await motion.enable(); // asks iPhone for motion access, which covers this page too
    $('sensorState').textContent = 'Sensors on';
    $('intro').hidden = true;
    $('wizard').hidden = false;
    setTimeout(() => { if (!q) $('stepMsg').innerHTML = '<span class="bad">No sensor readings. Is this the https:// address?</span>'; }, 1500);
    showStep();
  } catch (err) {
    $('sensorState').textContent = err.message;
  }
});

// --- Wizard -------------------------------------------------------------------

let step = 0;
let results = {};

function showStep(msg = '') {
  const s = STEPS[step];
  $('stepCount').textContent = `Move ${step + 1} of ${STEPS.length} · ${s.kind === 'turn' ? 'turn' : 'slide'}`;
  $('progress').innerHTML = STEPS.map((_, i) => `<span class="${i < step ? 'done' : i === step ? 'now' : ''}"></span>`).join('');
  $('stepTitle').textContent = `${s.title}: ${s.label}`;
  $('stepHint').textContent = s.hint;
  $('hold').textContent = 'Hold, do the move, let go';
  $('redo').disabled = step === 0;
  $('stepMsg').innerHTML = msg;
  $('learned').innerHTML = STEPS.filter((t) => results[t.id])
    .map((t) => `<li class="ok">✓ <b>${t.title}</b>: ${describe(t.kind, results[t.id].axis)}</li>`).join('');
}

const hold = $('hold');
let holdPointer = null;
hold.addEventListener('pointerdown', (e) => {
  if (!q) return;
  e.preventDefault();
  holdPointer = e.pointerId;
  hold.setPointerCapture?.(e.pointerId);
  hold.classList.add('active');
  hold.textContent = 'Now do the move…';
  recording = { start: q, orient: [], accel: [] };
  navigator.vibrate?.(10);
});
for (const type of ['pointerup', 'pointercancel']) {
  hold.addEventListener(type, (e) => {
    if (e.pointerId !== holdPointer) return;
    holdPointer = null;
    hold.classList.remove('active');
    const rec = recording;
    recording = null;
    finishMove(rec);
  });
}

function finishMove(rec) {
  const s = STEPS[step];
  let result;
  if (s.kind === 'turn') {
    const { axis, angle } = relativeRotation(rec.start, q);
    if (angle < MIN_ANGLE) {
      showStep(`<span class="warn">Only ${(angle * DEG).toFixed(0)}° of turn. Make it bigger (20–40°) and try again.</span>`);
      return;
    }
    result = { axis, deg: Math.round(angle * DEG) };
  } else {
    const { axis, speed } = slideDirection(rec.accel);
    if (speed < MIN_SPEED) {
      showStep(rec.accel.length
        ? '<span class="warn">That was too gentle to measure. Move the phone a bit faster, about 20 cm, then stop.</span>'
        : '<span class="bad">No acceleration readings from this phone.</span>');
      return;
    }
    result = { axis, peakSpeed: +speed.toFixed(2) };
  }
  results[s.id] = { ...result, orient: rec.orient, accel: rec.accel.slice(0, 400) };
  navigator.vibrate?.(20);
  step++;
  if (step < STEPS.length) { showStep(); return; }
  finishAll();
}

function finishAll() {
  const axes = Object.fromEntries(STEPS.map((s) => [s.id, results[s.id].axis]));
  const cal = new Calibration(axes);
  report('calibration', { valid: cal.valid, results });
  if (!cal.valid) {
    const turnsOk = !!cal.turnInv;
    results = {};
    step = 0;
    showStep(`<span class="bad">Two of the ${turnsOk ? 'slides' : 'turns'} were too similar to tell apart. `
      + 'Let’s do it again with clearly different moves.</span>');
    return;
  }
  cal.save();
  motion.calibration = cal;
  $('wizard').hidden = true;
  $('done').hidden = false;
}

$('redo').addEventListener('click', () => {
  if (step === 0) return;
  step--;
  delete results[STEPS[step].id];
  showStep();
});
$('again').addEventListener('click', () => {
  results = {};
  step = 0;
  $('done').hidden = true;
  $('wizard').hidden = false;
  showStep();
});
$('go').addEventListener('click', () => { location.href = './'; });

// --- Try it -------------------------------------------------------------------

const BARS = [
  { id: 'roll', label: 'Wrist roll', unit: '°', range: 90, get: () => motion.roll * DEG },
  { id: 'pitch', label: 'Wrist pitch (+ down)', unit: '°', range: 90, get: () => motion.pitch * DEG },
  { id: 'x', label: 'Right / left', unit: ' cm', range: 20, get: () => motion.pos.x * 100 },
  { id: 'y', label: 'Away / toward you', unit: ' cm', range: 20, get: () => motion.pos.y * 100 },
  { id: 'z', label: 'Up / down', unit: ' cm', range: 20, get: () => motion.pos.z * 100 },
];
$('bars').innerHTML = BARS.map((b) => `
  <div class="bar"><div class="head"><span>${b.label}</span><span id="${b.id}v">0${b.unit}</span></div>
  <div class="track"><div class="fill" id="${b.id}f"></div></div></div>`).join('');

function renderBars() {
  if (!$('done').hidden) {
    for (const b of BARS) {
      const v = motion.held ? b.get() : 0;
      const x = Math.max(-1, Math.min(1, v / b.range)) * 50;
      $(b.id + 'f').style.left = `${x < 0 ? 50 + x : 50}%`;
      $(b.id + 'f').style.width = `${Math.abs(x)}%`;
      $(b.id + 'v').textContent = `${v.toFixed(0)}${b.unit}`;
    }
  }
  requestAnimationFrame(renderBars);
}
renderBars();

const tryHold = $('tryHold');
tryHold.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tryHold.setPointerCapture?.(e.pointerId);
  if (motion.press()) tryHold.classList.add('active');
});
for (const type of ['pointerup', 'pointercancel']) {
  tryHold.addEventListener(type, () => { motion.release(); tryHold.classList.remove('active'); });
}

if (Calibration.load()) $('back').textContent = '← Controller';
showStep();
window.handoverSetup = { motion, get step() { return step; } };
