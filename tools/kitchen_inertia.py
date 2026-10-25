"""Mass and inertia of the hollow task objects in web/models/kitchen.xml.

MuJoCo would treat a cylinder geom as solid. Real cups and pill vials are thin
shells, which puts the centre of mass lower and changes the inertia, so the
bodies carry an explicit <inertial> computed here.  Run: python3 tools/kitchen_inertia.py
"""
import numpy as np


def cylinder(m, r_out, r_in, h, z):
    """Mass, centre height, Ixx and Izz about its own centre for a (hollow) cylinder."""
    return m, z, m * (3 * (r_out**2 + r_in**2) + h**2) / 12, m * (r_out**2 + r_in**2) / 2


def shell(radius, height, wall, base, rho):
    r_in = radius - wall
    wall_h = height - base
    return [
        cylinder(rho * np.pi * radius**2 * base, radius, 0, base, base / 2),
        cylinder(rho * np.pi * (radius**2 - r_in**2) * wall_h, radius, r_in, wall_h, base + wall_h / 2),
    ]


def combine(parts, lateral=()):
    """parts: (m, z, Ixx, Izz) on the axis; lateral: (m, y, z) point masses off the axis."""
    m = sum(p[0] for p in parts) + sum(p[0] for p in lateral)
    z = (sum(p[0] * p[1] for p in parts) + sum(p[0] * p[2] for p in lateral)) / m
    y = sum(p[0] * p[1] for p in lateral) / m
    ixx = sum(p[2] + p[0] * ((p[1] - z) ** 2 + y**2) for p in parts)
    iyy = sum(p[2] + p[0] * (p[1] - z) ** 2 for p in parts)
    izz = sum(p[3] + p[0] * y**2 for p in parts)
    for pm, py, pz in lateral:
        ixx += pm * ((py - y) ** 2 + (pz - z) ** 2)
        iyy += pm * (pz - z) ** 2
        izz += pm * (py - y) ** 2
    return m, y, z, (ixx, iyy, izz)


# Porcelain espresso-size cup: 4 cm across, 7 cm tall, 3 mm walls, 5 mm base, plus a 6 g handle.
cup = combine(shell(0.02, 0.07, 0.003, 0.005, 2300), lateral=[(0.006, 0.024, 0.04)])
# Pharmacy pill vial: 3 cm across, 6 cm, PP 1.2 mm walls; 10 g of tablets in the bottom 2 cm; 3 g cap.
vial = combine(shell(0.015, 0.06, 0.0012, 0.0015, 950) + [cylinder(0.010, 0.0138, 0, 0.02, 0.0115)],
               lateral=[(0.003, 0.0, 0.066)])

for name, (m, y, z, inertia) in [("cup", cup), ("pill_bottle", vial)]:
    print(f'{name}: <inertial pos="0 {y:.3f} {z:.3f}" mass="{m:.3f}" '
          f'diaginertia="{inertia[0]:.1e} {inertia[1]:.1e} {inertia[2]:.1e}"/>')
