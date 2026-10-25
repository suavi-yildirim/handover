// Phone control, game side.
//
// Receives the phone controller's stream (web/phone/) through the server's
// WebSocket relay (tools/phone_server.py) and turns it into the same command
// the keyboard produces, so main.js can add the two together:
//
//   const phone = new PhoneInput({
//     onGrip: (closed) => teleop.setGrip(closed),   // phone pressed Grip
//     getGrip: () => teleop.gripClosed,             // keeps the phone's button in sync
//   });
//   const cmd = addCommands(keys.command(axes), phone.command(axes, dt));
//
// The joystick is camera-relative like the keyboard. Tilt is absolute on the
// phone (wrist follows how far you tilted since Recenter), so here it is
// turned into pitch/roll rates that servo the wrist toward that angle.
//
// If the page is served without the phone server (e.g. python3 -m http.server)
// this quietly retries and command() returns zeros.

const DEFAULTS = {
  speed: 0.15,       // m/s at full stick, matches the keyboard
  pitchRate: 1.2,    // rad/s cap, matches the keyboard
  rollRate: 2.0,     // rad/s cap, matches the keyboard
  wristGain: 6,      // 1/s, how hard the wrist servos toward the phone's tilt
  aimSpeed: 0.3,     // m/s cap when moving the phone itself (motion mode)
  aimGain: 8,        // 1/s, how hard the gripper servos toward where the phone says
  staleMs: 250,      // no message for this long -> stop moving (phone locked, Wi-Fi hiccup)
};

const ZERO = { move: { x: 0, y: 0, z: 0 }, wrist: { pitch: 0, roll: 0 }, tilt: false, grip: false, center: 0, aim: null };

const clamp = (v, m) => Math.max(-m, Math.min(m, v));

export function addCommands(a, b) {
  return {
    v: [a.v[0] + b.v[0], a.v[1] + b.v[1], a.v[2] + b.v[2]],
    pitchRate: (a.pitchRate || 0) + (b.pitchRate || 0),
    rollRate: (a.rollRate || 0) + (b.rollRate || 0),
  };
}

