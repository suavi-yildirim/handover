import { Sim } from './sim.js';
import { Teleop } from './teleop.js';
import { Renderer } from './render.js';
import { Keyboard, KEY_HELP } from './keyboard.js';
import { ROBOT } from './robot.js';

const LEVEL = 'models/kitchen.xml';
const MAX_STEPS_PER_FRAME = 50; // don't spiral if a frame takes too long

const $ = (id) => document.getElementById(id);

async function main() {
  const sim = await Sim.create(LEVEL);
  const teleop = new Teleop(sim);
  const view = new Renderer($('view'), sim);

  const reset = () => { sim.reset(); teleop.reset(); };
  const keys = new Keyboard({ onToggleGrip: () => teleop.toggleGrip(), onReset: reset });

  $('help').innerHTML = KEY_HELP.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('');
  $('loading').remove();

  // Exposed for debugging and automated tests.
  window.handover = { sim, teleop, view, keys, reset };

  let last = performance.now(), simLag = 0, fps = 0, frames = 0, fpsT = last;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    teleop.command(keys.command(view.groundAxes()), dt);
    teleop.apply(dt);

    simLag += dt;
    let n = 0;
    while (simLag >= sim.dt && n < MAX_STEPS_PER_FRAME) { sim.step(); simLag -= sim.dt; n++; }
    if (n === MAX_STEPS_PER_FRAME) simLag = 0;

    view.draw(teleop.target);

    frames++;
    if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
    const t = teleop.target;
    $('status').textContent =
      `${ROBOT.name} · gripper ${teleop.gripClosed ? 'closed' : 'open'} · ` +
      `target ${t.map((x) => (x * 100).toFixed(1)).join(', ')} cm · ` +
      `tilt ${Math.round((teleop.pitch * 180) / Math.PI)}° · ` +
      (teleop.ikError > 0.01 ? 'out of reach · ' : '') +
      `${fps.toFixed(0)} fps`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  $('loading').textContent = `Failed to start: ${err.message}`;
});
