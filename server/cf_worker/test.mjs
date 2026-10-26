// Tests for the upload Worker, run in Node with a mock Hugging Face Hub (no network, no account).
//   node server/cf_worker/test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', '..', 'tests', 'fixtures');
const { default: worker, LIMITS, resetRateLimit } = await import(path.join(HERE, 'src', 'index.js'));

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// Mock Hub: records commits, answers paths-info from what was committed so far.
const hub = { commits: [], files: new Map(), fail: false, calls: [] };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  hub.calls.push({ url, auth: new Headers(init.headers).get('Authorization') });
  if (url.endsWith('/paths-info/main')) {
    const asked = new URLSearchParams(String(init.body)).getAll('paths');
    return Response.json(asked.filter((p) => hub.files.has(p)).map((p) => ({ path: p, type: 'file' })));
  }
  if (url.endsWith('/commit/main')) {
    if (hub.fail) return new Response('{"error":"nope"}', { status: 500 });
    const lines = String(init.body).split('\n').map((l) => JSON.parse(l));
    hub.commits.push({ lines, type: new Headers(init.headers).get('Content-Type') });
    for (const l of lines.slice(1)) hub.files.set(l.value.path, Buffer.from(l.value.content, 'base64').toString());
    return Response.json({ commitOid: 'abc' });
  }
  return new Response('not found', { status: 404 });
};

const env = { HF_TOKEN: 'hf_test_token', DATASET_REPO: 'suavi-yildirim/handover-episodes',
  ALLOWED_ORIGINS: 'https://suavi-yildirim.github.io,http://localhost:8000', HF_ENDPOINT: 'https://hub.test' };
const IP = '203.0.113.7';

function request(body, { gz = true, headers = {}, method = 'POST', url = 'https://w.test/episodes' } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': IP, 'Content-Type': 'application/gzip', ...headers } };
  if (body != null) init.body = gz ? gzipSync(body) : body;
  return new Request(url, init);
}
const lines = (eps) => eps.map((e) => JSON.stringify(e)).join('\n') + '\n';
const send = async (eps, opts, e = env) => { const r = await worker.fetch(request(lines(eps), opts), e); return { status: r.status, body: await r.json(), headers: r.headers }; };

const real = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl')).sort()
  .map((f) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8').split('\n')[0]));
check('three fixture episodes found', real.length === 3);

let r = await send(real);
check('real episodes are accepted', r.status === 200 && r.body.saved === 3 && r.body.duplicates === 0);
const c = hub.commits[0];
check('one commit for the whole upload, as NDJSON', hub.commits.length === 1 && c.type === 'application/x-ndjson' &&
  c.lines[0].key === 'header' && c.lines.slice(1).every((l) => l.key === 'file' && l.value.encoding === 'base64'));
check('one file per episode under raw/game-<version>/', c.lines.slice(1).every((l, i) =>
  l.value.path === `raw/game-${real[0].game_version}/${l.value.path.split('/').pop()}` && l.value.path.endsWith('.jsonl')));
check('saved episode is unchanged', real.some((e) => JSON.stringify(e) === hub.files.get(c.lines[1].value.path).trim()));
check('the token goes only to the Hub', hub.calls.every((x) => x.url.startsWith('https://hub.test/') && x.auth === 'Bearer hf_test_token'));
check('no IP address reaches the dataset', [...hub.files.values()].every((t) => !t.includes(IP)) &&
  !JSON.stringify(hub.commits).includes(IP));

r = await send(real.slice(0, 1));
check('a retry is counted as a duplicate and not committed again', r.body.saved === 0 && r.body.duplicates === 1 &&
  hub.commits.length === 1);
r = await send([{ ...real[0], episode_id: '00000000-0000-4000-8000-000000000001' }], { gz: false, headers: { 'Content-Type': 'application/x-ndjson' } });
check('plain JSON Lines is accepted too', r.status === 200 && r.body.saved === 1);

async function rejected(name, change, status = 400) {
  const ep = structuredClone(real[0]);
  ep.episode_id = '00000000-0000-4000-8000-0000000000ff';
  change(ep);
  const before = hub.commits.length, res = await send([ep]);
  check(`rejects ${name}`, res.status === status && typeof res.body.detail === 'string' && hub.commits.length === before);
}
await rejected('a different license', (e) => { e.license = 'CC0'; });
await rejected('a non-UUID episode id', (e) => { e.episode_id = '../../etc/passwd'; });
await rejected('a path-like game version', (e) => { e.game_version = '../0.4.3'; });
await rejected('an unknown format version', (e) => { e.version = 99; });
await rejected('frame lists of different lengths', (e) => { e.frames.qpos.pop(); });
await rejected('non-numeric joint values', (e) => { e.frames.qpos[0][0] = 'x'; });
await rejected('ragged qpos rows', (e) => { e.frames.qpos[5].push(0); });
await rejected('a missing success flag', (e) => { delete e.success; });

let before = hub.commits.length;
r = await send([{ ...real[0], episode_id: '00000000-0000-4000-8000-0000000000aa' }, { format: 'nope' }]);
check('a file with one bad episode saves nothing', r.status === 400 && hub.commits.length === before);
r = await worker.fetch(request(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), { gz: false }), env);
check('rejects bytes that are not gzip', r.status === 400);
r = await worker.fetch(request('', { gz: false }), env);
check('rejects an empty upload', r.status === 400);
r = await worker.fetch(request(Buffer.alloc(LIMITS.raw + 10, 48)), env);
check('rejects a small file that unpacks too large', r.status === 413);
r = await worker.fetch(request(new Uint8Array(LIMITS.body + 1), { gz: false }), env);
check('rejects a body over the size cap', r.status === 413);
r = await send(Array.from({ length: LIMITS.episodes + 1 }, (_, i) => ({ ...real[0], episode_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })));
check(`rejects more than ${LIMITS.episodes} episodes per upload`, r.status === 413);

hub.fail = true;
r = await send([{ ...real[0], episode_id: '00000000-0000-4000-8000-0000000000bb' }]);
check('a Hub failure answers 502 so the game retries later', r.status === 502);
hub.fail = false;
r = await send([{ ...real[0], episode_id: '00000000-0000-4000-8000-0000000000bc' }], {}, { ...env, HF_TOKEN: '' });
check('without a token the Worker says it is not set up (503)', r.status === 503);

const pre = await worker.fetch(request(null, { method: 'OPTIONS', headers: { Origin: 'https://suavi-yildirim.github.io',
  'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env);
check('CORS preflight from GitHub Pages is allowed', pre.status === 204 &&
  pre.headers.get('Access-Control-Allow-Origin') === 'https://suavi-yildirim.github.io');
r = await send([real[0]], { headers: { Origin: 'https://evil.test' } });
check('other origins get no CORS permission', !r.headers.get('Access-Control-Allow-Origin'));
const health = await (await worker.fetch(new Request('https://w.test/'), env)).json();
check('health says it is pushing when configured', health.ok && health.pushing_to_dataset);

resetRateLimit();
LIMITS.perHour = 3;
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await worker.fetch(request('', { gz: false }), env)).status);
check('rate limit answers 429 after the cap', codes.slice(0, 3).every((s) => s === 400) && codes[3] === 429);

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
