// Learned mapping from phone rotation to gripper motion.
//
// The player does three moves once ("slide right", "push forward", "roll
// clockwise") holding the phone the way they like. Each move is a rotation
// about some axis in the phone's own frame (x = right edge, y = top edge,
// z = out of the screen). Later, any rotation since "Hold to move" was pressed
// is split into those three axes, so the controller follows the player's own
// idea of which move means what, whatever their grip.

import { quatFromEuler, mul, conj, rotationVector } from './tilt.js';

const KEY = 'handover.motionCalibration';
export const STEPS = [
  { id: 'right', label: 'slide the gripper RIGHT' },
  { id: 'forward', label: 'push the gripper AWAY from you' },
  { id: 'roll', label: 'roll the wrist CLOCKWISE (as you see it on screen)' },
];
export const MIN_ANGLE = 10 * Math.PI / 180;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

// Rotation from q0 to q1 in the phone's frame: [axis (unit), angle (rad)].
export function relativeRotation(q0, q1) {
  const rv = rotationVector(mul(conj(q0), q1));
  const angle = Math.hypot(...rv);
  return { axis: angle > 1e-9 ? rv.map((x) => x / angle) : [0, 0, 0], angle, rv };
}

export function quatFromEvent(e) {
  return quatFromEuler(e.alpha || 0, e.beta, e.gamma);
}

// Plain words for an axis in the phone's frame.
export function describeAxis(a) {
  // Worded relative to the phone itself, so it reads right however it is held.
  const names = [
    ['top edge tips toward the screen side', 'top edge tips toward the back'], // +x / -x
    ['right edge dips toward the back', 'right edge lifts toward the screen side'], // +y / -y
    ['spins counter-clockwise, seen looking at the screen', 'spins clockwise, seen looking at the screen'], // +z / -z
  ];
  const i = [0, 1, 2].reduce((b, k) => (Math.abs(a[k]) > Math.abs(a[b]) ? k : b), 0);
  const purity = Math.round(Math.abs(a[i]) * 100);
  return `${names[i][a[i] >= 0 ? 0 : 1]} (${'xyz'[i]} axis, ${purity}% pure)`;
}

// Built-in moves, used until the player teaches their own. "Like a joystick":
// tip the top edge away to go forward, dip the right side to go right, turn the
// phone right to roll clockwise. Which phone axes those are depends on the hold.
export const PRESETS = {
  flat: { right: [0, 1, 0], forward: [-1, 0, 0], roll: [0, 0, -1] },     // screen facing up
  upright: { right: [0, 0, -1], forward: [-1, 0, 0], roll: [0, -1, 0] }, // screen facing you
};

// 3x3 inverse of a matrix given as columns.
function invertColumns(c) {
  const [a, b, d] = c; // columns
  const m = [[a[0], b[0], d[0]], [a[1], b[1], d[1]], [a[2], b[2], d[2]]];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 0.25) return null; // two moves too similar to tell apart
  const inv = [
    [m[1][1] * m[2][2] - m[1][2] * m[2][1], m[0][2] * m[2][1] - m[0][1] * m[2][2], m[0][1] * m[1][2] - m[0][2] * m[1][1]],
    [m[1][2] * m[2][0] - m[1][0] * m[2][2], m[0][0] * m[2][2] - m[0][2] * m[2][0], m[0][2] * m[1][0] - m[0][0] * m[1][2]],
    [m[1][0] * m[2][1] - m[1][1] * m[2][0], m[0][1] * m[2][0] - m[0][0] * m[2][1], m[0][0] * m[1][1] - m[0][1] * m[1][0]],
  ];
  return inv.map((row) => row.map((v) => v / det));
}

export class Calibration {
  constructor(axes) {
    this.axes = axes; // { right, forward, roll } unit vectors in the phone's frame
    this.inv = invertColumns([axes.right, axes.forward, axes.roll]);
  }

  get valid() { return !!this.inv; }

  // Phone rotation (rotation vector, phone frame) -> { right, forward, roll } in radians.
  split(rv) {
    const [r, f, k] = this.inv.map((row) => dot(row, rv));
    return { right: r, forward: f, roll: k };
  }

  static load() {
    try {
      const c = new Calibration(JSON.parse(localStorage.getItem(KEY)));
      return c.valid ? c : null;
    } catch { return null; }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.axes)); } catch { /* private mode */ }
  }

  static clear() {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  }
}

// Send a diagnostics record to the server, which saves it on the Mac.
export function report(kind, data) {
  return fetch('/__phone/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, at: new Date().toISOString(), ua: navigator.userAgent, ...data }),
  }).catch(() => {});
}
