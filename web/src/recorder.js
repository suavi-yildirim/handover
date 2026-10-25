// Records episodes as raw simulator data at a fixed rate in simulation time, in the
// shared format of docs/episode_schema.md: full sim state per frame (so cameras can be
// rendered offline at any angle), sim-native units. The training pipeline's converter
// turns these into a LeRobot dataset.
import { ROBOT } from './robot.js';

export const FORMAT_VERSION = 1;
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

export class Recorder {
  // level: model path relative to web/, e.g. 'models/kitchen.xml'.
  constructor(sim, teleop, { level }) {
    this.sim = sim;
    this.teleop = teleop;
    this.model = level;
    this.episodes = []; // finished episodes kept in memory until downloaded
    this.current = null;
  }

  start(task) {
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
  finish(result) {
    const ep = this.current;
    this.current = null;
    if (!ep || ep.frames.time.length < FPS) return null; // ignore sub-second fragments
    ep.success = !!result.success;
    ep.score = result.score ?? 0;
    ep.metrics = { ...(result.metrics || {}), raw: result.raw, reason: result.reason };
    this.episodes.push(ep);
    return ep;
  }

  get count() { return this.episodes.length; }

  // All finished episodes as one gzipped JSON Lines file (one episode per line), since
  // browsers block a burst of separate downloads.
  async download() {
    if (!this.episodes.length) return;
    const text = this.episodes.map((e) => JSON.stringify(e)).join('\n') + '\n';
    let blob = new Blob([text], { type: 'application/x-ndjson' }), ext = 'jsonl';
    if (globalThis.CompressionStream) {
      blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      ext = 'jsonl.gz';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `handover-episodes-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
