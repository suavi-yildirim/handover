// Turns high-level commands (move the grasp point, tilt, roll, open/close) into
// servo targets. Input devices (keyboard now, phone later) only call `command`.
import { ROBOT } from './robot.js';
import { ArmIK } from './ik.js';

const VELOCITY_SMOOTHING = 0.15; // s, time constant of the target velocity filter
// A target the arm can't reach at the commanded tilt is refused (the gripper stops as if
// at a wall) instead of letting the IK fold the arm into a different, surprising pose.
const MAX_POS_ERROR = 0.005; // m
const MAX_PITCH_ERROR = 0.06; // rad

export class Teleop {
  constructor(sim) {
    this.sim = sim;
    this.ik = new ArmIK(sim);
    this.act = ROBOT.actuators.map((n) => sim.id('ACTUATOR', n));
    this.reset();
  }

  reset() {
    const { data } = this.sim;
    this.q = this.ik.qadr.map((a) => data.qpos[a]);
    this.target = this.ik.graspPoint(data);
    this.good = { q: this.q.slice(), target: this.target.slice(), pitch: ROBOT.defaultPitch, roll: ROBOT.defaultRoll };
    this.vel = [0, 0, 0];
    this.pitch = ROBOT.defaultPitch;
    this.roll = ROBOT.defaultRoll;
    this.gripClosed = false;
    this.grip = data.qpos[this.sim.qposAdr(ROBOT.gripperJoint)];
    this.ikError = 0;
  }

  // v: [vx, vy, vz] m/s in world frame, pitchRate / rollRate rad/s, dt seconds.
  // The commanded velocity is low-pass filtered so on/off inputs like keys still give
  // smooth motion (smoother demos are better training data).
  command({ v = [0, 0, 0], pitchRate = 0, rollRate = 0 }, dt) {
    const t = this.target, a = 1 - Math.exp(-dt / VELOCITY_SMOOTHING);
    for (let i = 0; i < 3; i++) {
      this.vel[i] += (v[i] - this.vel[i]) * a;
      t[i] += this.vel[i] * dt;
    }
    this.clampTarget();
    this.pitch = Math.min(Math.PI / 2, Math.max(-Math.PI / 6, this.pitch + pitchRate * dt));
    const [rlo, rhi] = this.jointRange(ROBOT.rollJoint);
    this.roll = Math.min(rhi, Math.max(rlo, this.roll + rollRate * dt));
  }

  toggleGrip() { this.gripClosed = !this.gripClosed; }
  setGrip(closed) { this.gripClosed = closed; }

  jointRange(name) {
    const j = this.sim.id('JOINT', name), r = this.sim.model.jnt_range;
    return [r[2 * j], r[2 * j + 1]];
  }

  clampTarget() {
    const { rMin, rMax, zMin, zMax } = ROBOT.workspace;
    const t = this.target, [ox, oy] = ROBOT.panOrigin;
    t[2] = Math.min(zMax, Math.max(zMin, t[2]));
    const dx = t[0] - ox, dy = t[1] - oy, r = Math.hypot(dx, dy) || 1e-6;
    const rc = Math.min(rMax, Math.max(rMin, r));
    t[0] = ox + (dx / r) * rc;
    t[1] = oy + (dy / r) * rc;
  }

  // Solve IK toward `target` from the current q; false if the pose is out of reach.
  trySolve(target) {
    this.ikError = this.ik.solve(this.q, target, this.pitch, this.roll);
    return this.ikError <= MAX_POS_ERROR && this.ik.pitchError <= MAX_PITCH_ERROR;
  }

  // Called once per physics step block: run IK and write servo targets.
  apply(dt) {
    const g = ROBOT.gripper, goal = this.gripClosed ? g.closed : g.open;
    const step = g.speed * dt;
    this.grip += Math.max(-step, Math.min(step, goal - this.grip));
    const g0 = this.good;
    if (!this.trySolve(this.target)) {
      // Out of reach: slide along the boundary by keeping the new direction and height but
      // the last reachable distance from the shoulder (the reach limit is mostly radial).
      const [ox, oy] = ROBOT.panOrigin, t = this.target;
      const rg = Math.hypot(g0.target[0] - ox, g0.target[1] - oy);
      const dx = t[0] - ox, dy = t[1] - oy, r = Math.hypot(dx, dy) || 1e-6;
      const slid = [ox + (dx / r) * rg, oy + (dy / r) * rg, t[2]];
      this.q = g0.q.slice();
      if (r < rg && this.trySolve(slid)) {
        this.target = slid;
      } else {
        this.q = g0.q.slice(); this.target = g0.target.slice();
        this.pitch = g0.pitch; this.roll = g0.roll; this.vel = [0, 0, 0];
      }
      this.blocked = true;
    } else {
      this.blocked = false;
    }
    this.good = { q: this.q.slice(), target: this.target.slice(), pitch: this.pitch, roll: this.roll };
    const ctrl = this.sim.data.ctrl;
    for (let i = 0; i < 4; i++) ctrl[this.act[i]] = this.q[i];
    ctrl[this.act[4]] = this.roll;
    ctrl[this.act[5]] = this.grip;
  }
}
