// Phone tilt -> wrist angles.
//
// Reads DeviceOrientation, turns it into a quaternion, and measures the
// rotation since the last recenter in the screen's own frame (x right,
// y up, z out of the screen). That makes it work the same in portrait and
// landscape, and avoids Euler-angle flips near vertical.
//
//   pitch: tip the top edge away from you  -> positive (gripper tilts down)
//   roll:  turn the phone like a steering wheel to the right -> positive

const DEG = Math.PI / 180;

export function quatFromEuler(alpha, beta, gamma) {
  // W3C DeviceOrientation: intrinsic Z-X'-Y'' rotations.
  const [a, b, g] = [alpha * DEG / 2, beta * DEG / 2, gamma * DEG / 2];
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cB * cG - sA * sB * sG, // w
    cA * sB * cG - sA * cB * sG, // x
    cA * cB * sG + sA * sB * cG, // y
    sA * cB * cG + cA * sB * sG, // z
  ];
}

export function mul(p, q) {
  const [pw, px, py, pz] = p, [qw, qx, qy, qz] = q;
  return [
    pw * qw - px * qx - py * qy - pz * qz,
    pw * qx + px * qw + py * qz - pz * qy,
    pw * qy - px * qz + py * qw + pz * qx,
    pw * qz + px * qy - py * qx + pz * qw,
  ];
}

export const conj = ([w, x, y, z]) => [w, -x, -y, -z];

// Rotate vector v by unit quaternion q.
export function rotate(q, v) {
  const r = mul(mul(q, [0, v[0], v[1], v[2]]), conj(q));
  return [r[1], r[2], r[3]];
}

export function rotationVector(q) {
  let [w, x, y, z] = q;
  if (w < 0) [w, x, y, z] = [-w, -x, -y, -z];
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, w);
  return [x / s * angle, y / s * angle, z / s * angle];
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

export class Tilt {
  constructor({ deadzone = 2 * DEG, limit = 90 * DEG, smoothing = 0.35 } = {}) {
    Object.assign(this, { deadzone, limit, smoothing });
    this.enabled = false;
    this.available = false;
    this.q = null;       // latest orientation, screen-aligned
    this.q0 = null;      // orientation at the last recenter
    this.centerId = 0;   // bumps on every recenter so the game can resync
    this.pitch = 0;
    this.roll = 0;
    this._onEvent = (e) => this._update(e);
    this._onRotate = () => { this.q0 = null; };
  }

  // Must be called from a tap: iPhone asks for permission here.
  async enable() {
    if (!window.isSecureContext) throw new Error('Tilt needs the https:// address (see the server window).');
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('This browser has no tilt sensor support.');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const answer = await DeviceOrientationEvent.requestPermission();
      if (answer !== 'granted') throw new Error('Motion access was denied. Allow it in Settings > Safari, then reload.');
    }
    window.addEventListener('deviceorientation', this._onEvent);
    (screen.orientation || window).addEventListener?.('change', this._onRotate);
    window.addEventListener('orientationchange', this._onRotate);
    this.enabled = true;
    this.q0 = null;
  }

  disable() {
    window.removeEventListener('deviceorientation', this._onEvent);
    window.removeEventListener('orientationchange', this._onRotate);
    (screen.orientation || window).removeEventListener?.('change', this._onRotate);
    this.enabled = false;
    this.pitch = this.roll = 0;
  }

  recenter() {
    this.q0 = null; // next reading becomes neutral
  }

  _update(e) {
    if (e.beta == null || e.gamma == null) return; // no sensor (desktop)
    this.available = true;
    const device = quatFromEuler(e.alpha || 0, e.beta, e.gamma);
    // Rotate the device frame into the screen frame for the current orientation.
    const a = -screenAngle() * DEG / 2;
    this.q = mul(device, [Math.cos(a), 0, 0, Math.sin(a)]);
    if (!this.q0) {
      this.q0 = this.q;
      this.centerId++;
      this.pitch = this.roll = 0;
      return;
    }
    const [rx, , rz] = rotationVector(mul(conj(this.q0), this.q));
    const shape = (v) => {
      const m = Math.max(0, Math.abs(v) - this.deadzone);
      return Math.sign(v) * Math.min(m, this.limit);
    };
    // Top edge away = negative rotation about screen x; clockwise = negative about z.
    const k = this.smoothing;
    this.pitch += k * (shape(-rx) - this.pitch);
    this.roll += k * (shape(-rz) - this.roll);
  }
}
