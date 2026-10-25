// Phone controller page: reads the sticks, tilt and Grip button and streams
// them to the game over the server's WebSocket relay.
//
// Message sent ~30 times a second (see web/src/phone.js for the receiver):
//   { t: 'intent', v: 1, seq,
//     move: { x, y, z },        // -1..1; x right, y forward (away from you), z up
//     wrist: { pitch, roll },   // radians since last recenter (absolute, not rates)
//     center,                   // bumps on every recenter
//     tilt,                     // tilt control on?
//     grip,                     // true = closed
//     aim }                     // while "Hold to move" is held, else null:
//                               //   { id, pos: {x, y, z} metres, roll radians }, relative to the press

import { Stick } from './sticks.js';
import { Tilt } from './tilt.js';
import { Motion } from './motion.js';

const SEND_HZ = 30;
const $ = (id) => document.getElementById(id);

const move = new Stick($('moveStick'), { axes: 'xy' });
const lift = new Stick($('liftStick'), { axes: 'y' });
const tilt = new Tilt();
const motion = new Motion();
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let mode = store.get('handover.mode', 'motion');   // 'motion' | 'sticks'
motion.mode = store.get('handover.motionKind', 'aim'); // 'aim' | 'push'
let grip = false;
let seq = 0;
let rtt = null;
let peers = { game: 0, phone: 0 };

// --- UI -------------------------------------------------------------------

function toast(text, ms = 4000) {
  const el = $('msg');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

function setGrip(closed) {
  grip = closed;
  $('grip').classList.toggle('closed', grip);
  $('grip').textContent = grip ? 'Release' : 'Grip';
  navigator.vibrate?.(15);
  send();
}

$('grip').addEventListener('pointerdown', (e) => { e.preventDefault(); setGrip(!grip); });

$('tilt').addEventListener('click', async () => {
  if (tilt.enabled) {
    tilt.disable();
  } else {
    try {
      await tilt.enable();
      setTimeout(() => {
        if (!tilt.available) toast('No tilt readings from this device.');
      }, 1500);
    } catch (err) {
      toast(err.message, 6000);
    }
  }
  $('tilt').textContent = tilt.enabled ? 'Tilt: on' : 'Tilt: off';
  $('tilt').classList.toggle('on', tilt.enabled);
  $('recenter').disabled = !tilt.enabled;
});

// --- Motion mode ----------------------------------------------------------

const KIND_HELP = {
  aim: 'Turn the phone left/right to slide, tip it up/down to reach farther/closer, twist to roll the wrist. Slider = height.',
  push: 'Experimental: move the phone itself and the gripper follows. Short moves work best. Twist to roll the wrist.',
};

function applyMode() {
  const m = mode === 'motion';
  $('mode').textContent = m ? 'Mode: Motion' : 'Mode: Sticks';
  $('kind').hidden = !m;
  $('kind').textContent = motion.mode === 'aim' ? 'Style: Aim' : 'Style: Push β';
  $('tilt').hidden = $('recenter').hidden = m;
  $('clutch').hidden = !m;
  $('moveStick').hidden = m;
  $('clutchHelp').textContent = KIND_HELP[motion.mode];
}

async function ensureMotion() {
  if (motion.enabled) return true;
  try {
    await motion.enable();
    return true;
  } catch (err) {
    toast(err.message, 6000);
    return false;
  }
}

$('mode').addEventListener('click', async () => {
  mode = mode === 'motion' ? 'sticks' : 'motion';
  store.set('handover.mode', mode);
  if (mode === 'motion') {
    if (tilt.enabled) $('tilt').click();
    await ensureMotion();
  }
  applyMode();
});

$('kind').addEventListener('click', () => {
  motion.mode = motion.mode === 'aim' ? 'push' : 'aim';
  store.set('handover.motionKind', motion.mode);
  applyMode();
});

const clutchEl = $('clutch');
let clutchPointer = null;
clutchEl.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (clutchPointer !== null) return;
  clutchPointer = e.pointerId;
  clutchEl.setPointerCapture?.(e.pointerId);
  if (!(await ensureMotion())) { clutchPointer = null; return; }
  if (clutchPointer === null) return; // let go while the permission prompt was up
  if (!motion.press()) {
    toast('Waiting for motion sensor readings. Try again in a second.');
    clutchPointer = null;
    return;
  }
  clutchEl.classList.add('active');
  navigator.vibrate?.(10);
  send();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  clutchEl.addEventListener(type, (e) => {
    if (e.pointerId !== clutchPointer) return;
    clutchPointer = null;
    motion.release();
    clutchEl.classList.remove('active');
    send();
  });
}

