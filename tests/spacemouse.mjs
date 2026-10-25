// 3D mouse mapping: feed fake HID reports and check the commands they produce.
//   node tests/spacemouse.mjs
import { SpaceMouseInput } from '../web/src/spacemouse.js';

let toggles = 0;
const sm = new SpaceMouseInput({ onToggleGrip: () => toggles++ });
const report = (id, ...vals) => {
  const dv = new DataView(new ArrayBuffer(2 * vals.length));
  vals.forEach((v, i) => dv.setInt16(2 * i, v, true));
  sm.onReport({ reportId: id, data: dv });
};
const axes = { forward: [1, 0], right: [0, -1] }; // camera looking along +x
const cmd = () => sm.command(axes);

const checks = [];
report(1, 0, -350, 0, 0, 0, 0);            // push cap away (HID y negative)
checks.push(['push away moves forward (+x)', cmd().v[0] > 0.1]);
report(1, 350, 0, 0, 0, 0, 0);             // slide right
checks.push(['slide right moves right (-y)', cmd().v[1] < -0.1]);
report(1, 0, 0, -350, 0, 0, 0);            // lift cap (HID z negative)
checks.push(['lift moves up', cmd().v[2] > 0.1]);
report(1, 10, -10, 5, 0, 0, 0);            // tiny noise
checks.push(['deadzone ignores noise', cmd().v.every((v) => v === 0) && !sm.active]);
report(1, 0, 0, 0);                        // old models: translation only in report 1...
report(2, 300, 0, -300);                   // ...rotation in report 2
checks.push(['tilt and twist give rates', cmd().pitchRate !== 0 && cmd().rollRate !== 0]);
report(3, 1); report(3, 0);
checks.push(['left button toggles grip once', toggles === 1]);
report(3, 2); report(3, 0);
checks.push(['right button toggles precise mode', sm.fine === true]);

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
