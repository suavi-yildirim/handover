// The player's own phone moves, learned on the setup page (axes.html).
//
// Six moves, done once: three turns (roll, pitch, yaw) and three slides
// (right, forward, up). Each turn is a rotation about some axis of the phone
// (x = right edge, y = top edge, z = out of the screen); each slide is an
// acceleration along some direction of the phone. While playing, any rotation
// or acceleration is split into those learned directions, so the controller
// follows the player's own idea of each move, whatever their grip.

import { quatFromEuler, mul, conj, rotationVector } from './tilt.js';

const KEY = 'handover.motionCalibration.v2';
export const VERSION = 2;

export const STEPS = [
  { id: 'roll', kind: 'turn', title: 'Roll', label: 'Roll the wrist CLOCKWISE', hint: 'Turn the phone the way you want the gripper to roll clockwise on screen.' },
  { id: 'pitch', kind: 'turn', title: 'Pitch', label: 'Tilt the gripper DOWN', hint: 'Turn the phone the way you want the gripper to point more downward.' },
  { id: 'yaw', kind: 'turn', title: 'Yaw', label: 'Swing the arm to the RIGHT', hint: 'Turn the phone the way you want the arm to swing right.' },
  { id: 'x', kind: 'slide', title: 'Right', label: 'Move the phone to the RIGHT', hint: 'Slide the whole phone about 20 cm right in one smooth move, then stop. Keep it from turning.' },
  { id: 'y', kind: 'slide', title: 'Forward', label: 'Move the phone AWAY from you', hint: 'Push the whole phone about 20 cm away from you, then stop.' },
  { id: 'z', kind: 'slide', title: 'Up', label: 'Move the phone UP', hint: 'Lift the whole phone about 20 cm, then stop.' },
];
export const MIN_ANGLE = 10 * Math.PI / 180;
export const MIN_SPEED = 0.15; // m/s peak, so a slide is clearly a move and not hand shake

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

// Rotation from q0 to q1 in the phone's frame.
export function relativeRotation(q0, q1) {
  const rv = rotationVector(mul(conj(q0), q1));
  const angle = Math.hypot(...rv);
  return { axis: angle > 1e-9 ? rv.map((x) => x / angle) : [0, 0, 0], angle, rv };
}

export function quatFromEvent(e) {
  return quatFromEuler(e.alpha || 0, e.beta, e.gamma);
}

// Direction of a slide from gravity-free acceleration samples [[dt, ax, ay, az], ...]
// in the phone frame: integrate to velocity and take it at its fastest point.
export function slideDirection(samples) {
  const v = [0, 0, 0];
  let best = [0, 0, 0], bestSpeed = 0;
  for (const [dt, ax, ay, az] of samples) {
    v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt;
    const s = Math.hypot(...v);
    if (s > bestSpeed) { bestSpeed = s; best = v.slice(); }
  }
  return { axis: unit(best), speed: bestSpeed };
}

// Plain words for a direction in the phone's frame, for turns or slides.
export function describe(kind, a) {
  const names = kind === 'turn' ? [
    ['top edge tips toward the screen side', 'top edge tips toward the back'],
    ['right edge dips toward the back', 'right edge lifts toward the screen side'],
    ['spins counter-clockwise, seen looking at the screen', 'spins clockwise, seen looking at the screen'],
  ] : [
    ['toward the right edge', 'toward the left edge'],
    ['toward the top edge', 'toward the bottom edge'],
    ['out of the screen', 'out of the back'],
  ];
  const i = [0, 1, 2].reduce((b, k) => (Math.abs(a[k]) > Math.abs(a[b]) ? k : b), 0);
  return `${names[i][a[i] >= 0 ? 0 : 1]} (${Math.round(Math.abs(a[i]) * 100)}% ${'xyz'[i]})`;
}

// Inverse of the 3x3 matrix whose columns are a, b, c; null if they are too
// close to each other to tell apart.
function invertColumns([a, b, c]) {
  const m = [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 0.25) return null;
  const inv = [
    [m[1][1] * m[2][2] - m[1][2] * m[2][1], m[0][2] * m[2][1] - m[0][1] * m[2][2], m[0][1] * m[1][2] - m[0][2] * m[1][1]],
    [m[1][2] * m[2][0] - m[1][0] * m[2][2], m[0][0] * m[2][2] - m[0][2] * m[2][0], m[0][2] * m[1][0] - m[0][0] * m[1][2]],
    [m[1][0] * m[2][1] - m[1][1] * m[2][0], m[0][1] * m[2][0] - m[0][0] * m[2][1], m[0][0] * m[1][1] - m[0][1] * m[1][0]],
  ];
  return inv.map((row) => row.map((v) => v / det));
}

export class Calibration {
  // axes: { roll, pitch, yaw, x, y, z }, unit vectors in the phone's frame.
  constructor(axes) {
    this.axes = axes;
    this.turnInv = invertColumns([axes.roll, axes.pitch, axes.yaw]);
    this.slideInv = invertColumns([axes.x, axes.y, axes.z]);
  }

  get valid() { return !!(this.turnInv && this.slideInv); }

  // Phone rotation vector (phone frame) -> { roll, pitch, yaw } radians.
  turns(rv) {
    const [roll, pitch, yaw] = this.turnInv.map((row) => dot(row, rv));
    return { roll, pitch, yaw };
  }

  // Phone acceleration (phone frame) -> [right, forward, up].
  slides(acc) {
    return this.slideInv.map((row) => dot(row, acc));
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
    body: JSON.stringify({ kind, version: VERSION, at: new Date().toISOString(), ua: navigator.userAgent, ...data }),
  }).catch(() => {});
}
