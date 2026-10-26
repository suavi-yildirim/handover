"""Physics sanity checks for the Handover kitchen.

Run from the repo root:  python3 tools/check_kitchen_physics.py [path/to/kitchen.xml]

Checks that the task objects have real-world masses, rest stably on the table
without sinking into it, slide at the friction coefficient we intend, and that
the full scene still steps fast enough for the browser. Exits non-zero on failure.
"""
import sys
import time

import mujoco
import numpy as np

MODEL = sys.argv[1] if len(sys.argv) > 1 else "web/models/kitchen.xml"
G = 9.81

# Target masses in kg (see docs/kitchen_realism.md for where they come from).
MASS_TARGETS = {"cup": 0.073, "pill_bottle": 0.020}
# YCB objects (tools/object_hulls.py). Masses are estimates until they are weighed.
YCB_MASS = {"mug": 0.300, "fork": 0.035, "spoon": 0.030}
# Expected Coulomb friction against the table top (MuJoCo uses the larger of the two geoms).
MU_TARGET = 0.40
MU_TOL = 0.06
# Real SO-101 follower torque limits in N.m: 12 V STS3215 stall torque, gripper capped at 50%.
ARM_TORQUE = {"shoulder_pan": 2.94, "shoulder_lift": 2.94, "elbow_flex": 2.94,
              "wrist_flex": 2.94, "wrist_roll": 2.94, "gripper": 1.47}

failures = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok:
        failures.append(msg)


def reset(m, d):
    if m.nkey:
        mujoco.mj_resetDataKeyframe(m, d, 0)
    else:
        mujoco.mj_resetData(m, d)
    mujoco.mj_forward(m, d)


def tilt_deg(d, body):
    z = d.body(body).xmat.reshape(3, 3)[:, 2]
    return np.degrees(np.arccos(np.clip(z[2], -1, 1)))


def hold_arm(m, d):
    # Keep the arm at its keyframe pose so it does not wander into the objects.
    if m.nkey:
        d.ctrl[:] = m.key_ctrl[0] if m.key_ctrl.size else d.ctrl


