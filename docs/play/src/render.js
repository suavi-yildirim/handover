// three.js view of a MuJoCo model. Geometry is built once from the model; each
// frame only copies world poses (geom_xpos / geom_xmat) from the simulation.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { materialFor, setupRenderer, addLights, bakeEnvironment } from './look.js';

const GEOM = { PLANE: 0, HFIELD: 1, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };
const VISIBLE_GROUPS = new Set([0, 1, 2]); // groups 3+ are collision-only in the SO-101 model

function geometryFor(model, g) {
  const s = model.geom_size.subarray(3 * g, 3 * g + 3);
  switch (model.geom_type[g]) {
    case GEOM.PLANE: return new THREE.PlaneGeometry(2 * (s[0] || 50), 2 * (s[1] || 50));
    case GEOM.SPHERE: return new THREE.SphereGeometry(s[0], 24, 16);
    case GEOM.ELLIPSOID: return new THREE.SphereGeometry(1, 24, 16).scale(s[0], s[1], s[2]);
    case GEOM.BOX: return new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
    case GEOM.CYLINDER: return new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 32).rotateX(Math.PI / 2);
    case GEOM.CAPSULE: return new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 16).rotateX(Math.PI / 2);
    case GEOM.MESH: return meshGeometry(model, model.geom_dataid[g]);
    default: return null;
  }
}

function meshGeometry(model, id) {
  const va = model.mesh_vertadr[id], vn = model.mesh_vertnum[id];
  const fa = model.mesh_faceadr[id], fn = model.mesh_facenum[id];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(model.mesh_vert.slice(3 * va, 3 * (va + vn)), 3));
  geo.setIndex(new THREE.BufferAttribute(model.mesh_face.slice(3 * fa, 3 * (fa + fn)), 1));
  const flat = geo.toNonIndexed(); // faceted normals read better on CAD meshes
  flat.computeVertexNormals();
  return flat;
}

function colorOf(model, g) {
  const mat = model.geom_matid[g];
  const c = mat >= 0 ? model.mat_rgba.subarray(4 * mat, 4 * mat + 4) : model.geom_rgba.subarray(4 * g, 4 * g + 4);
  return [c[0], c[1], c[2], c[3]];
}

function material([r, g, b, a]) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b), roughness: 0.65, metalness: 0.05,
    transparent: a < 1, opacity: a, depthWrite: a >= 1,
  });
}

function setPose(obj, pos, mat) {
  obj.matrix.set(
    mat[0], mat[1], mat[2], pos[0],
    mat[3], mat[4], mat[5], pos[1],
    mat[6], mat[7], mat[8], pos[2],
    0, 0, 0, 1,
  );
}

const ROOM_LAYER = 1;

// Orthographic helper views. center/half: the visible window (m) in view coordinates
// (horizontal, vertical); far clips away what lies behind the table. The front view sits
// under the task panel, so its window is shifted to show the robot right of the panel.
const ORTHO_VIEWS = [
  { label: 'Top', pos: [0.17, 0, 0.7], look: [0.17, 0, 0], up: [1, 0, 0], far: 0.75, center: [0, 0.04], half: 0.27 },
  { label: 'Front (from behind the robot)', pos: [-0.45, 0, 0.15], look: [0, 0, 0.15], up: [0, 0, 1], far: 1.05, center: [-0.14, -0.03], half: 0.2 },
  { label: 'Side (robot facing right)', pos: [0.17, -0.6, 0.15], look: [0.17, 0, 0.15], up: [0, 0, 1], far: 1.2, center: [0, -0.03], half: 0.2 },
];

