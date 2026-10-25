// Turns high-level commands (move the grasp point, tilt, roll, open/close) into
// servo targets. Input devices (keyboard now, phone later) only call `command`.
import { ROBOT } from './robot.js';
import { ArmIK } from './ik.js';

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
    this.pitch = ROBOT.defaultPitch;
    this.roll = ROBOT.defaultRoll;
    this.gripClosed = false;
    this.grip = data.qpos[this.sim.qposAdr(ROBOT.gripperJoint)];
    this.ikError = 0;
  }

  // v: [vx, vy, vz] m/s in world frame, pitchRate / rollRate rad/s, dt seconds.
  command({ v = [0, 0, 0], pitchRate = 0, rollRate = 0 }, dt) {
    const t = this.target;
    for (let i = 0; i < 3; i++) t[i] += v[i] * dt;
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

  // Called once per physics step block: run IK and write servo targets.
  apply(dt) {
    const g = ROBOT.gripper, goal = this.gripClosed ? g.closed : g.open;
    const step = g.speed * dt;
    this.grip += Math.max(-step, Math.min(step, goal - this.grip));
    this.ikError = this.ik.solve(this.q, this.target, this.pitch, this.roll);
    const ctrl = this.sim.data.ctrl;
    for (let i = 0; i < 4; i++) ctrl[this.act[i]] = this.q[i];
    ctrl[this.act[4]] = this.roll;
    ctrl[this.act[5]] = this.grip;
  }
}
