// Scene randomization for "messy kitchen" play and automatic demos.
//
// A scene is a small plain-JSON object (see sampleScene) that says where the movable things
// are and how slippery, heavy and bright they are. applyScene writes it into the compiled
// model, always relative to the model's original values, so applying scenes one after the
// other never accumulates. The scene is stored in every episode ("scene" and "scene_seed"),
// because friction, mass, the tray position and the lights are not part of qpos and an
// offline renderer needs them to reproduce the episode.
//
// Where things may go comes from the reach map (tests/reach_map.mjs): a level SO-101 gripper
// reaches the table only 28 cm or more from the shoulder, and the game's workspace stops at
// 36 cm (robot.js), so every object that has to be grasped sits 30 to 35.5 cm from the
// shoulder axis, at an angle within the pan range, and the placement targets are there too.
import { ROBOT } from './robot.js';

const DEG = Math.PI / 180;
const PROPS = ['cup', 'pill_bottle', 'glasses_case'];
// Loose extras (YCB mug, fork, spoon) that are only there to make the table look lived in.
// They are placed in table corners where no task needs to reach, if the level has them.
const CLUTTER = ['mug', 'fork', 'spoon'];
// Table-frame boxes [x0, x1, y0, y1] (the table spans x -0.20..0.50, y -0.45..0.45).
const CLUTTER_ZONES = [
  [0.40, 0.50, 0.00, 0.45], [0.40, 0.50, -0.45, -0.25], // right edge
  [-0.20, 0.00, 0.10, 0.45],                           // back left
  [-0.20, 0.00, -0.45, -0.20],                         // front left
];
// Length and width of each extra (m), so none overhangs the table edge at any angle.
const CLUTTER_SIZE = { mug: [0.117, 0.093], fork: [0.198, 0.027], spoon: [0.186, 0.083] };
const TABLE = { x: [-0.20, 0.50], y: [-0.45, 0.45] };
const EDGE_MARGIN = 0.04; // the origin of a mesh is not its middle
const CLUTTER_MIN_R = 0.38; // m from the shoulder: farther than the arm grasps, so never in the way
// Polar regions around the shoulder: radius in meters, angle in degrees from the +x axis.
// A radius range of 0.30 to 0.355 keeps the grasp point inside the reachable ring; the glasses
// case is gripped at its near end, 4 cm closer, so its center sits a little farther out.
export const REGIONS = {
  cup: { r: [0.30, 0.35], a: [-15, 55] },
  pill_bottle: { r: [0.30, 0.35], a: [-30, 40] },
  glasses_case: { r: [0.335, 0.355], a: [52, 66] }, // stays in the red edge strip (y > 0.25)
  tray: { r: [0.31, 0.34], a: [-65, -12] },
  safe_zone: { r: [0.30, 0.34], a: [-72, -40] },
  hand_zone: { r: [0.27, 0.33], a: [25, 65], z: [0.10, 0.14] },
};
// Keep-out distances between centers (meters). Rectangles (tray, safe zone) use half sizes.
const CLEAR = { cup: 0.05, pill_bottle: 0.045, glasses_case: 0.08 };
const RECT = { tray: [0.07, 0.055], safe_zone: [0.06, 0.05] };
const RANGE = {
  friction: { prop: [0.28, 0.55], table: [0.30, 0.50], jaw: [0.30, 0.60] },
  mass: [0.8, 1.3],
  light: [0.6, 1.3],
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x) => Math.round(x * 1e4) / 1e4;
const polar = (r, a) => [ROBOT.panOrigin[0] + r * Math.cos(a * DEG), ROBOT.panOrigin[1] + r * Math.sin(a * DEG)];

// Distance from a point to an axis-aligned rectangle (0 inside).
function rectDistance(p, c, half) {
  const dx = Math.max(Math.abs(p[0] - c[0]) - half[0], 0), dy = Math.max(Math.abs(p[1] - c[1]) - half[1], 0);
  return Math.hypot(dx, dy);
}

// Cup yaw. The handle is on the cup's local +y side. With the jaws coming down around the cup,
// a handle pointing sideways-and-back (about 95 to 145 degrees off the outward direction, either
// way) catches a jaw (tests/scene_check.mjs shows it), so those cups are not generated.
// The handle may point outward, inward or along the table within these limits.
function cupYaw(p, u) {
  const rel = u(0, 1) < 0.8 ? u(-90, 90) : (u(0, 1) < 0.5 ? 1 : -1) * u(150, 180);
  const radial = Math.atan2(p[1] - ROBOT.panOrigin[1], p[0] - ROBOT.panOrigin[0]);
  return radial + (rel - 90) * DEG;
}

