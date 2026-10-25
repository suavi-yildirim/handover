// Phone controller page: reads the sticks, tilt and Grip button and streams
// them to the game over the server's WebSocket relay.
//
// Message sent ~30 times a second (see web/src/phone.js for the receiver):
//   { t: 'intent', v: 1, seq,
//     move: { x, y, z },        // -1..1; x right, y forward (away from you), z up
//     wrist: { pitch, roll },   // radians since last recenter (absolute, not rates)
//     center,                   // bumps on every recenter
//     tilt,                     // tilt control on?
//     grip }                    // true = closed

import { Stick } from './sticks.js';
import { Tilt } from './tilt.js';

const SEND_HZ = 30;
const $ = (id) => document.getElementById(id);

const move = new Stick($('moveStick'), { axes: 'xy' });
const lift = new Stick($('liftStick'), { axes: 'y' });
const tilt = new Tilt();
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

$('recenter').addEventListener('click', () => { tilt.recenter(); navigator.vibrate?.(10); });

function renderStatus() {
  const s = ws && ws.readyState === WebSocket.OPEN;
  const dot = $('dot');
  dot.className = 'dot' + (s ? (peers.game ? ' ok' : ' wait') : '');
  $('status').textContent = !s ? 'Connecting…'
    : !peers.game ? 'Connected, open the game on your Mac'
    : rtt == null ? 'Game connected' : `Game connected · ${Math.round(rtt)} ms`;
  const deg = (r) => `${Math.round(r * 180 / Math.PI)}°`.padStart(4);
  $('readout').textContent = tilt.enabled ? `pitch ${deg(tilt.pitch)} roll ${deg(tilt.roll)}` : '';
}

// Keep the screen awake while controlling.
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  else send(true); // stop the arm when the phone locks or switches apps
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
connect();

// Debug handle for tests.
window.handoverPhone = { move, lift, tilt, setGrip, get ws() { return ws; } };