export class Renderer {
  constructor(canvas, sim) {
    this.sim = sim;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    setupRenderer(r);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color().setRGB(0.93, 0.92, 0.9, THREE.SRGBColorSpace);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 20);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-0.32, -0.30, 0.45);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0.2, 0, 0.0);
    this.controls.enableKeys = false;
    this.controls.update();

    addLights(scene, sim.model, sim.data); // the level's own MJCF lights

    this.buildGeoms();
    this.buildSites();

    // The point the player is steering: a small ring + dot under the gripper.
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.8, depthTest: false }));
    this.marker.renderOrder = 10;
    this.shadowDot = new THREE.Mesh(new THREE.RingGeometry(0.008, 0.012, 24),
      new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.6 }));
    scene.add(this.marker, this.shadowDot);

    // Wrist camera picture-in-picture: what the gripper's own camera (wrist_cam, the
    // dataset's observation.images.wrist) sees, for lining up grasps. MuJoCo and three.js
    // cameras both look along their local -z with +y up, so the pose copies over directly.
    this.wristCam = sim.id('CAMERA', 'wrist_cam');
    this.showWrist = this.wristCam >= 0;
    if (this.showWrist) {
      const fovy = sim.model.cam_fovy[this.wristCam];
      this.wrist = new THREE.PerspectiveCamera(fovy, 4 / 3, 0.005, 10); // 640 x 480 sensor
      this.wrist.matrixAutoUpdate = false;
    }

    // Orthographic helper views for the 4-view layout (like a CAD drawing): top, front and
    // side, each looking at the table with the room hidden. They only help the player see
    // where the gripper is; the dataset cameras live in the MJCF and are not affected.
    this.camera.layers.enable(ROOM_LAYER);
    if (this.wrist) this.wrist.layers.enable(ROOM_LAYER);
    this.ortho = ORTHO_VIEWS.map((v) => {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, v.far);
      cam.up.set(...v.up);
      cam.position.set(...v.pos);
      cam.lookAt(...v.look);
      return { ...v, cam };
    });
    this.layout = 'single'; // 'single' | 'quad'

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // Viewport rectangles (CSS pixels, y from the bottom) for the current layout.
  // Quad layout: front view top-left, top view top-right, 3D view bottom-left, side view
  // bottom-right.
  views() {
    const { W, H } = this.size();
    if (this.layout !== 'quad') return [{ cam: this.camera, x: 0, y: 0, w: W, h: H }];
    const w = Math.floor(W / 2), h = Math.floor(H / 2);
    const [top, front, side] = this.ortho;
    return [
      { ...front, x: 0, y: H - h, w, h },
      { ...top, x: W - w, y: H - h, w, h },
      { cam: this.camera, label: '3D view (drag to orbit)', x: 0, y: 0, w, h },
      { ...side, x: W - w, y: 0, w, h },
    ];
  }

  // The wrist inset shows in the single-view layout only (C toggles it there).
  get wristVisible() { return this.showWrist && this.layout !== 'quad'; }

  size() {
    const c = this.renderer.domElement;
    return { W: c.clientWidth || window.innerWidth, H: c.clientHeight || window.innerHeight };
  }

  // Corner rectangle of the wrist view in CSS pixels (x, y from the bottom-left).
  wristRect() {
    const { W, H } = this.size();
    const w = Math.round(Math.min(320, 0.32 * W)), h = Math.round(w * 0.75);
    // Bottom-left on wide screens; top-right on phones, where the task panel sits at the bottom.
    let x = 16, y = 56;
    if (W < 700) { x = W - w - 16; y = H - h - 16; }
    return { x, y, w, h, top: H - y - h };
  }

  buildGeoms() {
    const { model } = this.sim;
    this.geoms = [];
    this.fixedGeoms = []; // welded to the world: posed once, again by refreshFixed()
    const roomBodies = new Set([this.sim.id('BODY', 'kitchen_room')].filter((b) => b >= 0));
    const floor = this.sim.id('GEOM', 'floor');
    for (let g = 0; g < model.ngeom; g++) {
      if (!VISIBLE_GROUPS.has(model.geom_group[g])) continue;
      const rgba = colorOf(model, g);
      if (rgba[3] === 0) continue;
      const geo = geometryFor(model, g);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, materialFor(model, g));
      mesh.matrixAutoUpdate = false;
      // Geoms welded to the world (walls, furniture) never move: pose them once.
      const fixed = model.body_weldid[model.geom_bodyid[g]] === 0;
      if (fixed) {
        setPose(mesh, this.sim.data.geom_xpos.subarray(3 * g, 3 * g + 3), this.sim.data.geom_xmat.subarray(9 * g, 9 * g + 9));
        this.fixedGeoms.push([g, mesh]);
      }
      mesh.castShadow = model.geom_type[g] !== GEOM.PLANE && rgba[3] >= 1;
      mesh.receiveShadow = true;
      // The room (walls, cabinets, floor) is hidden in the orthographic helper views.
      if (roomBodies.has(model.body_rootid[model.geom_bodyid[g]]) || g === floor) mesh.layers.set(ROOM_LAYER);
      this.scene.add(mesh);
      if (!fixed) this.geoms.push([g, mesh]);
    }
  }

  // Pose the fixed geoms again, after a scene moved the tray or the table zones.
  refreshFixed() {
    const { data } = this.sim;
    for (const [g, mesh] of this.fixedGeoms) {
      setPose(mesh, data.geom_xpos.subarray(3 * g, 3 * g + 3), data.geom_xmat.subarray(9 * g, 9 * g + 9));
    }
  }

  // Only decorative sites in group 0 with visible color (e.g. the hand zone).
  buildSites() {
    const { model } = this.sim;
    this.sites = [];
    for (let s = 0; s < model.nsite; s++) {
      const mat = model.site_matid[s];
      const c = mat >= 0 ? model.mat_rgba.subarray(4 * mat, 4 * mat + 4) : model.site_rgba.subarray(4 * s, 4 * s + 4);
      if (model.site_group[s] !== 0 || c[3] === 0 || model.site_type[s] !== GEOM.SPHERE) continue;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(model.site_size[3 * s], 24, 16), material([c[0], c[1], c[2], c[3]]));
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.sites.push([s, mesh]);
    }
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  // Horizontal forward/right unit vectors for camera-relative controls. The camera direction
  // is snapped to the nearest table axis, so W / S always move the gripper straight along the
  // table (not at an angle) and turning the view in 90 degree steps turns the controls with it.
  groundAxes() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.z = 0;
    if (f.lengthSq() < 1e-8) f.set(1, 0, 0);
    if (Math.abs(f.x) >= Math.abs(f.y)) f.set(Math.sign(f.x), 0, 0);
    else f.set(0, Math.sign(f.y), 0);
    return { forward: [f.x, f.y], right: [f.y, -f.x] };
  }

  draw(target) {
    const { data } = this.sim;
    for (const [g, mesh] of this.geoms) {
      setPose(mesh, data.geom_xpos.subarray(3 * g, 3 * g + 3), data.geom_xmat.subarray(9 * g, 9 * g + 9));
    }
    for (const [s, mesh] of this.sites) {
      setPose(mesh, data.site_xpos.subarray(3 * s, 3 * s + 3), data.site_xmat.subarray(9 * s, 9 * s + 9));
    }
    if (target) {
      this.marker.position.set(target[0], target[1], target[2]);
      this.shadowDot.position.set(target[0], target[1], 0.001);
    }
    if (!this.envBaked) { bakeEnvironment(this.renderer, this.scene); this.envBaked = true; }
    this.controls.update();
    const r = this.renderer, size = r.getSize(new THREE.Vector2());
    // Shadow maps are drawn once per frame and shared by all views.
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    const views = this.views();
    r.setScissorTest(views.length > 1);
    for (const v of views) {
      const aspect = v.w / Math.max(1, v.h);
      if (v.cam.isOrthographicCamera) {
        const hh = v.half, hw = hh * aspect, [cx, cy] = v.center;
        Object.assign(v.cam, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
        v.cam.updateProjectionMatrix();
      } else if (Math.abs(v.cam.aspect - aspect) > 1e-6) {
        v.cam.aspect = aspect;
        v.cam.updateProjectionMatrix();
      }
      r.setViewport(v.x, v.y, v.w, v.h);
      r.setScissor(v.x, v.y, v.w, v.h);
      r.render(this.scene, v.cam);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    if (this.wristVisible) {
      const c = this.wristCam;
      setPose(this.wrist, data.cam_xpos.subarray(3 * c, 3 * c + 3), data.cam_xmat.subarray(9 * c, 9 * c + 9));
      this.wrist.updateMatrixWorld(true);
      const { x, y, w, h } = this.wristRect();
      this.marker.visible = this.shadowDot.visible = false;
      r.setScissorTest(true);
      r.setScissor(x, y, w, h);
      r.setViewport(x, y, w, h);
      r.render(this.scene, this.wrist);
      r.setScissorTest(false);
      r.setViewport(0, 0, size.x, size.y);
      this.marker.visible = this.shadowDot.visible = true;
    }
  }
}
