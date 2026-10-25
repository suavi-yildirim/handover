// Loads MuJoCo (WASM), the level MJCF and its meshes, and wraps model/data access.
import loadMujoco from '../vendor/mujoco/mujoco.js';

const ROOT = '/models';

// Fetch an MJCF and everything it references (includes and mesh files) into the
// in-memory filesystem MuJoCo reads from.
async function stageModel(mj, url) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const mainXml = await (await fetch(url)).text();
  const meshdir = (mainXml.match(/<compiler[^>]*meshdir="([^"]+)"/) || [])[1] || '';
  const files = new Map([[url.slice(base.length), mainXml]]);

  const queue = [mainXml];
  const binaries = [];
  while (queue.length) {
    const xml = queue.pop();
    for (const [, file] of xml.matchAll(/<include\s+file="([^"]+)"/g)) {
      const text = await (await fetch(base + file)).text();
      files.set(file, text);
      queue.push(text);
    }
    for (const [, file] of xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)) {
      binaries.push(meshdir ? `${meshdir}/${file}` : file);
    }
  }
  await Promise.all(binaries.map(async (rel) => {
    const res = await fetch(base + rel);
    if (!res.ok) throw new Error(`Missing asset ${rel}`);
    files.set(rel, new Uint8Array(await res.arrayBuffer()));
  }));

  for (const [rel, content] of files) {
    const path = `${ROOT}/${rel}`;
    mj.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    mj.FS.writeFile(path, content);
  }
  return `${ROOT}/${url.slice(base.length)}`;
}

export class Sim {
  static async create(levelUrl) {
    const mj = await loadMujoco();
    const path = await stageModel(mj, levelUrl);
    return new Sim(mj, mj.MjModel.from_xml_path(path));
  }

  constructor(mj, model) {
    this.mj = mj;
    this.model = model;
    this.data = new mj.MjData(model);
    this.reset();
  }

  id(type, name) {
    const id = this.mj.mj_name2id(this.model, this.mj.mjtObj[`mjOBJ_${type}`].value, name);
    if (id < 0) throw new Error(`No ${type.toLowerCase()} named ${name}`);
    return id;
  }

  // Index into qpos for a named joint.
  qposAdr(joint) { return this.model.jnt_qposadr[this.id('JOINT', joint)]; }

  reset() {
    if (this.model.nkey > 0) this.mj.mj_resetDataKeyframe(this.model, this.data, 0);
    else this.mj.mj_resetData(this.model, this.data);
    this.mj.mj_forward(this.model, this.data);
  }

  step() { this.mj.mj_step(this.model, this.data); }
  get time() { return this.data.time; }
  get dt() { return this.model.opt.timestep; }
}
