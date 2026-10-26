// Upload endpoint for Handover episodes, run as a free Cloudflare Worker.
//
// The game POSTs finished episodes (gzipped JSON Lines, one episode per line, the format of
// web/src/recorder.js) to /episodes. Every episode is checked first; then all new ones are
// committed in one go into the private Hugging Face dataset DATASET_REPO, one file per
// episode at raw/game-<version>/<episode_id>.jsonl. The token lives only in the Worker's
// secrets, never in the game.
//
// Privacy: the player's IP address is used only in memory, for a per-address rate limit,
// and is never written to the dataset, to logs or to any store.
//
// Settings (wrangler.toml [vars] and `wrangler secret put`):
//   HF_TOKEN         secret, a fine-grained token with write access to DATASET_REPO only
//   DATASET_REPO     e.g. "suavi-yildirim/handover-episodes" (must exist, private)
//   ALLOWED_ORIGINS  comma-separated origins allowed to upload, or "*"
//   HF_ENDPOINT      Hub address, default https://huggingface.co (tests point it at a mock)
import { Buffer } from 'node:buffer'; // needs compatibility_flags = ["nodejs_compat"]

export const LIMITS = {
  body: 2 * 1024 * 1024, // bytes as sent (gzipped); a 15 s episode is about 50 KB
  raw: 24 * 1024 * 1024, // bytes after gunzip, so a small "zip bomb" can't fill memory
  episode: 9 * 1024 * 1024, // one episode's JSON; the Hub takes plain files up to 10 MB
  episodes: 3, // per upload: an episode costs about 4 ms of CPU, the free plan allows about 10 ms
  frames: 30 * 60 * 10, // 10 minutes at 30 fps
  perHour: 120, // uploads per address per hour
};

const FORMAT_VERSIONS = new Set([1]);
const LICENSE = 'CC-BY-4.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NAME = /^[a-z0-9_]{1,40}$/;

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// Address -> upload times in the last hour. Lives in this Worker instance's memory only, so
// the limit is per instance (best effort); a dashboard rate-limiting rule can back it up.
const recent = new Map();
export function rateLimited(addr, now = Date.now()) {
  const times = (recent.get(addr) || []).filter((t) => now - t < 3600e3);
  const over = times.length >= LIMITS.perHour;
  if (!over) times.push(now);
  if (times.length) recent.set(addr, times); else recent.delete(addr);
  if (recent.size > 10000) recent.delete(recent.keys().next().value); // bound memory
  return over;
}
export function resetRateLimit() { recent.clear(); }

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function rowsOfNumbers(rows) {
  const w = Array.isArray(rows[0]) ? rows[0].length : -1;
  return rows.every((r) => Array.isArray(r) && r.length === w && r.every(isNum));
}

// Why an episode is refused, or null if it is fine. Mirrors docs/upload.md.
export function checkEpisode(ep) {
  if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return 'an episode is not a JSON object';
  if (ep.format !== 'handover-episode' || !FORMAT_VERSIONS.has(ep.version)) {
    return 'not a Handover episode in a known format version';
  }
  if (ep.license !== LICENSE) return `episodes must carry license ${LICENSE}`;
  if (typeof ep.episode_id !== 'string' || !UUID.test(ep.episode_id)) return 'episode_id must be a UUID';
  if (ep.contributor_id != null && (typeof ep.contributor_id !== 'string' || !UUID.test(ep.contributor_id))) {
    return 'contributor_id must be a UUID or null';
  }
  if (typeof ep.game_version !== 'string' || !VERSION.test(ep.game_version)) return 'game_version must look like 1.2.3';
  if (typeof ep.task_id !== 'string' || !NAME.test(ep.task_id)) return 'task_id is missing or invalid';
  if (typeof ep.success !== 'boolean' || !isNum(ep.score)) return 'success and score are missing';
  const f = ep.frames;
  const keys = ['time', 'qpos', 'qvel', 'ctrl'];
  if (!f || typeof f !== 'object' || !keys.every((k) => Array.isArray(f[k]))) {
    return 'frames must hold time, qpos, qvel and ctrl lists';
  }
  const n = f.time.length;
  if (n < 1 || n > LIMITS.frames || keys.some((k) => f[k].length !== n)) {
    return 'frame lists are empty, too long, or of different lengths';
  }
  if (!f.time.every(isNum)) return 'frame times must be numbers';
  for (const k of ['qpos', 'qvel', 'ctrl']) {
    if (!rowsOfNumbers(f[k])) return `frames.${k} must be rows of numbers of one width`;
  }
  return null;
}