def main():
    m = mujoco.MjModel.from_xml_path(MODEL)
    d = mujoco.MjData(m)
    print(f"model {MODEL}: nq={m.nq} ngeom={m.ngeom} nbody={m.nbody} timestep={m.opt.timestep}")
    if m.nkey:
        check(m.key_qpos.shape[1] == m.nq, "keyframe qpos length matches the model")

    for body, target in {**MASS_TARGETS, **YCB_MASS}.items():
        got = m.body(body).subtreemass[0]
        check(abs(got - target) <= 0.1 * target, f"{body} mass {got*1000:.0f} g (target {target*1000:.0f} g)")

    # 1. Settle for 3 s: objects stay put, upright, and do not sink into the table.
    reset(m, d)
    start = {b: d.body(b).xpos.copy() for b in {**MASS_TARGETS, **YCB_MASS}}
    max_pen = 0.0
    ycb_pen = {}
    for _ in range(int(3.0 / m.opt.timestep)):
        hold_arm(m, d)
        mujoco.mj_step(m, d)
        for c in d.contact[: d.ncon]:
            b1 = m.body(m.geom_bodyid[c.geom1]).name
            b2 = m.body(m.geom_bodyid[c.geom2]).name
            if {b1, b2} & set(MASS_TARGETS):
                max_pen = max(max_pen, -c.dist)
            for n in YCB_MASS:
                if n in (b1, b2): ycb_pen[n] = max(ycb_pen.get(n, 0.0), -c.dist)
    for b, p0 in start.items():
        drift = np.linalg.norm(d.body(b).xpos - p0)
        check(drift < 0.003, f"{b} drift after 3 s settle: {drift*1000:.2f} mm")
        check(tilt_deg(d, b) < 2.0, f"{b} upright after settle: tilt {tilt_deg(d, b):.2f} deg")
        check(np.linalg.norm(d.body(b).cvel) < 1e-2, f"{b} at rest after settle")
    check(max_pen < 0.001, f"max cup/bottle penetration {max_pen*1000:.2f} mm (< 1 mm)")
    for n, pen in ycb_pen.items():
        # Hull pieces from a scan are softer and less exact than the hand-made primitives.
        check(pen < 0.002, f"{n} penetration {pen*1000:.2f} mm (< 2 mm, scanned hulls)")

    # 2. Push test: a steady sideways push at the centre of mass, just below and just above
    #    the intended friction, must hold the object still and then make it slide (not tip).
    def pushed_distance(body, mu_push, seconds=1.0):
        reset(m, d)
        for _ in range(500):
            hold_arm(m, d)
            mujoco.mj_step(m, d)
        bid = m.body(body).id
        x0 = d.body(body).xpos.copy()
        d.xfrc_applied[bid, :3] = [0, -mu_push * m.body(body).subtreemass[0] * G, 0]  # away from the arm
        for _ in range(int(seconds / m.opt.timestep)):
            hold_arm(m, d)
            mujoco.mj_step(m, d)
        d.xfrc_applied[bid] = 0
        return np.linalg.norm(d.body(body).xpos[:2] - x0[:2]), tilt_deg(d, body)

    for body in MASS_TARGETS:  # the cup and bottle; the YCB objects are checked for settling only
        held, _ = pushed_distance(body, MU_TARGET - MU_TOL)
        moved, tilt = pushed_distance(body, MU_TARGET + MU_TOL)
        check(held < 0.002, f"{body} holds under a push of mu={MU_TARGET - MU_TOL:.2f}: moved {held*1000:.1f} mm")
        check(moved > 0.02 and tilt < 10, f"{body} slides (not tips) under mu={MU_TARGET + MU_TOL:.2f}: "
              f"moved {moved*1000:.0f} mm, tilt {tilt:.1f} deg")

    # 3. Robot strength: torque limits match the real servos, and the arm can hold the
    #    heaviest object anywhere above the table without hitting them.
    limits = {m.actuator(i).name: m.actuator_forcerange[i, 1] for i in range(m.nu)}
    for name, want in ARM_TORQUE.items():
        got = limits.get(name)
        check(got is not None and m.actuator_forcelimited[m.actuator(name).id] and abs(got - want) < 1e-6,
              f"{name} torque limit {got} N.m (real servo: {want})")
    grip = m.body("gripper").id
    m.body_mass[grip] += max(MASS_TARGETS.values())
    mujoco.mj_setConst(m, d)
    rng = np.random.default_rng(0)
    arm = [m.actuator_trnid[m.actuator(n).id, 0] for n in ARM_TORQUE if n != "gripper"]
    worst = 0.0
    for _ in range(5000):
        mujoco.mj_resetData(m, d)
        for j in arm:
            d.qpos[m.jnt_qposadr[j]] = rng.uniform(*m.jnt_range[j])
        mujoco.mj_forward(m, d)
        if d.site("gripperframe").xpos[2] < 0:
            continue
        worst = max(worst, max(abs(d.qfrc_bias[m.jnt_dofadr[j]]) / ARM_TORQUE[m.joint(j).name] for j in arm))
    m.body_mass[grip] -= max(MASS_TARGETS.values())
    mujoco.mj_setConst(m, d)
    check(worst < 0.8, f"holding a {max(MASS_TARGETS.values())*1000:.0f} g object, worst gravity load is "
          f"{worst*100:.0f}% of the torque limit (< 80%)")

    # 4. Speed: the browser runs the same engine as WASM, typically 3-5x slower than native.
    reset(m, d)
    n = 4000
    t = time.perf_counter()
    for _ in range(n):
        hold_arm(m, d)
        mujoco.mj_step(m, d)
    rate = n / (time.perf_counter() - t)
    rt = rate * m.opt.timestep
    check(rt > 10, f"native speed {rate:.0f} steps/s = {rt:.0f}x real time (want > 10x; the browser build measured about 0.14 ms per step, 14.6x real time, and 60 fps needs 8.3 steps per frame)")

    print(f"\n{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
