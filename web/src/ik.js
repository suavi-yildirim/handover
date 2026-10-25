// End-effector IK for a 4-joint arm (+ directly driven wrist roll).
// Damped least squares on a 6-row task: grasp-point position, plus the gripper's
// pointing direction (weighted lower so position wins when both can't be met).
import { ROBOT } from './robot.js';

const LAMBDA = 0.02;      // damping
const ROT_WEIGHT = 0.3;   // pointing error weight relative to position (1 rad ~ 0.3 m)

export class ArmIK {
  constructor(sim) {
    const { mj, model } = sim;
    this.sim = sim;
    this.kin = new mj.MjData(model); // scratch data for kinematics at the commanded pose
    this.site = sim.id('SITE', ROBOT.eeSite);
    this.body = model.site_bodyid[this.site];
    this.joints = ROBOT.armJoints.map((n) => sim.id('JOINT', n));
    this.qadr = this.joints.map((j) => model.jnt_qposadr[j]);
    this.dadr = this.joints.map((j) => model.jnt_dofadr[j]);
    this.range = this.joints.map((j) => [model.jnt_range[2 * j], model.jnt_range[2 * j + 1]]);
    this.jacp = new mj.DoubleBuffer(3 * model.nv);
    this.jacr = new mj.DoubleBuffer(3 * model.nv);
  }

  // World position of the grasp point: the end-effector site shifted by ROBOT.graspOffset
  // (expressed in the site frame).
  graspPoint(data) {
    const o = ROBOT.graspOffset, s = this.site;
    const p = data.site_xpos.subarray(3 * s, 3 * s + 3), R = data.site_xmat.subarray(9 * s, 9 * s + 9);
    return [0, 1, 2].map((i) => p[i] + R[3 * i] * o[0] + R[3 * i + 1] * o[1] + R[3 * i + 2] * o[2]);
  }

  // Unit vector the gripper should point along: yaw toward the target, pitched down.
  targetDir(pos, pitch) {
    const yaw = Math.atan2(pos[1] - ROBOT.panOrigin[1], pos[0] - ROBOT.panOrigin[0]);
    const c = Math.cos(pitch);
    return [c * Math.cos(yaw), c * Math.sin(yaw), -Math.sin(pitch)];
  }

  // Refine joint command q (length 4, modified in place) toward the target.
  // Returns the remaining position error in meters.
  solve(q, pos, pitch, roll, iters = 6) {
    const { mj, model } = this.sim;
    const kin = this.kin, n = q.length, nv = model.nv;
    const tdir = this.targetDir(pos, pitch);
    kin.qpos.set(this.sim.data.qpos);
    kin.qpos[model.jnt_qposadr[this.sim.id('JOINT', ROBOT.rollJoint)]] = roll;
    let err = 0;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) kin.qpos[this.qadr[i]] = q[i];
      mj.mj_kinematics(model, kin);
      mj.mj_comPos(model, kin);
      const p = this.graspPoint(kin);
      mj.mj_jac(model, kin, this.jacp, this.jacr, p, this.body);
      const jp = this.jacp.GetView(), jr = this.jacr.GetView();
      const R = kin.site_xmat.subarray(9 * this.site, 9 * this.site + 9);
      const x = [R[0], R[3], R[6]]; // site x axis in world
      const e = [
        pos[0] - p[0], pos[1] - p[1], pos[2] - p[2],
        ROT_WEIGHT * (x[1] * tdir[2] - x[2] * tdir[1]),
        ROT_WEIGHT * (x[2] * tdir[0] - x[0] * tdir[2]),
        ROT_WEIGHT * (x[0] * tdir[1] - x[1] * tdir[0]),
      ];
      err = Math.hypot(e[0], e[1], e[2]);
      // J: 6 x n, rows 0-2 position, 3-5 weighted rotation.
      const J = [];
      for (let r = 0; r < 6; r++) {
        const src = r < 3 ? jp : jr, w = r < 3 ? 1 : ROT_WEIGHT, row = r % 3;
        J.push(this.dadr.map((d) => w * src[row * nv + d]));
      }
      // Solve (J^T J + lambda^2 I) dq = J^T e.
      const A = [], b = [];
      for (let i = 0; i < n; i++) {
        A.push([]);
        let bi = 0;
        for (let r = 0; r < 6; r++) bi += J[r][i] * e[r];
        b.push(bi);
        for (let k = 0; k < n; k++) {
          let s = i === k ? LAMBDA * LAMBDA : 0;
          for (let r = 0; r < 6; r++) s += J[r][i] * J[r][k];
          A[i].push(s);
        }
      }
      const dq = solveLinear(A, b);
      for (let i = 0; i < n; i++) {
        q[i] = Math.min(this.range[i][1], Math.max(this.range[i][0], q[i] + dq[i]));
      }
    }
    return err;
  }
}

// Gaussian elimination with partial pivoting for small dense systems.
function solveLinear(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}
