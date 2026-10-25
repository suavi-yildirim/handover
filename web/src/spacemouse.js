// 3D mouse (3Dconnexion SpaceMouse) input over WebHID -> teleop commands.
// WebHID works in Chrome and Edge (not Safari or Firefox). The browser asks once
// which device to use; after that the page reconnects to it on its own.
//
// Mapping (cap motions as seen from the user, camera-relative like WASD):
//   push / pull the cap away / toward you  -> gripper forward / back
//   slide the cap left / right             -> gripper left / right
//   lift / press the cap                   -> gripper up / down
//   tilt the cap forward / back            -> tilt the gripper down / up
//   twist the cap                          -> roll the wrist
//   left button: open / close the gripper, right button: precise (slow) mode
//
// If an axis turns out reversed on a particular model, flip its sign in SIGN.

const VENDORS = [0x256f, 0x046d]; // 3Dconnexion, and Logitech for older SpaceMouse models
const FULL = 350;       // raw value of a full deflection
const DEADZONE = 0.08;  // fraction of FULL ignored around rest
const SPEED = 0.15;     // m/s at full deflection, same as the keyboard
const TILT_RATE = 1.2;  // rad/s
const ROLL_RATE = 2.0;  // rad/s
const FINE = 0.35;      // speed multiplier in precise mode
const SIGN = { tx: 1, ty: -1, tz: -1, rx: 1, rz: -1 };

const shape = (raw) => {
  const x = Math.max(-1, Math.min(1, raw / FULL));
  const m = Math.max(0, (Math.abs(x) - DEADZONE) / (1 - DEADZONE));
  return Math.sign(x) * m * m; // quadratic response: fine control near rest
};

export class SpaceMouseInput {
  constructor({ onToggleGrip }) {
    this.onToggleGrip = onToggleGrip;
    this.axes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    this.buttons = 0;
    this.fine = false;
    this.device = null;
    this.supported = 'hid' in navigator;
    this.onChange = () => {};
    if (this.supported) {
      navigator.hid.addEventListener('disconnect', (e) => { if (e.device === this.device) this.detach(); });
      navigator.hid.getDevices().then((ds) => {
        const d = ds.find((x) => VENDORS.includes(x.vendorId));
        if (d) this.attach(d);
      });
    }
  }

  // Must be called from a click (the browser shows its device picker).
  async connect() {
    if (!this.supported) return;
    const [d] = await navigator.hid.requestDevice({ filters: VENDORS.map((vendorId) => ({ vendorId })) });
    if (d) await this.attach(d);
  }

  async attach(device) {
    if (!device.opened) await device.open();
    this.device = device;
    device.addEventListener('inputreport', (e) => this.onReport(e));
    this.onChange();
  }

  detach() {
    this.device = null;
    for (const k in this.axes) this.axes[k] = 0;
    this.onChange();
  }

  get connected() { return !!this.device; }
  get name() { return this.device?.productName || '3D mouse'; }

  onReport({ reportId, data }) {
    const a = this.axes, i16 = (o) => data.getInt16(o, true);
    if (reportId === 1) {
      a.tx = i16(0); a.ty = i16(2); a.tz = i16(4);
      // Newer models send all six axes in report 1.
      if (data.byteLength >= 12) { a.rx = i16(6); a.ry = i16(8); a.rz = i16(10); }
    } else if (reportId === 2) {
      a.rx = i16(0); a.ry = i16(2); a.rz = i16(4);
    } else if (reportId === 3) {
      const b = data.byteLength >= 2 ? data.getUint16(0, true) : data.getUint8(0);
      const pressed = b & ~this.buttons;
      this.buttons = b;
      if (pressed & 1) this.onToggleGrip();
      if (pressed & 2) { this.fine = !this.fine; this.onChange(); }
    }
  }

  get active() {
    if (!this.device) return false;
    const a = this.axes;
    return [a.tx, a.ty, a.tz, a.rx, a.rz].some((v) => Math.abs(v) / FULL > DEADZONE);
  }

  // axes: { forward: [x, y], right: [x, y] } horizontal camera directions.
  command(axes) {
    const a = this.axes, k = this.fine ? FINE : 1;
    const f = SIGN.ty * shape(a.ty), r = SIGN.tx * shape(a.tx), u = SIGN.tz * shape(a.tz);
    return {
      v: [
        SPEED * k * (f * axes.forward[0] + r * axes.right[0]),
        SPEED * k * (f * axes.forward[1] + r * axes.right[1]),
        SPEED * k * u,
      ],
      pitchRate: TILT_RATE * k * SIGN.rx * shape(a.rx),
      rollRate: ROLL_RATE * k * SIGN.rz * shape(a.rz),
    };
  }
}
