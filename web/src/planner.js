// Automatic demos: a planner that plays the three kitchen tasks like a careful player, by
// steering the same teleop target as the keyboard does. It reads object poses from the
// simulation on every frame, so it replans from wherever things are now: a moved object is
// followed, and a slipped grasp sends it back to try again.
//
// Used headless to generate episodes (tools/generate_demos.mjs) and in the browser (P key).
// Task geometry (grasp heights, offsets) is the same as in the scripted tests.
import { ROBOT } from './robot.js';
import { mulberry32 } from './scene.js';

const GAIN = 4;           // 1/s: speed toward the goal is GAIN x distance, capped at the phase speed
const ARRIVE = 0.003;     // m: close enough to the phase goal
const SETTLE_SPEED = 0.01; // m/s: and slow enough
const MAX_RETRIES = 3;

const bodyPos = (sim, b) => Array.from(sim.data.xpos.subarray(3 * b, 3 * b + 3));
const sitePos = (sim, s) => Array.from(sim.data.site_xpos.subarray(3 * s, 3 * s + 3));
const geomPos = (sim, g) => Array.from(sim.data.geom_xpos.subarray(3 * g, 3 * g + 3));
const SHOULDER = ROBOT.panOrigin;

const GRIP_R_MIN = 0.295; // m from the shoulder: nearest the level gripper grasps at table height

function clampRing(p) {
  const dx = p[0] - SHOULDER[0], dy = p[1] - SHOULDER[1], r = Math.hypot(dx, dy) || 1e-9;
  return r >= GRIP_R_MIN ? p : [SHOULDER[0] + dx / r * GRIP_R_MIN, SHOULDER[1] + dy / r * GRIP_R_MIN];
}

// Unit radial and tangential vectors at a table point, seen from the shoulder.
function basis(p) {
  const dx = p[0] - SHOULDER[0], dy = p[1] - SHOULDER[1], r = Math.hypot(dx, dy) || 1e-9;
  return [[dx / r, dy / r], [-dy / r, dx / r]];
}
// An xy offset (object minus grasp point) as [radial, tangential] components at point p ...
function toPolar(off, p) {
  const [u, v] = basis(p);
  return [off[0] * u[0] + off[1] * u[1], off[0] * v[0] + off[1] * v[1]];
}
// ... and back to xy at another point q. A held object turns with the arm as it pans, so its
// offset from the grasp point keeps its radial/tangential components, not its xy ones.
function fromPolar(c, q) {
  const [u, v] = basis(q);
  return [c[0] * u[0] + c[1] * v[0], c[0] * u[1] + c[1] * v[1]];
}

// Points from `a` to `b` that turn around the shoulder instead of cutting straight across:
// a level gripper cannot reach the table close to the shoulder, which a straight line between
// two far-apart spots on the ring would cross. Radius, angle and height change evenly.
export function arcPath(a, b, step = 0.04) {
  const [ox, oy] = SHOULDER;
  const ra = Math.hypot(a[0] - ox, a[1] - oy), rb = Math.hypot(b[0] - ox, b[1] - oy);
  const ta = Math.atan2(a[1] - oy, a[0] - ox);
  let dt = Math.atan2(b[1] - oy, b[0] - ox) - ta;
  dt = Math.atan2(Math.sin(dt), Math.cos(dt));
  const length = Math.max(Math.abs(dt) * (ra + rb) / 2, Math.hypot(...[0, 1, 2].map((k) => b[k] - a[k])));
  const n = Math.max(1, Math.ceil(length / step));
  return Array.from({ length: n }, (_, i) => {
    const f = (i + 1) / n, r = ra + (rb - ra) * f, t = ta + dt * f;
    return [ox + r * Math.cos(t), oy + r * Math.sin(t), a[2] + (b[2] - a[2]) * f];
  });
}

