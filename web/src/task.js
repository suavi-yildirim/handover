// Kitchen tasks. Success predicates and quality metrics are computed from simulator
// ground truth each frame. Game score = data-quality score.
// Predicates and weights are documented in docs/tasks.md; keep the two in sync.

const UPRIGHT_COS = Math.cos((15 * Math.PI) / 180);
const TIPPED_COS = Math.cos((60 * Math.PI) / 180);
const DROP_HEIGHT = 0.03;         // object released with its origin this high counts as a drop
const SAMPLE_DT = 0.04;           // s between motion samples for smoothness

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const deg = (rad) => (rad * 180) / Math.PI;

// Shared machinery: contact classification, grasp detection, bumps, smoothness, the
// "all predicates hold for HOLD seconds" rule, and weighted scoring.
class Task {
  constructor(sim, ik, objectBody) {
    this.sim = sim;
    this.ik = ik;
    const { model } = sim;
    this.obj = sim.id('BODY', objectBody);
    this.objDof = model.jnt_dofadr[model.body_jntadr[this.obj]];
    const base = sim.id('BODY', 'base');
    const fixedJaw = sim.id('BODY', 'gripper');
    const movingJaw = sim.id('BODY', 'moving_jaw_so101_v1');
    // Geom roles, decided once from the body tree.
    this.role = new Int8Array(model.ngeom); // 0 other, 1 robot, 2 task object, 3 fixed jaw, 4 moving jaw
    for (let g = 0; g < model.ngeom; g++) {
      const b = model.geom_bodyid[g];
      if (b === this.obj) this.role[g] = 2;
      else if (b === fixedJaw) this.role[g] = 3;
      else if (b === movingJaw) this.role[g] = 4;
      else if (model.body_rootid[b] === base) this.role[g] = 1;
    }
  }

  reset() {
    this.start = this.sim.time;
    this.time = 0;
    this.state = 'playing'; // playing | success | failed
    this.holdSince = null;
    this.held = false;
    this.bumps = 0;
    this.touching = new Set(); // robot-vs-other geom pairs in contact last frame
    this.drops = 0;
    this.samples = []; // [simTime, x, y, z] of the grasp point
    this.result = null;
    this.events = []; // [simTime, type] for grasp / release / drop / success / fail, logged with the episode
    this.checks = Object.fromEntries(Object.keys(this.checkLabels).map((k) => [k, false]));
  }

  // Classify current contacts: is the object held, and which robot bumps started this frame.
  scanContacts() {
    const { data } = this.sim;
    let fixed = false, moving = false, supported = false;
    const now = new Set();
    const contacts = data.contact;
    for (let i = 0; i < data.ncon; i++) {
      const c = contacts.get(i);
      const a = this.role[c.geom1], b = this.role[c.geom2];
      if (a === 2 || b === 2) {
        const other = a === 2 ? b : a;
        if (other === 3) fixed = true;
        else if (other === 4) moving = true;
        else if (other === 0) supported = true;
      } else if ((a === 0 && b !== 0) || (b === 0 && a !== 0)) {
        // Robot touching furniture or another object (not the task object): a bump.
        now.add(c.geom1 < c.geom2 ? `${c.geom1}:${c.geom2}` : `${c.geom2}:${c.geom1}`);
      }
      c.delete?.();
    }
    contacts.delete();
    for (const k of now) if (!this.touching.has(k)) this.bumps++;
    this.touching = now;
    return { held: fixed && moving, touching: fixed || moving, supported };
  }

  // Call once per rendered frame, after stepping physics. Uses simulation time, so
  // scores don't depend on the player's frame rate.
  update() {
    if (this.state !== 'playing') return;
    const { data } = this.sim;
    this.time = this.sim.time - this.start;
    const p = data.xpos.subarray(3 * this.obj, 3 * this.obj + 3);
    const v = data.qvel.subarray(this.objDof, this.objDof + 3);
    const s = {
      pos: p,
      upCos: data.xmat[9 * this.obj + 8],
      speed: Math.hypot(v[0], v[1], v[2]),
      ...this.scanContacts(),
    };
    s.dropped = this.held && !s.held && !s.supported && p[2] > DROP_HEIGHT;
    if (s.dropped) this.drops++;
    if (s.held !== this.held) this.events.push([this.sim.time, s.dropped ? 'drop' : s.held ? 'grasp' : 'release']);
    this.held = s.held;

    const last = this.samples[this.samples.length - 1];
    if (!last || this.sim.time - last[0] >= SAMPLE_DT) this.samples.push([this.sim.time, ...this.ik.graspPoint(data)]);

    const failure = this.evaluate(s);
    if (failure) return this.fail(failure);
    if (!Object.values(this.checks).every(Boolean)) this.holdSince = null;
    else if (this.holdSince === null) this.holdSince = this.sim.time;
    else if (this.sim.time - this.holdSince >= this.holdTime) this.succeed();
  }

