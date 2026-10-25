// Task: put the cup on the tray. Success predicates and quality metrics are computed
// from simulator ground truth each frame. Game score = data-quality score.
// Predicates and weights are documented in docs/tasks.md; keep the two in sync.

const HOLD_TIME = 0.5;            // s all success predicates must hold continuously
const UPRIGHT_COS = Math.cos((15 * Math.PI) / 180);
const TIPPED_COS = Math.cos((60 * Math.PI) / 180);
const SETTLED_SPEED = 0.02;       // m/s
const TRAY_INNER = [0.055, 0.04]; // half extents (m) the cup center must stay within
const ON_TRAY_MAX_Z = 0.015;      // cup origin height above table when resting on the tray floor
const DROP_HEIGHT = 0.03;         // cup released with its base this high counts as a drop
const SAMPLE_DT = 0.04;           // s between motion samples for smoothness

export const WEIGHTS = { time: 0.15, smoothness: 0.2, gentleness: 0.25, spill: 0.25, drops: 0.15 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export class CupOnTrayTask {
  constructor(sim, ik) {
    this.sim = sim;
    this.ik = ik;
    this.id = 'cup_on_tray';
    this.title = 'Put the cup on the tray';
    this.instruction = 'Put the cup on the tray.'; // the exact prompt a trained policy gets
    this.hint = 'Pick up the blue cup and set it down upright on the green tray. Keep it level and don’t bump anything.';
    const { model } = sim;
    this.cup = sim.id('BODY', 'cup');
    this.tray = sim.id('BODY', 'tray');
    this.cupFree = model.jnt_dofadr[sim.id('JOINT', 'cup_free')];
    const base = sim.id('BODY', 'base');
    const fixedJaw = sim.id('BODY', 'gripper');
    const movingJaw = sim.id('BODY', 'moving_jaw_so101_v1');
    // Geom roles, decided once from the body tree.
    this.role = new Int8Array(model.ngeom); // 0 other, 1 robot, 2 cup, 3 fixed jaw, 4 moving jaw
    for (let g = 0; g < model.ngeom; g++) {
      const b = model.geom_bodyid[g];
      if (b === this.cup) this.role[g] = 2;
      else if (b === fixedJaw) this.role[g] = 3;
      else if (b === movingJaw) this.role[g] = 4;
      else if (model.body_rootid[b] === base) this.role[g] = 1;
    }
    this.reset();
  }

  reset() {
    this.start = this.sim.time;
    this.time = 0;
    this.state = 'playing'; // playing | success | failed
    this.failReason = '';
    this.holdSince = null;
    this.checks = { onTray: false, upright: true, released: true, settled: true };
    this.held = false;
    this.bumps = 0;
    this.touching = new Set(); // robot-vs-other geom pairs in contact last frame
    this.maxCarryTilt = 0;
    this.drops = 0;
    this.samples = []; // [simTime, x, y, z] of the grasp point
    this.result = null;
  }

  // Classify current contacts: is the cup held, and which robot bumps started this frame.
  scanContacts() {
    const { data } = this.sim;
    let fixed = false, moving = false, cupSupported = false;
    const now = new Set();
    const contacts = data.contact;
    for (let i = 0; i < data.ncon; i++) {
      const c = contacts.get(i);
      const a = this.role[c.geom1], b = this.role[c.geom2];
      if (a === 2 || b === 2) {
        const other = a === 2 ? b : a;
        if (other === 3) fixed = true;
        else if (other === 4) moving = true;
        else if (other === 0) cupSupported = true;
      } else if ((a === 0 && b !== 0) || (b === 0 && a !== 0)) {
        // Robot touching furniture or another object (not the cup): a bump.
        now.add(c.geom1 < c.geom2 ? `${c.geom1}:${c.geom2}` : `${c.geom2}:${c.geom1}`);
      }
      c.delete?.();
    }
    contacts.delete();
    for (const k of now) if (!this.touching.has(k)) this.bumps++;
    this.touching = now;
    return { held: fixed && moving, touchingCup: fixed || moving, cupSupported };
  }

  // Call once per rendered frame, after stepping physics. Uses simulation time, so
  // scores don't depend on the player's frame rate.
  update() {
    if (this.state !== 'playing') return;
    const { data } = this.sim;
    this.time = this.sim.time - this.start;

    const p = data.xpos.subarray(3 * this.cup, 3 * this.cup + 3);
    const t = data.xpos.subarray(3 * this.tray, 3 * this.tray + 3);
    const upCos = data.xmat[9 * this.cup + 8];
    const v = data.qvel.subarray(this.cupFree, this.cupFree + 3);
    const speed = Math.hypot(v[0], v[1], v[2]);
    const { held, touchingCup, cupSupported } = this.scanContacts();

    if (this.held && !held && !cupSupported && p[2] > DROP_HEIGHT) this.drops++;
    this.held = held;
    if (held && !cupSupported) {
      this.maxCarryTilt = Math.max(this.maxCarryTilt, Math.acos(Math.min(1, upCos)));
    }

    const last = this.samples[this.samples.length - 1];
    if (!last || this.sim.time - last[0] >= SAMPLE_DT) this.samples.push([this.sim.time, ...this.ik.graspPoint(data)]);

    if (upCos < TIPPED_COS) return this.fail('The cup tipped over.');

    const c = this.checks;
    c.onTray = Math.abs(p[0] - t[0]) < TRAY_INNER[0] && Math.abs(p[1] - t[1]) < TRAY_INNER[1] && p[2] < ON_TRAY_MAX_Z;
    c.upright = upCos > UPRIGHT_COS;
    c.released = !touchingCup;
    c.settled = speed < SETTLED_SPEED;
    if (!(c.onTray && c.upright && c.released && c.settled)) this.holdSince = null;
    else if (this.holdSince === null) this.holdSince = this.sim.time;
    else if (this.sim.time - this.holdSince >= HOLD_TIME) this.succeed();
  }

  fail(reason) {
    this.state = 'failed';
    this.failReason = reason;
    this.result = { success: false, score: 0, reason };
  }

  // Root-mean-square jerk of the grasp point (m/s^3), by finite differences over the
  // (roughly SAMPLE_DT spaced) samples.
  rmsJerk() {
    const diff = (s) => s.slice(1).map((b, i) => {
      const a = s[i], h = b[0] - a[0], t = (a[0] + b[0]) / 2;
      return [t, (b[1] - a[1]) / h, (b[2] - a[2]) / h, (b[3] - a[3]) / h];
    });
    const jerk = diff(diff(diff(this.samples)));
    if (!jerk.length) return 0;
    let sum = 0;
    for (const j of jerk) sum += j[1] * j[1] + j[2] * j[2] + j[3] * j[3];
    return Math.sqrt(sum / jerk.length);
  }

  succeed() {
    this.state = 'success';
    const jerk = this.rmsJerk();
    const tiltDeg = (this.maxCarryTilt * 180) / Math.PI;
    const metrics = {
      time: clamp01(1 - (this.time - 20) / 70),           // full marks up to 20 s, zero at 90 s
      smoothness: Math.exp(-jerk / 60),                    // 60 m/s^3 RMS jerk ~ 37%
      gentleness: clamp01(1 - 0.2 * this.bumps),           // -20% per bump
      spill: clamp01(1 - (tiltDeg - 10) / 35),             // full marks under 10 deg tilt, zero at 45
      drops: clamp01(1 - 0.5 * this.drops),
    };
    let score = 0;
    for (const k in WEIGHTS) score += WEIGHTS[k] * metrics[k];
    this.result = {
      success: true,
      score: Math.round(100 * score),
      metrics,
      raw: { time: this.time, rmsJerk: jerk, bumps: this.bumps, maxCarryTiltDeg: tiltDeg, drops: this.drops },
    };
  }
}
