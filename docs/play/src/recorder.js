// Records episodes as raw simulator data at a fixed rate in simulation time, in the
// shared format of docs/episode_schema.md: full sim state per frame (so cameras can be
// rendered offline at any angle), sim-native units. The training pipeline's converter
// turns these into a LeRobot dataset.
import { ROBOT } from './robot.js';

export const FORMAT_VERSION = 1;
export const GAME_VERSION = '0.5.1';
export const DATA_LICENSE = 'CC-BY-4.0'; // recorded play data; the code is Apache-2.0
export const FPS = 30;

const round = (x) => Math.round(x * 1e6) / 1e6;
const arr = (a) => Array.from(a, round);

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

// A random id per browser so a contributor's episodes can be grouped (for reputation
// and data-value tracking) without knowing who they are. Also what a player quotes to
// have their shared episodes removed.
export function contributorId() {
  try {
    let id = localStorage.getItem('handover.contributor');
    if (!id) localStorage.setItem('handover.contributor', (id = uuid()));
    return id;
  } catch {
    return null;
  }
}

export class Recorder {
  // level: model path relative to web/, e.g. 'models/kitchen.xml'.
  constructor(sim, teleop, { level }) {
    this.sim = sim;
    this.teleop = teleop;
    this.model = level;
    this.episodes = []; // finished episodes kept in memory until downloaded
    this.current = null;
  }

  // meta: { scene, source } where scene is the randomized scene from scene.js (null for the
  // standard layout) and source says who drives: 'human' (default) or 'planner'.
  start(task, { scene = null, source = 'human' } = {}) {
    this.current = {
      format: 'handover-episode',
      version: FORMAT_VERSION,
      robot: ROBOT.id,
      level: this.model.replace(/^.*\//, '').replace(/\.xml$/, ''),
      model: this.model,
      fps: FPS,
      task_id: task.id,
      task: task.instruction,
      episode_id: uuid(),
      started_at: new Date().toISOString(),
      inputs: [], // input devices used during the episode, e.g. ['keyboard', 'phone']
      contributor_id: contributorId(),
      license: DATA_LICENSE,
      game_version: GAME_VERSION,
      mujoco_version: this.sim.mj.mj_versionString(),
      scene_seed: scene?.seed ?? null,
      scene, // positions, friction, mass and light of a randomized scene; null = standard layout
      source,
      success: false,
      score: 0,
      metrics: {},
      joint_names: ROBOT.actuators.slice(),
      frames: { time: [], qpos: [], qvel: [], ctrl: [] },
      // Extra per-frame data beyond the schema: what the player was steering toward.
      intent: { target: [], pitch: [], roll: [], grip_closed: [] },
    };
    this.nextT = this.sim.time;
  }

  // Call after every physics step. Records the first state at or past each 1/FPS
  // boundary of sim time, so frames land within one step of an exact 30 Hz grid.
  update() {
    const ep = this.current;
    if (!ep) return;
    const { data } = this.sim;
    if (data.time + 1e-9 < this.nextT) return;
    this.nextT += 1 / FPS;
    if (data.time >= this.nextT) this.nextT = data.time + 1 / FPS; // stalled: don't backfill
    const f = ep.frames, t = this.teleop, i = ep.intent;
    f.time.push(round(data.time));
    f.qpos.push(arr(data.qpos));
    f.qvel.push(arr(data.qvel));
    f.ctrl.push(arr(data.ctrl));
    i.target.push(arr(t.target));
    i.pitch.push(round(t.pitch));
    i.roll.push(round(t.roll));
    i.grip_closed.push(t.gripClosed);
  }

  noteInput(name) {
    if (this.current && !this.current.inputs.includes(name)) this.current.inputs.push(name);
  }

  // End the episode with the task's result (or why it ended early) and keep it.
  // events: the task's [simTime, type] list (grasp, release, drop, success, fail).
  finish(result, events = []) {
    const ep = this.current;
    this.current = null;
    if (!ep || ep.frames.time.length < FPS) return null; // ignore sub-second fragments
    ep.success = !!result.success;
    ep.score = result.score ?? 0;
    ep.metrics = { ...(result.metrics || {}), raw: result.raw, reason: result.reason };
    ep.events = events.map(([t, type]) => ({ t: round(t), type }));
    this.episodes.push(ep);
    return ep;
  }

  get count() { return this.episodes.length; }

  // Episodes as one gzipped JSON Lines file (one episode per line). Returns { blob, name }.
  // Gzip is used where the browser supports it; the blob type says which.
  async file(episodes = this.episodes) {
    const text = episodes.map((e) => JSON.stringify(e)).join('\n') + '\n';
    let blob = new Blob([text], { type: 'application/x-ndjson' }), ext = 'jsonl';
    if (globalThis.CompressionStream) {
      const gz = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      blob = new Blob([gz], { type: 'application/gzip' });
      ext = 'jsonl.gz';
    }
    const name = `handover-episodes-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    return { blob, name };
  }

  // Saves a { blob, name } from file() to the device.
  save({ blob, name }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // All finished episodes as one file, since browsers block a burst of separate downloads.
  async download() {
    if (this.episodes.length) this.save(await this.file());
  }
}