async function readCapped(stream, max, what) {
  const reader = stream.getReader(), parts = [];
  let total = 0;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { throw new HttpError(400, 'the file is not valid gzip'); }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) { reader.cancel().catch(() => {}); throw new HttpError(413, `the file is too large${what}`); }
    parts.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

async function readEpisodes(request) {
  if (Number(request.headers.get('content-length') || 0) > LIMITS.body) throw new HttpError(413, 'the file is too large');
  const body = request.body ? await readCapped(request.body, LIMITS.body, '') : new Uint8Array();
  let raw = body;
  if (body[0] === 0x1f && body[1] === 0x8b) { // gzip; plain JSON Lines comes from browsers without CompressionStream
    const unpacked = new Response(body).body.pipeThrough(new DecompressionStream('gzip'));
    raw = await readCapped(unpacked, LIMITS.raw, ' once unpacked');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new HttpError(400, 'the file is not UTF-8 text'); }
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) throw new HttpError(400, 'the file has no episodes');
  if (lines.length > LIMITS.episodes) throw new HttpError(413, `at most ${LIMITS.episodes} episodes per upload`);
  return lines.map((line, i) => {
    if (line.length > LIMITS.episode) throw new HttpError(413, `episode ${i + 1} is too large`);
    let ep;
    try { ep = JSON.parse(line); } catch { throw new HttpError(400, `episode ${i + 1} is not valid JSON`); }
    const why = checkEpisode(ep);
    if (why) throw new HttpError(400, `episode ${i + 1}: ${why}`);
    return { ep, line };
  });
}

const pathOf = (ep) => `raw/game-${ep.game_version}/${ep.episode_id}.jsonl`;

// Native base64: btoa on a 180 KB episode alone takes about 6 ms of CPU.
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// Paths that already exist in the dataset, so retries don't commit an episode twice.
async function existing(env, paths) {
  const form = new URLSearchParams(paths.map((p) => ['paths', p]));
  form.append('expand', 'false');
  const res = await fetch(`${hub(env)}/api/datasets/${env.DATASET_REPO}/paths-info/main`, {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
  });
  if (!res.ok) return new Set(); // can't tell; committing the same content again is harmless
  const info = await res.json().catch(() => []);
  return new Set(Array.isArray(info) ? info.map((x) => x.path) : []);
}

// One commit with every new episode, through the Hub's commit API (NDJSON: a header line,
// then one line per file).
async function commit(env, items) {
  const header = { key: 'header', value: { summary: `Add ${items.length} episode${items.length === 1 ? '' : 's'}`, description: '' } };
  // Built by hand: JSON.stringify on the large base64 strings costs CPU for nothing (base64 needs no escaping).
  const files = items.map(({ ep, line }) =>
    `{"key":"file","value":{"path":${JSON.stringify(pathOf(ep))},"content":"${base64(line + '\n')}","encoding":"base64"}}`);
  const res = await fetch(`${hub(env)}/api/datasets/${env.DATASET_REPO}/commit/main`, {
    method: 'POST',
    body: [JSON.stringify(header), ...files].join('\n'),
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
  });
  if (!res.ok) {
    console.log(`dataset commit failed: HTTP ${res.status}`); // no request data in logs
    throw new HttpError(502, 'could not save to the dataset; try again later');
  }
}

const hub = (env) => (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');

function cors(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : null;
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '3600', Vary: 'Origin' };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

const json = (status, body, headers) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json' },
});

export default {
  async fetch(request, env) {
    const headers = cors(request, env), { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method === 'GET' && pathname === '/') {
      return json(200, { ok: true, pushing_to_dataset: !!(env.HF_TOKEN && env.DATASET_REPO) }, headers);
    }
    if (request.method !== 'POST' || pathname !== '/episodes') return json(404, { detail: 'not found' }, headers);
    try {
      if (rateLimited(request.headers.get('CF-Connecting-IP') || '?')) {
        throw new HttpError(429, 'too many uploads from this address; try again in an hour');
      }
      if (!env.HF_TOKEN || !env.DATASET_REPO) throw new HttpError(503, 'uploads are not set up on the server yet');
      const items = await readEpisodes(request); // all checked first, so a bad file saves nothing
      const seen = new Set(), unique = items.filter(({ ep }) => !seen.has(ep.episode_id) && seen.add(ep.episode_id));
      const have = await existing(env, unique.map(({ ep }) => pathOf(ep)));
      const fresh = unique.filter(({ ep }) => !have.has(pathOf(ep)));
      if (fresh.length) await commit(env, fresh);
      return json(200, { saved: fresh.length, duplicates: items.length - fresh.length }, headers);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { detail: err.message }, headers);
      console.log(`upload failed: ${err?.name}`);
      return json(500, { detail: 'the upload server hit an error' }, headers);
    }
  },
};
