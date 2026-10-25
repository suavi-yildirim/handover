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

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildGeoms() {
    const { model } = this.sim;
    this.geoms = [];
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
      if (fixed) setPose(mesh, this.sim.data.geom_xpos.subarray(3 * g, 3 * g + 3), this.sim.data.geom_xmat.subarray(9 * g, 9 * g + 9));
      mesh.castShadow = model.geom_type[g] !== GEOM.PLANE && rgba[3] >= 1;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      if (!fixed) this.geoms.push([g, mesh]);
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Horizontal forward/right unit vectors of the camera, for camera-relative controls.
  groundAxes() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.z = 0;
    if (f.lengthSq() < 1e-8) f.set(1, 0, 0);
    f.normalize();
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
    this.renderer.render(this.scene, this.camera);
  }
}
