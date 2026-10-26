"""Convert YCB scanned objects into MuJoCo collision hulls for the kitchen level.

Usage (from the repo root, after extracting the YCB *_google_16k.tgz archives into DIR):
    python3 tools/object_hulls.py DIR > web/models/kitchen/objects_ycb.xml

Each object is split into convex pieces that MuJoCo can use as collision geoms:
  - hollow objects (mug) are cut into angular sectors around their axis, so
    the cavity stays open; each sector is one convex hull;
  - long thin objects (fork, spoon) are cut into slabs along their length.
Hulls are inline <mesh vertex="..."> entries, so no extra files are needed. The mass is
an estimate (see MASS below) and the inertia comes from the hull geometry, scaled to that
mass. Replace MASS with weighed values when the real objects are measured.

Source meshes: YCB Object and Model Set, CC BY 4.0 (https://www.ycbbenchmarks.com/).
"""
import glob
import os
import sys

import numpy as np
import trimesh

# Estimated real masses in kg. A ceramic mug weighs a few hundred grams; cutlery about 30-40 g.
# Weigh the real items to replace these.
MASS = {"025_mug": 0.30, "030_fork": 0.035, "031_spoon": 0.03}
SECTORS = 8         # angular cuts for hollow objects
SLABS = 8           # cuts along the length for cutlery (4 or 12 left spoon and fork rocking)
MAX_POINTS = 64     # points per hull; 32 left the fork tilted 3.5 deg, 64 settles it flat and runs fast enough in the browser

# Each object: its name in the MJCF, the cut mode, and the colour of its visual.
OBJECTS = {
    "025_mug": ("mug", "sectors", "0.93 0.93 0.91 1"),
    "030_fork": ("fork", "slabs", "0.72 0.73 0.75 1"),
    "031_spoon": ("spoon", "slabs", "0.72 0.73 0.75 1"),
}


def load(dir_, key):
    path = glob.glob(os.path.join(dir_, key, key, "google_16k", "nontextured.stl"))[0]
    mesh = trimesh.load(path, force="mesh")
    # Sit the object on z = 0 and centre it in x and y on its bounding box.
    lo, hi = mesh.bounds
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    return mesh


def pieces(mesh, mode):
    v = mesh.vertices
    if mode == "sectors":
        ang = np.arctan2(v[:, 1], v[:, 0])
        bins = np.linspace(-np.pi, np.pi, SECTORS + 1)
        groups = [v[(ang >= a) & (ang < b)] for a, b in zip(bins[:-1], bins[1:])]
    else:
        x = v[:, 0]
        edges = np.linspace(x.min(), x.max() + 1e-9, SLABS + 1)
        groups = [v[(x >= a) & (x < b)] for a, b in zip(edges[:-1], edges[1:])]
    hulls = []
    for g in groups:
        if len(g) < 4:
            continue
        if len(g) > MAX_POINTS:
            g = g[np.linspace(0, len(g) - 1, MAX_POINTS).astype(int)]  # evenly spaced, so the output is repeatable
        try:
            h = trimesh.convex.convex_hull(g)
        except Exception:
            continue
        if h.is_volume and h.volume > 1e-9:
            hulls.append(h)
    return hulls


def mass_properties(hulls, mass):
    """Centre of mass and diagonal inertia of the hull union, scaled to the target mass."""
    vols = np.array([h.volume for h in hulls])
    cents = np.array([h.center_mass for h in hulls])
    total = vols.sum()
    com = (vols[:, None] * cents).sum(0) / total
    inertia = np.zeros(3)
    for h, vol in zip(hulls, vols):
        I = h.moment_inertia  # about the hull's own centre of mass, per unit density
        d = h.center_mass - com
        I = I + vol * (np.dot(d, d) * np.eye(3) - np.outer(d, d))
        inertia += np.diag(I)
    inertia = inertia / total * mass
    return com, inertia


def mesh_xml(name, h):
    verts = np.round(h.vertices, 5).ravel()
    return f'    <mesh name="{name}" vertex="' + " ".join(f"{x:.5f}" for x in verts) + '"/>'


def main(dir_):
    assets, bodies = [], []
    for key, (name, mode, rgba) in OBJECTS.items():
        mesh = load(dir_, key)
        hulls = pieces(mesh, mode)
        mass = MASS[key]
        com, inertia = mass_properties(hulls, mass)
        assets += [mesh_xml(f"{name}_{i}", h) for i, h in enumerate(hulls)]
        geoms = "\n".join(
            f'      <geom name="{name}_{i}" type="mesh" mesh="{name}_{i}" material="{name}_m" class="prop" mass="0"/>'
            for i in range(len(hulls)))
        assets.append(f'    <material name="{name}_m" rgba="{rgba}"/>')
        ext = mesh.bounds[1] - mesh.bounds[0]
        bodies.append(
            f'    <!-- {name}: YCB {key}, {ext[0]*100:.1f} x {ext[1]*100:.1f} x {ext[2]*100:.1f} cm, '
            f'{len(hulls)} convex pieces, mass {mass*1000:.0f} g (estimate). -->\n'
            f'    <body name="{name}" pos="0 0 0">\n'
            f'      <freejoint name="{name}_free"/>\n'
            f'      <inertial pos="{com[0]:.4f} {com[1]:.4f} {com[2]:.4f}" mass="{mass}" '
            f'diaginertia="{inertia[0]:.3e} {inertia[1]:.3e} {inertia[2]:.3e}"/>\n'
            f"{geoms}\n"
            f"    </body>")
    print('<mujoco model="kitchen_objects_ycb">')
    print("  <!-- Standard kitchen objects from the YCB Object and Model Set (CC BY 4.0,\n"
          "       https://www.ycbbenchmarks.com/). Hulls generated by tools/object_hulls.py. -->")
    print("  <asset>")
    print("\n".join(assets))
    print("  </asset>")
    print("  <worldbody>")
    print("\n".join(bodies))
    print("  </worldbody>")
    print("</mujoco>")


if __name__ == "__main__":
    main(sys.argv[1])