// What each task needs: the object, how to hold it, where it goes. `grip(o)` is the grasp
// point xy for the object's current pose, `goal()` where the object's origin should end up,
// `place` the grasp-point height at release (null: hold until the task says success).
function specFor(task, sim) {
  switch (task.id) {
    case 'cup_on_tray': {
      const cup = sim.id('BODY', 'cup'), tray = sim.id('BODY', 'tray');
      return {
        body: cup, gripZ: 0.035, lift: 0.08, carrySpeed: 0.12, placeSpeed: 0.06,
        grip: (o) => [o[0], o[1]],
        goal: () => bodyPos(sim, tray).slice(0, 2),
        placeZ: 0.035 + 0.012, release: true,
      };
    }
    case 'bring_medication': {
      const bottle = sim.id('BODY', 'pill_bottle'), zone = sim.id('SITE', 'hand_zone');
      return {
        body: bottle, gripZ: 0.035, lift: 0.10, carrySpeed: 0.12, placeSpeed: 0.04,
        grip: (o) => [o[0], o[1]],
        goal: () => sitePos(sim, zone).slice(0, 2),
        // The grasp point sits gripZ above the bottle base, whose center is 3.6 cm up.
        placeZ: () => sitePos(sim, zone)[2] - 0.036 + 0.035, release: false,
      };
    }
    case 'tidy_fall_hazard': {
      const box = sim.id('BODY', 'glasses_case'), safe = sim.id('GEOM', 'safe_zone');
      return {
        body: box, gripZ: 0.02, lift: 0.10, carrySpeed: 0.12, placeSpeed: 0.05,
        // Grip the end of the case nearer the robot: that is within reach and the jaws close
        // across its 4 cm width.
        grip: (o) => {
          const R = sim.data.xmat.subarray(9 * box, 9 * box + 9), ax = [R[0], R[3]];
          const toward = (SHOULDER[0] - o[0]) * ax[0] + (SHOULDER[1] - o[1]) * ax[1] > 0 ? 1 : -1;
          return [o[0] + 0.04 * toward * ax[0], o[1] + 0.04 * toward * ax[1]];
        },
        goal: () => geomPos(sim, safe).slice(0, 2),
        placeZ: 0.02 + 0.008, release: true,
      };
    }
    default:
      throw new Error(`No planner for task ${task.id}`);
  }
}

export class Planner {
  // seed varies the speed a little from episode to episode, like different players do.
  constructor(sim, teleop, task, { seed = 0 } = {}) {
    this.sim = sim;
    this.teleop = teleop;
    this.task = task;
    this.spec = specFor(task, sim);
    const rnd = mulberry32(seed + 7919);
    this.speed = 0.09 + 0.07 * rnd();
    this.retries = 0;
    this.phase = 0;
    this.phaseTime = 0;
    this.state = 'running'; // running | finished | gave_up
    this.reason = null;
    this.holdXY = null;      // grasp point xy when the jaws closed
    this.grasped = null;     // object origin minus grasp point as [radial, tangential] once the jaws closed
    this.names = ['above', 'lower', 'close', 'lift', 'carry', 'place', 'release', 'retreat', 'finish'];
  }

  get phaseName() { return this.names[this.phase]; }

  // Waypoints for one pass of the plan from the current object poses (grasp-point positions).
  // Used for the reach check and for the phases themselves.
  waypoints() {
    const s = this.spec, o = bodyPos(this.sim, s.body);
    const g = s.grip(o), goal = s.goal();
    const off = this.grasped ? fromPolar(this.grasped, goal) : [0, 0];
    // Where the grasp point goes so the object lands on the goal; the dead zone close to the
    // shoulder is out of reach, so a goal nearer than that is approached as close as possible.
    const [gx, gy] = clampRing([goal[0] - off[0], goal[1] - off[1]]);
    const placeZ = typeof s.placeZ === 'function' ? s.placeZ() : s.placeZ;
    return {
      above: [g[0], g[1], s.gripZ + 0.06],
      grasp: [g[0], g[1], s.gripZ],
      // Once the jaws have closed, rise straight up from where they are: the held object
      // sits a few mm off the grasp point, so following the object's own xy would drift.
      lift: this.holdXY ? [this.holdXY[0], this.holdXY[1], s.gripZ + s.lift] : [g[0], g[1], s.gripZ + s.lift],
      carry: [gx, gy, Math.max(s.gripZ + s.lift, placeZ + 0.06)],
      place: [gx, gy, placeZ],
    };
  }

  // Can the arm get through the whole plan? Follows the path in small steps with the IK, like
  // a player would, from the pose the arm is in now. Does not touch the simulation or teleop.
  reachable() {
    const { teleop } = this, ik = teleop.ik;
    const q = teleop.q.slice();
    let p = teleop.target.slice();
    const w = this.waypoints();
    // Estimate where the object will sit relative to the grasp point, for the carry targets.
    const spec = this.spec, o = bodyPos(this.sim, spec.body), g = spec.grip(o);
    const off = toPolar([o[0] - g[0], o[1] - g[1]], g);
    const saved = this.grasped;
    this.grasped = off;
    const w2 = this.waypoints();
    this.grasped = saved;
    const route = [w.above, w.grasp, w.lift, w2.carry, w2.place];
    for (const t of route) {
      for (const step of arcPath(p, t, 0.01)) {
        const err = ik.solve(q, step, teleop.pitch, teleop.roll);
        if (err > 0.005 || ik.pitchError > 0.06) { this.unreachableAt = step; return false; }
      }
      p = t;
    }
    return true;
  }

