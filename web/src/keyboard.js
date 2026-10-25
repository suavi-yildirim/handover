// Keyboard input -> teleop commands. Movement is relative to the camera view.
const SPEED = 0.15;       // m/s
const FINE = 0.4;         // speed multiplier while Shift is held
const TILT_RATE = 1.2;    // rad/s
const ROLL_RATE = 2.0;    // rad/s

export const KEY_HELP = [
  ['W A S D', 'move gripper'],
  ['E / Q', 'up / down'],
  ['I / K', 'tilt down / up'],
  ['J / L', 'roll wrist'],
  ['Space', 'open / close gripper'],
  ['Shift', 'slow, precise moves'],
  ['C', 'wrist camera view on / off'],
  ['V', '4 views (front, top, 3D, side) / one view'],
  ['M', 'show / hide the menu'],
  ['R', 'reset level'],
  ['1 2 3', 'switch task'],
  ['Mouse', 'orbit / zoom camera'],
];

export class Keyboard {
  constructor({ onToggleGrip, onReset }) {
    this.down = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      if (k === 'Space') { e.preventDefault(); onToggleGrip(); return; }
      if (k === 'KeyR') { onReset(); return; }
      this.down.add(k);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  axis(pos, neg) { return (this.down.has(pos) ? 1 : 0) - (this.down.has(neg) ? 1 : 0); }

  // axes: { forward: [x, y], right: [x, y] } horizontal camera directions.
  command(axes) {
    const k = this.down.has('ShiftLeft') || this.down.has('ShiftRight') ? FINE : 1;
    const f = this.axis('KeyW', 'KeyS'), r = this.axis('KeyD', 'KeyA'), u = this.axis('KeyE', 'KeyQ');
    return {
      v: [
        SPEED * k * (f * axes.forward[0] + r * axes.right[0]),
        SPEED * k * (f * axes.forward[1] + r * axes.right[1]),
        SPEED * k * u,
      ],
      pitchRate: TILT_RATE * k * this.axis('KeyI', 'KeyK'),
      rollRate: ROLL_RATE * k * this.axis('KeyL', 'KeyJ'),
    };
  }

  get active() { return this.down.size > 0; }
}