// A fresh random scene from a seed (same seed, same scene). Object positions are rejection
// sampled so nothing overlaps; if that fails the standard layout positions are used.
export function sampleScene(seed) {
  const rnd = mulberry32(seed), u = (lo, hi) => lo + (hi - lo) * rnd();
  const pick = (name) => {
    const g = REGIONS[name];
    return polar(u(...g.r), u(...g.a));
  };
  for (let attempt = 0; attempt < 400; attempt++) {
    const pos = Object.fromEntries(Object.keys(REGIONS).map((n) => [n, pick(n)]));
    let ok = true;
    for (let i = 0; i < PROPS.length && ok; i++) {
      for (let j = i + 1; j < PROPS.length && ok; j++) {
        const need = CLEAR[PROPS[i]] + CLEAR[PROPS[j]];
        if (Math.hypot(pos[PROPS[i]][0] - pos[PROPS[j]][0], pos[PROPS[i]][1] - pos[PROPS[j]][1]) < need) ok = false;
      }
      for (const rect of Object.keys(RECT)) {
        if (rectDistance(pos[PROPS[i]], pos[rect], RECT[rect]) < CLEAR[PROPS[i]]) ok = false;
      }
    }
    // The tray and the safe zone are both drawn on the table; keep them apart.
    if (ok && Math.hypot(pos.tray[0] - pos.safe_zone[0], pos.tray[1] - pos.safe_zone[1]) < 0.17) ok = false;
    if (!ok) continue;
    const caseAngle = Math.atan2(pos.glasses_case[1], pos.glasses_case[0] - ROBOT.panOrigin[0]);
    return {
      seed,
      objects: {
        cup: { x: round(pos.cup[0]), y: round(pos.cup[1]), yaw: round(cupYaw(pos.cup, u)) },
        pill_bottle: { x: round(pos.pill_bottle[0]), y: round(pos.pill_bottle[1]), yaw: round(u(-Math.PI, Math.PI)) },
        // Long side points at the robot, like the standard layout, give or take 15 degrees.
        glasses_case: { x: round(pos.glasses_case[0]), y: round(pos.glasses_case[1]), yaw: round(caseAngle + u(-15, 15) * DEG) },
      },
      tray: { x: round(pos.tray[0]), y: round(pos.tray[1]) },
      safe_zone: { x: round(pos.safe_zone[0]), y: round(pos.safe_zone[1]) },
      hand_zone: { x: round(pos.hand_zone[0]), y: round(pos.hand_zone[1]), z: round(u(...REGIONS.hand_zone.z)) },
      friction: { prop: round(u(...RANGE.friction.prop)), table: round(u(...RANGE.friction.table)), jaw: round(u(...RANGE.friction.jaw)) },
      mass: Object.fromEntries(PROPS.map((n) => [n, round(u(...RANGE.mass))])),
      light: round(u(...RANGE.light)),
      clutter: sampleClutter(u, pos),
    };
  }
  return { ...defaultScene(), seed };
}

// Mug, fork and spoon in the table corners, apart from each other and from the task objects.
function sampleClutter(u, task) {
  const placed = [], out = {};
  for (const name of CLUTTER) {
    for (let tries = 0; tries < 600; tries++) {
      const z = CLUTTER_ZONES[Math.floor(u(0, CLUTTER_ZONES.length))] ?? CLUTTER_ZONES[0];
      const p = [u(z[0], z[1]), u(z[2], z[3])], yaw = u(-Math.PI, Math.PI);
      const [len, wid] = CLUTTER_SIZE[name];
      const ex = (Math.abs(Math.cos(yaw)) * len + Math.abs(Math.sin(yaw)) * wid) / 2 + EDGE_MARGIN;
      const ey = (Math.abs(Math.sin(yaw)) * len + Math.abs(Math.cos(yaw)) * wid) / 2 + EDGE_MARGIN;
      if (p[0] - ex < TABLE.x[0] || p[0] + ex > TABLE.x[1] || p[1] - ey < TABLE.y[0] || p[1] + ey > TABLE.y[1]) continue;
      if (Math.hypot(p[0] - ROBOT.panOrigin[0], p[1] - ROBOT.panOrigin[1]) < CLUTTER_MIN_R) continue;
      if (placed.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.12)) continue;
      if (Object.values(task).some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.12)) continue;
      placed.push(p);
      out[name] = { x: round(p[0]), y: round(p[1]), yaw: round(yaw) };
      break;
    }
  }
  return out;
}

// The hand-placed layout from kitchen.xml, expressed as a scene (scale factors all 1).
export function defaultScene() {
  return {
    seed: null,
    objects: {
      cup: { x: 0.33, y: 0.11, yaw: 0 },
      pill_bottle: { x: 0.34, y: -0.03, yaw: 0 },
      glasses_case: { x: 0.22, y: 0.30, yaw: 1.027441 },
    },
    tray: { x: 0.32, y: -0.17 },
    safe_zone: { x: 0.12, y: -0.31 },
    hand_zone: { x: 0.12, y: 0.28, z: 0.12 },
    friction: null, // keep the model's own values
    mass: { cup: 1, pill_bottle: 1, glasses_case: 1 },
    light: 1,
    clutter: {
      mug: { x: 0.42, y: 0.30, yaw: 0 },
      fork: { x: 0.46, y: 0.00, yaw: Math.PI / 2 },
      spoon: { x: 0.05, y: -0.12, yaw: 0 },
    },
  };
}

