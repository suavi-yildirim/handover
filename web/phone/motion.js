// Move the gripper by moving the phone.
//
// Works like a mouse with a button: hold "Hold to move", move the phone, let
// go to reposition your hand. Two ways to read the motion:
//
//   aim:  gyro-based, steady. Turn the phone left/right to slide the gripper
//         left/right, tip it up/down to push it farther/closer, twist it like a
//         key to roll the wrist. Height comes from the slider.
//   push: accelerometer-based, experimental. Physically move the phone and the
//         gripper follows in 3D. Phone accelerometers drift, so this works for
//         short moves only.
//
// Output, all relative to the moment the button was pressed, in the player's
// frame (x right, y forward/away from you, z up):
//   pos  { x, y, z }  metres for the gripper to move
//   roll              radians of wrist roll

import { quatFromEuler, rotate } from './tilt.js';

const AIM_GAIN = 0.4;        // metres of gripper travel per radian of phone turn (~0.7 cm per degree)
const PUSH_GAIN = 1.5;       // gripper metres per metre of hand motion (the leaky estimate undershoots)
const PUSH_LEAK = 0.6;       // s; velocity estimate decays toward zero, which limits drift
const PUSH_DEADBAND = 0.08;  // m/s²; sensor noise below this is ignored

// The phone "points" along its top edge when held flat-ish, or out of its back
// when held upright. Picked on each press, whichever is closer to level.
const TOP = [0, 1, 0];
const BACK = [0, 0, -1];

// How far the phone is banked (turned like a key) around its pointing axis:
// the angle its right edge dips below level. Turning left/right or tipping
// up/down leaves it at zero.
function bank(q) {
  const right = rotate(q, [1, 0, 0]);
  return Math.asin(Math.max(-1, Math.min(1, -right[2])));
}

export class Motion {
  constructor() {
    this.mode = 'aim';
    this.enabled = false;
    this.available = false;
    this.held = false;
    this.clutch = 0;      // bumps on every press so the game can resync
    this.q = null;        // device -> world orientation
    this.pos = { x: 0, y: 0, z: 0 };
    this.roll = 0;
    this._onOrient = (e) => this._orient(e);
    this._onMotion = (e) => this._motion(e);
  }

  // Must be called from a tap: iPhone asks for permission here.
  async enable() {
    if (!window.isSecureContext) throw new Error('Motion needs the https:// address (see the server window).');
    const events = [window.DeviceOrientationEvent, window.DeviceMotionEvent];
    if (!events.every(Boolean)) throw new Error('This browser has no motion sensor support.');
    // Ask for both in the same tap (iPhone only allows the prompt during a user gesture).
    const answers = await Promise.all(events.map((Ev) => (
      typeof Ev.requestPermission === 'function' ? Ev.requestPermission().catch(() => 'denied') : 'granted')));
    if (answers.some((a) => a !== 'granted')) {
      throw new Error('Motion access was denied. Close the tab, reopen the page and tap Allow.');
    }
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('devicemotion', this._onMotion);
    this.enabled = true;
  }

  press() {
    if (!this.q) return false;
    this.held = true;
    this.clutch++;
    this.q0 = this.q;
    const top = rotate(this.q, TOP), back = rotate(this.q, BACK);
    this.pointer = Math.abs(top[2]) <= Math.abs(back[2]) ? TOP : BACK;
    this.bank0 = bank(this.q);
    // The player's frame: forward is where the phone pointed, flattened onto the floor.
    const p = rotate(this.q0, this.pointer);
    this.heading = Math.atan2(p[1], p[0]);
    this.elev0 = Math.asin(Math.max(-1, Math.min(1, p[2])));
    this.vel = [0, 0, 0];
    this.hand = [0, 0, 0];
    this.pos = { x: 0, y: 0, z: 0 };
    this.roll = 0;
    return true;
  }

  release() {
    this.held = false;
  }

  _orient(e) {
    if (e.beta == null || e.gamma == null) return;
    this.available = true;
    this.q = quatFromEuler(e.alpha || 0, e.beta, e.gamma);
    if (!this.held) return;

    // Turning it like a key -> wrist roll (clockwise = positive).
    this.roll = bank(this.q) - this.bank0;

    if (this.mode === 'aim') {
      const p = rotate(this.q, this.pointer);
      let dYaw = Math.atan2(p[1], p[0]) - this.heading;
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
      const dElev = Math.asin(Math.max(-1, Math.min(1, p[2]))) - this.elev0;
      // Turn left (positive yaw) -> gripper left; tip up -> farther away.
      this.pos = { x: -dYaw * AIM_GAIN, y: dElev * AIM_GAIN, z: 0 };
    }
  }

  _motion(e) {
    if (!this.held || this.mode !== 'push' || !this.q) return;
    const a = e.acceleration; // gravity removed by the phone's own sensor fusion
    if (!a || a.x == null) return;
    // interval is ms per the spec, but older iOS reports seconds.
    const iv = e.interval > 1 ? e.interval / 1000 : e.interval || 1 / 60;
    const dt = Math.min(0.05, iv);
    // Device -> world, then world -> player frame (rotate by -heading about z).
    let w = rotate(this.q, [a.x, a.y, a.z]);
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    w = [w[0] * c + w[1] * s, -w[0] * s + w[1] * c, w[2]]; // [forward, left, up]
    const acc = [-w[1], w[0], w[2]].map((v) => (Math.abs(v) < PUSH_DEADBAND ? 0 : v)); // [right, forward, up]
    const k = Math.exp(-dt / PUSH_LEAK);
    for (let i = 0; i < 3; i++) {
      this.vel[i] = (this.vel[i] + acc[i] * dt) * k;
      this.hand[i] += this.vel[i] * dt;
    }
    this.pos = { x: this.hand[0] * PUSH_GAIN, y: this.hand[1] * PUSH_GAIN, z: this.hand[2] * PUSH_GAIN };
  }
}
