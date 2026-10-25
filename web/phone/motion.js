// Move the gripper by moving the phone, using the player's own moves from the
// setup page (calibration.js).
//
// Works like a mouse with a button: hold "Hold to move", move the phone, let
// go to reposition your hand. While held, relative to the moment of the press:
//
//   roll turn  -> wrist roll        (1:1 at Normal speed)
//   pitch turn -> wrist pitch       (1:1 at Normal speed)
//   yaw turn   -> arm swings sideways
//   slides     -> gripper moves right / forward / up. Read from the
//                 accelerometer, which drifts, so short moves work best.
//
// Output in the player's frame (x right, y forward/away, z up):
//   pos { x, y, z } metres, roll and pitch radians.

import { quatFromEuler } from './tilt.js';
import { Calibration, relativeRotation } from './calibration.js';

const YAW_GAIN = 0.15;      // metres sideways per radian of yaw (~2.6 cm per 10°)
const SLIDE_GAIN = 0.7;     // gripper metres per metre of hand motion
const SLIDE_LEAK = 0.5;     // s; the velocity estimate decays toward zero, which limits drift
const SLIDE_DEADBAND = 0.12; // m/s²; sensor noise below this is ignored

export const SPEEDS = { slow: 0.5, normal: 1, fast: 1.6 };

// Used only if the player skipped setup: a phone held flat, screen up.
const FALLBACK = new Calibration({
  roll: [0, 1, 0], pitch: [-1, 0, 0], yaw: [0, 0, -1],
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
});

export class Motion {
  constructor() {
    this.enabled = false;
    this.available = false;
    this.held = false;
    this.slide = true;    // use phone slides for x/y/z
    this.speed = 1;       // SPEEDS multiplier
    this.clutch = 0;      // bumps on every press so the game can resync
    this.q = null;        // device -> world orientation
    this.pos = { x: 0, y: 0, z: 0 };
    this.roll = 0;
    this.pitch = 0;
    this.calibration = Calibration.load();
    this._onOrient = (e) => this._orient(e);
    this._onMotion = (e) => this._motion(e);
  }

  get mapping() { return this.calibration || FALLBACK; }

  // Must be called from a tap: iPhone asks for permission here.
  async enable() {
    if (this.enabled) return;
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
    this.vel = [0, 0, 0];
    this.hand = [0, 0, 0];
    this.sideFromYaw = 0;
    this.pos = { x: 0, y: 0, z: 0 };
    this.roll = this.pitch = 0;
    return true;
  }

  release() {
    this.held = false;
  }

  _update() {
    const k = this.speed, h = this.hand;
    this.pos = {
      x: this.sideFromYaw * k + h[0] * SLIDE_GAIN * k,
      y: h[1] * SLIDE_GAIN * k,
      z: h[2] * SLIDE_GAIN * k,
    };
  }

  _orient(e) {
    if (e.beta == null || e.gamma == null) return;
    this.available = true;
    this.q = quatFromEuler(e.alpha || 0, e.beta, e.gamma);
    if (!this.held) return;
    const t = this.mapping.turns(relativeRotation(this.q0, this.q).rv);
    this.roll = t.roll * this.speed;
    this.pitch = t.pitch * this.speed;
    this.sideFromYaw = t.yaw * YAW_GAIN;
    this._update();
  }

  _motion(e) {
    if (!this.held || !this.slide) return;
    const a = e.acceleration; // gravity removed by the phone's own sensor fusion
    if (!a || a.x == null) return;
    // interval is ms per the spec, but older iOS reports seconds.
    const iv = e.interval > 1 ? e.interval / 1000 : e.interval || 1 / 60;
    const dt = Math.min(0.05, iv);
    const acc = this.mapping.slides([a.x, a.y, a.z]).map((v) => (Math.abs(v) < SLIDE_DEADBAND ? 0 : v));
    const leak = Math.exp(-dt / SLIDE_LEAK);
    for (let i = 0; i < 3; i++) {
      this.vel[i] = (this.vel[i] + acc[i] * dt) * leak;
      this.hand[i] += this.vel[i] * dt;
    }
    this._update();
  }
}