export class PhoneInput {
  constructor({ url = null, onGrip = null, getGrip = null, onConnect = null, ...opts } = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.onGrip = onGrip;
    this.getGrip = getGrip;
    this.onConnect = onConnect;
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=game`;
    this.intent = ZERO;
    this.lastAt = 0;
    this.grip = null;          // grip state as last agreed with the phone
    this._phoneGrip = null;    // grip value in the phone's previous message
    this.phones = 0;
    this.applied = { pitch: 0, roll: 0, center: null };
    this.aimApplied = { id: null, x: 0, y: 0, z: 0, roll: 0 };
    this.ws = null;
    this._retry = 1000;
    this._listeners = new Set();
    this._connect();
  }

  get connected() { return this.phones > 0; }

  // Is the phone currently steering (fresh message, stick or tilt in use)?
  get active() {
    if (!this.connected || performance.now() - this.lastAt > this.opts.staleMs) return false;
    const { move, tilt, aim } = this.intent;
    return tilt || !!aim || move.x !== 0 || move.y !== 0 || move.z !== 0;
  }

  // Same shape as Keyboard.command(axes): { v: [vx, vy, vz] m/s world, pitchRate, rollRate }.
  // axes = view.groundAxes() = { forward: [x, y], right: [x, y] }.
  command(axes, dt = 1 / 60) {
    const o = this.opts;
    if (this.getGrip && this.connected) {
      const g = !!this.getGrip();
      if (g !== this.grip) this.syncGrip(g); // changed by keyboard or reset
    }
    const fresh = this.connected && performance.now() - this.lastAt <= o.staleMs;
    const { move, wrist, tilt, center, aim } = fresh ? this.intent : ZERO;
    const f = axes?.forward || [1, 0];
    const r = axes?.right || [0, -1];
    const v = [
      (f[0] * move.y + r[0] * move.x) * o.speed,
      (f[1] * move.y + r[1] * move.x) * o.speed,
      move.z * o.speed,
    ];

    let pitchRate = 0, rollRate = 0;
    const a = this.applied;
    if (!fresh || !tilt || a.center !== center) {
      // New neutral pose (or tilt off): whatever the wrist is now becomes zero.
      a.pitch = wrist.pitch;
      a.roll = wrist.roll;
      a.center = center;
    } else {
      pitchRate = clamp(o.wristGain * (wrist.pitch - a.pitch), o.pitchRate);
      rollRate = clamp(o.wristGain * (wrist.roll - a.roll), o.rollRate);
      a.pitch += pitchRate * dt;
      a.roll += rollRate * dt;
    }

    // Motion mode: the phone reports how far the gripper should have moved since
    // "Hold to move" was pressed; servo toward that, like the wrist above.
    const m = this.aimApplied;
    if (!aim) {
      m.id = null;
    } else if (m.id !== aim.id) {
      Object.assign(m, { id: aim.id, x: 0, y: 0, z: 0, roll: 0 });
    } else {
      let d = [aim.pos.x - m.x, aim.pos.y - m.y, aim.pos.z - m.z].map((e) => e * o.aimGain);
      const n = Math.hypot(...d);
      if (n > o.aimSpeed) d = d.map((e) => e * o.aimSpeed / n);
      m.x += d[0] * dt;
      m.y += d[1] * dt;
      m.z += d[2] * dt;
      v[0] += f[0] * d[1] + r[0] * d[0];
      v[1] += f[1] * d[1] + r[1] * d[0];
      v[2] += d[2];
      const rr = clamp(o.wristGain * (aim.roll - m.roll), o.rollRate);
      m.roll += rr * dt;
      rollRate += rr;
    }
    return { v, pitchRate, rollRate };
  }

  // Tell the phone the grip state (e.g. after Space on the keyboard) so its button matches.
  syncGrip(closed) {
    this.grip = !!closed;
    this._send({ t: 'grip', closed: this.grip });
  }

  vibrate(ms = 30) {
    this._send({ t: 'vibrate', ms });
  }

  // Listen for 'change' (any phone message) and 'peers' (phone count changed).
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(type) { for (const fn of this._listeners) fn(type, this); }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  _connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch { return; }
    this.ws = ws;
    ws.onopen = () => { this._retry = 1000; };
    ws.onclose = () => {
      const had = this.phones;
      this.phones = 0;
      this.grip = this._phoneGrip = null;
      if (had) this._emit('peers');
      setTimeout(() => this._connect(), this._retry);
      this._retry = Math.min(this._retry * 2, 10000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'intent') {
        this.intent = { ...ZERO, ...m };
        this.lastAt = performance.now();
        // Act on presses only (a change from the phone's previous message), so a
        // message sent before the phone heard about a keyboard grip can't undo it.
        if (typeof m.grip === 'boolean') {
          if (this._phoneGrip !== null && m.grip !== this._phoneGrip) {
            this.grip = m.grip;
            this.onGrip?.(m.grip);
          }
          this._phoneGrip = m.grip;
        }
        this._emit('change');
      } else if (m.t === 'ping') {
        this._send({ t: 'pong', ts: m.ts });
      } else if (m.t === 'peers') {
        const was = this.phones;
        this.phones = m.phone || 0;
        if (this.phones && !was) {
          this.onConnect?.(this);
          // Phone joined: tell it the current grip so its button starts right.
          if (this.grip !== null) this.syncGrip(this.grip);
        }
        if (!this.phones) this.grip = this._phoneGrip = null;
        this._emit('peers');
      }
    };
  }

  // Small corner card: QR code + address to open on the phone, then live status.
  async showBadge(parent = document.body, { right = 16, bottom = 16 } = {}) {
    const el = document.createElement('div');
    el.className = 'phone-badge';
    el.style.cssText = `position:fixed;right:${right}px;bottom:${bottom}px;z-index:20;`
      + 'background:rgba(20,23,28,.92);'
      + 'color:#e8ecf1;border:1px solid #333a45;border-radius:12px;padding:10px 12px;'
      + 'font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:220px;';
    // Small screens (the game itself opened on a phone): the task panel needs the space.
    if (matchMedia('(max-width: 600px)').matches) el.style.display = 'none';
    parent.appendChild(el);

    let info = null;
    try {
      const res = await fetch('/__phone/info', { cache: 'no-store' });
      if (res.ok) info = await res.json();
    } catch { /* plain static server */ }

    let qrSvg = '';
    if (info?.phone_url) {
      try {
        const { default: qrcode } = await import('../vendor/qrcode/qrcode.js');
        const qr = qrcode(0, 'M');
        qr.addData(info.phone_url);
        qr.make();
        qrSvg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch { /* show the URL only */ }
    }

    const render = () => {
      if (!info) {
        el.innerHTML = 'Phone control: start the game with<br><code>python3 tools/phone_server.py</code>';
      } else if (this.connected) {
        el.innerHTML = `<b style="color:#3ecf8e">● Phone connected</b><br>`
          + `<span style="color:#8b95a3">${this.active ? 'steering' : 'idle'}`
          + `${this.grip ? ' · gripping' : ''}</span>`;
      } else {
        el.innerHTML = `<b>Control with your phone</b>`
          + `<div style="background:#fff;border-radius:6px;margin:8px 0;width:150px">${qrSvg}</div>`
          + `<span style="color:#8b95a3">Same Wi-Fi, then open<br></span>`
          + `<code style="word-break:break-all">${info.phone_url}</code>`;
      }
    };
    let lastKey = '';
    this.on(() => {
      const key = `${this.connected}${this.active}${this.grip}`;
      if (key !== lastKey) { lastKey = key; render(); }
    });
    render();
    return el;
  }
}