  enter(i) {
    this.phase = i;
    this.phaseTime = 0;
    this.stable = 0;
    this.via = null; // waypoints along the way, set when the phase's goal is first known
  }

  // Call once per frame, before teleop.apply(dt). Sets the teleop target and gripper.
  update(dt) {
    const { teleop, task, spec, sim } = this;
    if (this.state !== 'running') return;
    if (task.state !== 'playing') { this.state = task.state === 'success' ? 'finished' : 'gave_up'; this.reason = task.result?.reason ?? null; return; }
    this.phaseTime += dt;
    const w = this.waypoints(), t = teleop.target;
    const name = this.phaseName;
    let goal = null, speed = this.speed, grip = null, wait = null;
    const obj = bodyPos(sim, spec.body);
    switch (name) {
      case 'above': goal = w.above; grip = false; break;
      case 'lower': goal = w.grasp; speed = 0.05; grip = false; break;
      case 'close': grip = true; wait = 1.0; break;
      case 'lift': goal = w.lift; speed = 0.08; break;
      case 'carry': goal = w.carry; speed = spec.carrySpeed; break;
      case 'place': goal = w.place; speed = spec.placeSpeed; break;
      case 'release': grip = spec.release ? false : true; wait = spec.release ? 1.0 : Infinity; break;
      case 'retreat': goal = [t[0], t[1], t[2] + 0.1]; speed = 0.08; break;
      default: // finish: wait for the task to call it
        if (this.phaseTime > 8) { this.state = 'gave_up'; this.reason = 'task did not finish'; return; }
        break;
    }
    if (grip !== null) teleop.setGrip(grip);

    // Lost the object while carrying it: go back and grasp again (up to MAX_RETRIES times).
    if (['lift', 'carry', 'place'].includes(name) && !task.held && this.phaseTime > 0.5 && obj[2] < 0.012) {
      if (++this.retries > MAX_RETRIES) { this.state = 'gave_up'; this.reason = 'lost the object too often'; return; }
      this.grasped = this.holdXY = null;
      this.enter(0);
      return;
    }

    if (goal) {
      if (!this.via) this.via = arcPath(t, goal);
      // Chase the next waypoint; the last one is the live goal (it follows a moving object).
      while (this.via.length > 1 && Math.hypot(...[0, 1, 2].map((k) => this.via[0][k] - t[k])) < 0.02) this.via.shift();
      const last = this.via.length === 1;
      const aim = last ? goal : this.via[0];
      const d = [aim[0] - t[0], aim[1] - t[1], aim[2] - t[2]], dist = Math.hypot(...d) || 1e-9;
      const v = Math.min(speed, last ? GAIN * dist : speed);
      teleop.command({ v: [d[0] / dist * v, d[1] / dist * v, d[2] / dist * v] }, dt);
      const vel = Math.hypot(...teleop.vel);
      this.stable = last && dist < ARRIVE && vel < SETTLE_SPEED ? this.stable + dt : 0;
      if (this.stable > 0.1) this.next();
    } else {
      teleop.command({}, dt);
      if (name === 'close' && this.phaseTime >= wait) {
        if (!task.held && this.phaseTime < 2.5) return; // give the jaws a moment to bite
        if (!task.held) {
          if (++this.retries > MAX_RETRIES) { this.state = 'gave_up'; this.reason = 'could not grasp'; return; }
          this.grasped = this.holdXY = null;
          this.enter(0);
          return;
        }
        const g = spec.grip(obj);
        this.grasped = toPolar([obj[0] - teleop.target[0], obj[1] - teleop.target[1]], teleop.target);
        this.holdXY = teleop.target.slice(0, 2);
        this.next();
      } else if (name === 'release' && this.phaseTime >= wait) this.next();
      // 'release' without wait (hold the object) just keeps holding until the task succeeds.
    }
  }

  next() { this.enter(Math.min(this.phase + 1, this.names.length - 1)); }
}
