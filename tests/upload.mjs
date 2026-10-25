// Episode sharing: the upload client and the Sharer, against a mock upload server.
//   node tests/upload.mjs
// The real server (server/hf_space) has its own tests: python server/hf_space/test_app.py
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { Recorder } = await import(path.join(WEB, 'src/recorder.js'));
const { uploadEpisodes, UploadError, Sharer } = await import(path.join(WEB, 'src/upload.js'));

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// Mock server: answers with whatever `reply` says and records what it received.
let reply = { status: 200, body: { saved: 1, duplicates: 0 } };
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    received.push({ type: req.headers['content-type'], ids: gunzipSync(body).toString().trim().split('\n')
      .map((l) => JSON.parse(l).episode_id) });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
}).listen(0);
const URL_OK = `http://localhost:${server.address().port}/episodes`;

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const ep = (id) => ({ episode_id: id, score: 90, frames: { time: [0] } });
const rec = new Recorder(null, null, { level: 'models/kitchen.xml' });
const file = async (ids) => (await rec.file(ids.map(ep))).blob;

// uploadEpisodes: success and each kind of failure.
check('upload returns the server answer', (await uploadEpisodes(await file(['a']), URL_OK)).saved === 1);
check('upload sends gzip with its content type', received[0].type === 'application/gzip' && received[0].ids[0] === 'a');
async function failure(status, body) {
  reply = { status, body };
  try { await uploadEpisodes(await file(['a']), URL_OK); return null; } catch (e) { return e; }
}
let e = await failure(400, { detail: 'episodes must carry license CC-BY-4.0' });
check('a refused file is not retried and says why', e instanceof UploadError && !e.retry && e.message.includes('CC-BY-4.0'));
e = await failure(429, { detail: 'too many' });
check('rate limit is retried later', e instanceof UploadError && e.retry);
e = await failure(503, {});
check('a sleeping or broken server is retried later', e instanceof UploadError && e.retry);
try { await uploadEpisodes(await file(['a']), 'http://localhost:1/episodes'); e = null; } catch (err) { e = err; }
check('no network is retried later', e instanceof UploadError && e.retry);

// Sharer: off by default, consent turns it on, failures stay queued.
reply = { status: 200, body: { saved: 1, duplicates: 0 } };
received.length = 0;
const store = memory();
rec.episodes = [ep('s1'), ep('s2')];
const sharer = new Sharer(rec, { url: URL_OK, storage: store });
await sharer.add(ep('x'));
check('nothing is sent before the player opts in', !sharer.enabled && received.length === 0);
check('without an upload address, sharing is unavailable', !new Sharer(rec, { url: '', storage: store }).available);

await sharer.enable();
check('opting in sends the episodes already played', received.length === 1 &&
  received[0].ids.join() === 's1,s2' && sharer.sent === 2 && sharer.state === 'idle');
check('the choice is remembered', store.getItem('handover.share') === 'on' &&
  new Sharer(rec, { url: URL_OK, storage: store }).enabled);

reply = { status: 503, body: {} };
await sharer.add(ep('f1'));
check('a failed upload keeps the episode queued', sharer.state === 'error' && sharer.queue.length === 1);
reply = { status: 200, body: { saved: 2, duplicates: 0 } };
await sharer.add(ep('f2'));
check('the next episode takes the queued one along', received.at(-1).ids.join() === 'f1,f2' &&
  sharer.queue.length === 0 && sharer.sent === 4);

reply = { status: 400, body: { detail: 'bad file' } };
await sharer.add(ep('bad'));
check('a refused episode is dropped, not retried forever', sharer.queue.length === 0 && sharer.state === 'error');

reply = { status: 200, body: { saved: 1, duplicates: 0 } };
sharer.disable();
const before = received.length;
await sharer.add(ep('y'));
check('turning sharing off stops sending', !sharer.enabled && received.length === before && sharer.state === 'off');
await sharer.enable();
check('turning it on again does not resend shared episodes', received.length === before);

server.close();
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
