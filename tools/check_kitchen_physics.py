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
MASS_TARGETS = {"cup": 0.060, "pill_bottle": 0.030}
# Expected Coulomb friction against the table top (MuJoCo uses the larger of the two geoms).
MU_TARGET = 0.40
MU_TOL = 0.06

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

    for body, target in MASS_TARGETS.items():
        got = m.body(body).subtreemass[0]
        check(abs(got - target) <= 0.1 * target, f"{body} mass {got*1000:.0f} g (target {target*1000:.0f} g)")

    # 1. Settle for 3 s: objects stay put, upright, and do not sink into the table.
    reset(m, d)
    start = {b: d.body(b).xpos.copy() for b in MASS_TARGETS}
    max_pen = 0.0
    for _ in range(int(3.0 / m.opt.timestep)):
        hold_arm(m, d)
        mujoco.mj_step(m, d)
        for c in d.contact[: d.ncon]:
            b1 = m.body(m.geom_bodyid[c.geom1]).name
            b2 = m.body(m.geom_bodyid[c.geom2]).name
            if {b1, b2} & set(MASS_TARGETS):
                max_pen = max(max_pen, -c.dist)
    for b, p0 in start.items():
        drift = np.linalg.norm(d.body(b).xpos - p0)
        check(drift < 0.003, f"{b} drift after 3 s settle: {drift*1000:.2f} mm")
        check(tilt_deg(d, b) < 2.0, f"{b} upright after settle: tilt {tilt_deg(d, b):.2f} deg")
        check(np.linalg.norm(d.body(b).cvel) < 1e-2, f"{b} at rest after settle")
    check(max_pen < 0.001, f"max object penetration {max_pen*1000:.2f} mm (< 1 mm)")

    # 2. Push test: ramp a horizontal force at the cup's centre of mass until it slides.
    for body in MASS_TARGETS:
        reset(m, d)
        for _ in range(500):
            hold_arm(m, d)
            mujoco.mj_step(m, d)
        bid = m.body(body).id
        mass = m.body(body).subtreemass[0]
        x0 = d.body(body).xpos.copy()
        slide_mu = None
        steps = int(2.0 / m.opt.timestep)
        for i in range(steps):
            mu_now = 1.0 * i / steps
            d.xfrc_applied[bid, :3] = [0, -mu_now * mass * G, 0]  # push sideways (-y), away from the arm
            hold_arm(m, d)
            mujoco.mj_step(m, d)
            if np.linalg.norm(d.body(body).xpos[:2] - x0[:2]) > 0.002:
                slide_mu = mu_now
                break
        d.xfrc_applied[bid] = 0
        tilted = tilt_deg(d, body)
        if slide_mu is None:
            check(False, f"{body} never slid under a push up to mu=1")
        else:
            check(abs(slide_mu - MU_TARGET) < MU_TOL,
                  f"{body} starts sliding at mu={slide_mu:.2f} (target {MU_TARGET}), tilt {tilted:.1f} deg")

    # 3. Speed: the browser runs the same engine as WASM, typically 3-5x slower than native.
    reset(m, d)
    n = 4000
    t = time.perf_counter()
    for _ in range(n):
        hold_arm(m, d)
        mujoco.mj_step(m, d)
    rate = n / (time.perf_counter() - t)
    rt = rate * m.opt.timestep
    check(rt > 20, f"native speed {rate:.0f} steps/s = {rt:.0f}x real time (want > 20x, leaves headroom for WASM)")

    print(f"\n{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