const bases = new WeakMap();

// Id of a named thing, or -1 (sim.id throws when it is missing).
function mj_name2id(sim, type, name) {
  return sim.mj.mj_name2id(sim.model, sim.mj.mjtObj[`mjOBJ_${type}`].value, name);
}

// The model's original values for everything a scene can change.
function baseOf(sim) {
  if (bases.has(sim)) return bases.get(sim);
  const { model } = sim;
  const propBodies = Object.fromEntries(PROPS.map((n) => [n, sim.id('BODY', n)]));
  const present = CLUTTER.filter((n) => mj_name2id(sim, 'BODY', n) >= 0);
  const clutterBodies = Object.fromEntries(present.map((n) => [n, sim.id('BODY', n)]));
  const propGeoms = [];
  const jawGeoms = [];
  const tableGeom = sim.id('GEOM', 'table_top');
  for (let g = 0; g < model.ngeom; g++) {
    const b = model.geom_bodyid[g];
    if (Object.values(propBodies).includes(b) || Object.values(clutterBodies).includes(b)) propGeoms.push(g);
    else if (model.geom_priority[g] > 0 && model.geom_friction[3 * g] > 0.39 && model.geom_friction[3 * g] < 0.41) jawGeoms.push(g);
  }
  const frictionOf = (g) => model.geom_friction[3 * g];
  const base = {
    propBodies, clutter: present, propGeoms, jawGeoms, tableGeom,
    frictions: Object.fromEntries([...propGeoms, ...jawGeoms, tableGeom].map((g) => [g, frictionOf(g)])),
    mass: Object.fromEntries(PROPS.map((n) => [n, model.body_mass[propBodies[n]]])),
    inertia: Object.fromEntries(PROPS.map((n) => [n, Array.from(model.body_inertia.subarray(3 * propBodies[n], 3 * propBodies[n] + 3))])),
    tray: sim.id('BODY', 'tray'),
    safe: sim.id('GEOM', 'safe_zone'),
    hand: sim.id('SITE', 'hand_zone'),
    lights: Array.from({ length: model.nlight }, (_, l) => Array.from(model.light_diffuse.subarray(3 * l, 3 * l + 3))),
  };
  bases.set(sim, base);
  return base;
}

// Write a scene into the model and the current state (call after sim.reset). Returns the scene.
export function applyScene(sim, scene) {
  const { model, data, mj } = sim, base = baseOf(sim);
  for (const name of PROPS) {
    const o = scene.objects[name], adr = sim.qposAdr(`${name}_free`);
    const q = [o.x, o.y, 0, Math.cos(o.yaw / 2), 0, 0, Math.sin(o.yaw / 2)];
    for (let i = 0; i < 7; i++) data.qpos[adr + i] = q[i];
    const dof = model.jnt_dofadr[sim.id('JOINT', `${name}_free`)];
    for (let i = 0; i < 6; i++) data.qvel[dof + i] = 0;
    const s = scene.mass[name], b = base.propBodies[name];
    model.body_mass[b] = base.mass[name] * s;
    for (let i = 0; i < 3; i++) model.body_inertia[3 * b + i] = base.inertia[name][i] * s;
  }
  // Clutter bodies (when the level has them): a scene without a clutter entry leaves them be.
  for (const name of base.clutter) {
    const o = scene.clutter?.[name];
    if (!o) continue;
    const adr = sim.qposAdr(`${name}_free`);
    const q = [o.x, o.y, 0, Math.cos(o.yaw / 2), 0, 0, Math.sin(o.yaw / 2)];
    for (let i = 0; i < 7; i++) data.qpos[adr + i] = q[i];
  }
  const set3 = (arr, i, v) => { for (let k = 0; k < 3; k++) arr[3 * i + k] = v[k]; };
  set3(model.body_pos, base.tray, [scene.tray.x, scene.tray.y, 0]);
  set3(model.geom_pos, base.safe, [scene.safe_zone.x, scene.safe_zone.y, 0.0005]);
  set3(model.site_pos, base.hand, [scene.hand_zone.x, scene.hand_zone.y, scene.hand_zone.z]);
  const f = scene.friction;
  for (const g of base.propGeoms) model.geom_friction[3 * g] = f ? f.prop : base.frictions[g];
  for (const g of base.jawGeoms) model.geom_friction[3 * g] = f ? f.jaw : base.frictions[g];
  model.geom_friction[3 * base.tableGeom] = f ? f.table : base.frictions[base.tableGeom];
  base.lights.forEach((d, l) => { for (let k = 0; k < 3; k++) model.light_diffuse[3 * l + k] = d[k] * scene.light; });
  mj.mj_forward(model, data);
  return scene;
}

// sim.reset() followed by a scene: the standard layout when scene is null.
export function resetScene(sim, scene = null) {
  sim.reset();
  return applyScene(sim, scene || defaultScene());
}
