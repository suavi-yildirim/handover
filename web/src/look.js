// Realistic look for the three.js view: physically based materials from the MJCF
// <material> attributes (including MuJoCo's built-in procedural textures), the
// MJCF <light>s, filmic tone mapping, and reflections of the room itself.
// Visual only: nothing here touches the simulation.
import * as THREE from 'three';

const LIGHT = { SPOT: 0, DIRECTIONAL: 1, POINT: 2 };
const TEXROLE_RGB = 1; // mjTEXROLE_RGB
const GEOM_PLANE = 0;

const textureCache = new Map();

// MJCF colors are authored as sRGB values; tell three.js so they are not washed out.
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function textureOf(model, tex) {
  if (textureCache.has(tex)) return textureCache.get(tex);
  const w = model.tex_width[tex], h = model.tex_height[tex], nc = model.tex_nchannel[tex];
  const src = model.tex_data.subarray(model.tex_adr[tex], model.tex_adr[tex] + w * h * nc);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) rgba[4 * i + c] = src[nc * i + Math.min(c, nc - 1)];
    rgba[4 * i + 3] = nc === 4 ? src[4 * i + 3] : 255;
  }
  const t = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  textureCache.set(tex, t);
  return t;
}

// How many times the texture repeats across the geom's main face.
function textureRepeat(model, g, mat) {
  const rep = model.mat_texrepeat.subarray(2 * mat, 2 * mat + 2);
  if (!model.mat_texuniform[mat]) return [rep[0], rep[1]];
  const s = Array.from(model.geom_size.subarray(3 * g, 3 * g + 3));
  if (model.geom_type[g] === GEOM_PLANE) return [rep[0] * 2 * s[0], rep[1] * 2 * s[1]];
  const [a, b] = s.sort((x, y) => y - x); // the two largest box extents
  return [rep[0] * 2 * a, rep[1] * 2 * b];
}

// Physically based material for geom g, from its MJCF material (or rgba).
export function materialFor(model, g) {
  const mat = model.geom_matid[g];
  const c = mat >= 0 ? model.mat_rgba.subarray(4 * mat, 4 * mat + 4) : model.geom_rgba.subarray(4 * g, 4 * g + 4);
  const opts = {
    color: srgb(c[0], c[1], c[2]),
    transparent: c[3] < 1, opacity: c[3], depthWrite: c[3] >= 1,
    roughness: 0.7, metalness: 0.0,
  };
  if (mat >= 0) {
    // Prefer explicit PBR values; otherwise derive them from MuJoCo's Phong-style attributes.
    const rough = model.mat_roughness?.[mat] ?? -1, metal = model.mat_metallic?.[mat] ?? -1;
    const shin = model.mat_shininess[mat], spec = model.mat_specular[mat], refl = model.mat_reflectance[mat];
    opts.roughness = rough >= 0 ? rough : THREE.MathUtils.clamp(1 - 0.85 * shin, 0.08, 1);
    opts.metalness = metal >= 0 ? metal : (refl >= 0.1 && spec >= 0.7 ? 0.8 : 0);
    const em = model.mat_emission[mat];
    if (em > 0) { opts.emissive = srgb(c[0], c[1], c[2]); opts.emissiveIntensity = em; }
    const roles = model.mat_texid.length / model.nmat;
    const tex = model.mat_texid[mat * roles + (roles > 1 ? TEXROLE_RGB : 0)];
    if (tex >= 0) {
      const t = textureOf(model, tex).clone(); // clone shares the image, own repeat
      t.repeat.set(...textureRepeat(model, g, mat));
      t.needsUpdate = true;
      opts.map = t;
      opts.color = new THREE.Color(1, 1, 1);
    }
  }
  return new THREE.MeshStandardMaterial(opts);
}

// Renderer-wide settings: filmic tone mapping and soft shadows.
export function setupRenderer(renderer) {
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft edges come from shadow.radius
}

// Add the MJCF lights (world poses from data) plus a soft sky/bounce fill.
// Shadow maps are focused on the table, where shadows matter for judging depth.
export function addLights(scene, model, data, focus = [0.15, 0, 0]) {
  scene.add(new THREE.HemisphereLight(srgb(0.85, 0.9, 1.0), srgb(0.55, 0.48, 0.4), 0.9));
  const target = new THREE.Object3D();
  target.position.set(...focus);
  scene.add(target);
  for (let i = 0; i < model.nlight; i++) {
    if (model.light_active && !model.light_active[i]) continue;
    const pos = data.light_xpos.subarray(3 * i, 3 * i + 3), dir = data.light_xdir.subarray(3 * i, 3 * i + 3);
    const d = model.light_diffuse.subarray(3 * i, 3 * i + 3);
    const color = srgb(d[0], d[1], d[2]);
    const type = model.light_type ? model.light_type[i] : (model.light_directional[i] ? LIGHT.DIRECTIONAL : LIGHT.SPOT);
    let light;
    if (type === LIGHT.DIRECTIONAL) {
      light = new THREE.DirectionalLight(color, 3.2);
      // Place it back along its direction, aimed at the table.
      light.position.set(focus[0] - 3 * dir[0], focus[1] - 3 * dir[1], focus[2] - 3 * dir[2]);
      light.target = target;
      Object.assign(light.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.5, far: 6 });
    } else {
      const cutoff = THREE.MathUtils.degToRad(model.light_cutoff[i] || 45);
      light = type === LIGHT.POINT ? new THREE.PointLight(color, 3, 0, 2)
        : new THREE.SpotLight(color, 3.5, 0, Math.min(cutoff, Math.PI / 2 - 0.01), 0.6, 2);
      light.position.set(pos[0], pos[1], pos[2]);
      if (light.isSpotLight) {
        const t = new THREE.Object3D();
        t.position.set(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]);
        scene.add(t);
        light.target = t;
        light.shadow.camera.near = 0.3;
        light.shadow.camera.far = 3;
      }
    }
    if (model.light_castshadow[i]) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.01;
      light.shadow.radius = 3;
    }
    scene.add(light);
  }
}

// Image-based lighting from the room itself, rendered once from above the table, so
// steel, glass and glossy plastic reflect the actual kitchen.
export function bakeEnvironment(renderer, scene, at = [0.15, 0, 0.35]) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.04, 0.05, 10, { position: new THREE.Vector3(...at), size: 128 });
  scene.environment = env.texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();
}