  fail(reason) {
    this.events.push([this.sim.time, 'fail']);
    this.state = 'failed';
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

  // Metrics every task shares; tasks add their own in metrics().
  commonMetrics() {
    const jerk = this.rmsJerk();
    return {
      metrics: {
        time: clamp01(1 - (this.time - 20) / 70),   // full marks up to 20 s, zero at 90 s
        smoothness: Math.exp(-jerk / 60),            // 60 m/s^3 RMS jerk ~ 37%
        gentleness: clamp01(1 - 0.2 * this.bumps),   // -20% per bump
      },
      raw: { time: this.time, rmsJerk: jerk, bumps: this.bumps, drops: this.drops },
    };
  }

  succeed() {
    this.events.push([this.sim.time, 'success']);
    this.state = 'success';
    const { metrics, raw } = this.metrics();
    let score = 0;
    for (const k in this.weights) score += this.weights[k] * metrics[k];
    this.result = { success: true, score: Math.round(100 * score), metrics, raw };
  }
}

export class CupOnTrayTask extends Task {
  constructor(sim, ik) {
    super(sim, ik, 'cup');
    this.id = 'cup_on_tray';
    this.title = 'Put the cup on the tray';
    this.instruction = 'Put the cup on the tray.'; // the exact prompt a trained policy gets
    this.hint = 'Pick up the blue cup and set it down upright on the green tray. Keep it level and don’t bump anything.';
    this.checkLabels = { onTray: 'Cup on the tray', upright: 'Upright', released: 'Gripper let go', settled: 'Resting still' };
    this.metricLabels = { time: 'Speed', smoothness: 'Smooth motion', gentleness: 'No bumps', spill: 'Kept level', drops: 'No drops' };
    this.weights = { time: 0.15, smoothness: 0.2, gentleness: 0.25, spill: 0.25, drops: 0.15 };
    this.holdTime = 0.5;
    this.tray = sim.id('BODY', 'tray');
    this.reset();
  }

  reset() {
    super.reset();
    this.maxCarryTilt = 0;
  }

  evaluate(s) {
    if (s.held && !s.supported) this.maxCarryTilt = Math.max(this.maxCarryTilt, Math.acos(Math.min(1, s.upCos)));
    if (s.upCos < TIPPED_COS) return 'The cup tipped over.';
    const t = this.sim.data.xpos.subarray(3 * this.tray, 3 * this.tray + 3), p = s.pos, c = this.checks;
    // Inner tray area (half extents 5.5 x 4 cm); resting on the tray floor puts the cup origin below 1.5 cm.
    c.onTray = Math.abs(p[0] - t[0]) < 0.055 && Math.abs(p[1] - t[1]) < 0.04 && p[2] < 0.015;
    c.upright = s.upCos > UPRIGHT_COS;
    c.released = !s.touching;
    c.settled = s.speed < 0.02;
    return null;
  }

  metrics() {
    const { metrics, raw } = this.commonMetrics();
    const tiltDeg = deg(this.maxCarryTilt);
    metrics.spill = clamp01(1 - (tiltDeg - 10) / 35);   // full marks under 10 deg tilt, zero at 45
    metrics.drops = clamp01(1 - 0.5 * this.drops);
    raw.maxCarryTiltDeg = tiltDeg;
    return { metrics, raw };
  }
}

// Hand the medicine bottle to a person: bring it into the hand zone and hold it there,
// steady and upright, while they take it.
export class MedicationTask extends Task {
  constructor(sim, ik) {
    super(sim, ik, 'pill_bottle');
    this.id = 'bring_medication';
    this.title = 'Bring the medication';
    this.instruction = 'Hand the medicine bottle to the person.';
    this.hint = 'Pick up the orange medicine bottle and hold it still, upright, inside the pink hand zone so the person can take it. Approach slowly.';
    this.checkLabels = { held: 'Holding the bottle', inZone: 'In the hand zone', upright: 'Upright', steady: 'Holding still' };
    this.metricLabels = { time: 'Speed', smoothness: 'Smooth motion', gentleness: 'No bumps', approach: 'Gentle approach', steadiness: 'Steady hold' };
    this.weights = { time: 0.15, smoothness: 0.2, gentleness: 0.2, approach: 0.25, steadiness: 0.2 };
    this.holdTime = 1.5;
    this.zone = sim.id('SITE', 'hand_zone');
    this.zoneRadius = sim.model.site_size[3 * this.zone];
    this.reset();
  }

  reset() {
    super.reset();
    this.wasInZone = false;
    this.entrySpeed = null;      // speed of the bottle when it first entered the zone
    this.holdSpeeds = [];        // bottle speeds during the final hold
  }