$('recenter').addEventListener('click', () => { tilt.recenter(); navigator.vibrate?.(10); });

function renderStatus() {
  const s = ws && ws.readyState === WebSocket.OPEN;
  const dot = $('dot');
  dot.className = 'dot' + (s ? (peers.game ? ' ok' : ' wait') : '');
  $('status').textContent = !s ? 'Connecting…'
    : !peers.game ? 'Connected, open the game on your Mac'
    : rtt == null ? 'Game connected' : `Game connected · ${Math.round(rtt)} ms`;
  const deg = (r) => `${Math.round(r * 180 / Math.PI)}°`.padStart(4);
  const cm = (m) => `${Math.round(m * 100)}`.padStart(3);
  $('readout').textContent = motion.held
    ? `x${cm(motion.pos.x)} y${cm(motion.pos.y)} z${cm(motion.pos.z)} cm roll ${deg(motion.roll)}`
    : tilt.enabled ? `pitch ${deg(tilt.pitch)} roll ${deg(tilt.roll)}` : '';
}

// Keep the screen awake while controlling.
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  else {
    // Stop the arm when the phone locks or switches apps.
    if (motion.held) { clutchPointer = null; motion.release(); clutchEl.classList.remove('active'); }
    send(true);
  }
});
keepAwake();

// --- Connection -----------------------------------------------------------

let ws = null;
let retry = 500;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=phone`);
  ws.onopen = () => { retry = 500; renderStatus(); };
  ws.onclose = () => {
    peers.game = 0;
    rtt = null;
    renderStatus();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 4000);
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'peers') { peers = m; if (!peers.game) rtt = null; }
    else if (m.t === 'pong') rtt = rtt == null ? performance.now() - m.ts : 0.8 * rtt + 0.2 * (performance.now() - m.ts);
    else if (m.t === 'vibrate') navigator.vibrate?.(m.ms || 30);
    else if (m.t === 'grip') { grip = !!m.closed; $('grip').classList.toggle('closed', grip); $('grip').textContent = grip ? 'Release' : 'Grip'; }
    renderStatus();
  };
}

function send(stop = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const hidden = stop || document.visibilityState !== 'visible';
  ws.send(JSON.stringify({
    t: 'intent', v: 1, seq: ++seq,
    move: hidden ? { x: 0, y: 0, z: 0 } : { x: move.x, y: move.y, z: lift.y },
    wrist: { pitch: tilt.enabled ? tilt.pitch : 0, roll: tilt.enabled ? tilt.roll : 0 },
    center: tilt.centerId,
    tilt: tilt.enabled && !hidden,
    grip,
    aim: motion.held && !hidden ? { id: motion.clutch, pos: motion.pos, roll: motion.roll } : null,
  }));
}

setInterval(send, 1000 / SEND_HZ);
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
}, 1000);
setInterval(renderStatus, 200);

if (!window.isSecureContext) {
  toast('Opened over http: sticks work, but tilt needs the https:// address.', 6000);
}
applyMode();
connect();

// Debug handle for tests.
window.handoverPhone = { move, lift, tilt, motion, setGrip, get ws() { return ws; } };