  evaluate(s) {
    if (s.dropped) return 'The bottle was dropped. In a real handover it would fall.';
    if (s.upCos < TIPPED_COS) return 'The bottle tipped over.';
    const z = this.sim.data.site_xpos.subarray(3 * this.zone, 3 * this.zone + 3), p = s.pos, c = this.checks;
    // The bottle's center (origin + half its 7 cm height) must be inside the zone.
    const inZone = Math.hypot(p[0] - z[0], p[1] - z[1], p[2] + 0.036 - z[2]) < this.zoneRadius;
    if (inZone && !this.wasInZone && this.entrySpeed === null) this.entrySpeed = s.speed;
    this.wasInZone = inZone;
    c.held = s.held;
    c.inZone = inZone;
    c.upright = s.upCos > Math.cos((30 * Math.PI) / 180);
    c.steady = s.speed < 0.03;
    if (Object.values(c).every(Boolean)) this.holdSpeeds.push(s.speed);
    else this.holdSpeeds = [];
    return null;
  }

  metrics() {
    const { metrics, raw } = this.commonMetrics();
    const entry = this.entrySpeed ?? 0;
    const meanHold = this.holdSpeeds.length ? this.holdSpeeds.reduce((a, b) => a + b, 0) / this.holdSpeeds.length : 0;
    metrics.approach = clamp01(1 - (entry - 0.05) / 0.2);    // full marks entering under 5 cm/s, zero at 25 cm/s
    metrics.steadiness = clamp01(1 - meanHold / 0.03);         // mean speed during the hold, zero at 3 cm/s
    raw.entrySpeed = entry;
    raw.meanHoldSpeed = meanHold;
    return { metrics, raw };
  }
}

// Tidy a fall hazard: move the glasses case from the table edge on the person's side
// to the safe zone at the back of the table. Lift it; don't push it across the table.
export class FallHazardTask extends Task {
  constructor(sim, ik) {
    super(sim, ik, 'glasses_case');
    this.id = 'tidy_fall_hazard';
    this.title = 'Tidy a fall hazard';
    this.instruction = 'Move the glasses case away from the table edge to the safe spot.';
    this.hint = 'The glasses case sits on the red edge strip, where the person could knock it off. Lift it and set it down flat in the green safe spot.';
    this.checkLabels = { inSafeZone: 'In the safe spot', flat: 'Lying flat', released: 'Gripper let go', settled: 'Resting still' };
    this.metricLabels = { time: 'Speed', smoothness: 'Smooth motion', gentleness: 'No bumps', carried: 'Lifted, not pushed', drops: 'No drops' };
    this.weights = { time: 0.15, smoothness: 0.2, gentleness: 0.25, carried: 0.25, drops: 0.15 };
    this.holdTime = 0.5;
    const { model } = sim;
    this.safe = sim.id('GEOM', 'safe_zone');
    this.safeSize = [model.geom_size[3 * this.safe], model.geom_size[3 * this.safe + 1]];
    this.reset();
  }

  reset() {
    super.reset();
    this.lastXY = null;
    this.pathTotal = 0;   // horizontal distance the case traveled
    this.pathCarried = 0; // ... of which while held off the table
  }

  evaluate(s) {
    const p = s.pos, c = this.checks;
    if (p[2] < -0.05) return 'The glasses case fell off the table.';
    if (this.lastXY) {
      const d = Math.hypot(p[0] - this.lastXY[0], p[1] - this.lastXY[1]);
      this.pathTotal += d;
      if (s.held && !s.supported) this.pathCarried += d;
    }
    this.lastXY = [p[0], p[1]];
    const z = this.sim.data.geom_xpos.subarray(3 * this.safe, 3 * this.safe + 3);
    c.inSafeZone = Math.abs(p[0] - z[0]) < this.safeSize[0] && Math.abs(p[1] - z[1]) < this.safeSize[1];
    // Resting on its base (or upside down) on the table: low, and its short axis vertical.
    c.flat = p[2] < 0.01 && Math.abs(s.upCos) > Math.cos((15 * Math.PI) / 180);
    c.released = !s.touching;
    c.settled = s.speed < 0.02;
    return null;
  }

  metrics() {
    const { metrics, raw } = this.commonMetrics();
    const carried = this.pathTotal > 0.01 ? this.pathCarried / this.pathTotal : 1;
    metrics.carried = clamp01((carried - 0.5) / 0.4);   // full marks when 90% of the path is carried, zero at 50%
    metrics.drops = clamp01(1 - 0.5 * this.drops);
    raw.pathTotal = this.pathTotal;
    raw.carriedFraction = carried;
    return { metrics, raw };
  }
}

export const TASKS = [CupOnTrayTask, MedicationTask, FallHazardTask];
