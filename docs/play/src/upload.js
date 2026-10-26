// Sharing episodes with the Handover dataset. The player turns sharing on once, after a
// consent step in the page; from then on each finished episode is sent in the background to
// the project's Cloudflare Worker (server/cf_worker), which checks it and commits it to the
// Hugging Face dataset. No login and no key in the game: the Worker holds the upload token.
// See docs/upload.md for setup and the privacy notes.

// The upload Worker's address, e.g. 'https://handover-upload.<account>.workers.dev/episodes'.
// Empty until the Worker is deployed; sharing then shows as not set up.
export const UPLOAD_URL = 'https://handover-upload.suavi-handover.workers.dev/episodes';

const MAX_PER_UPLOAD = 1; // one episode per request keeps the Worker in the free plan's CPU budget
const MAX_TRIES = 3; // an episode that fails this often is dropped (it stays downloadable)
const TIMEOUT_MS = 30000;

// retry: whether sending the same file again later could work (network, asleep, rate limit),
// as opposed to the server rejecting the file itself.
export class UploadError extends Error {
  constructor(message, retry) { super(message); this.retry = retry; }
}

// POSTs one episode file ({ blob } from Recorder.file()). Returns the server's
// { saved, duplicates } or throws an UploadError with a message fit for the player.
export async function uploadEpisodes(blob, url = UPLOAD_URL, fetchImpl = globalThis.fetch) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type },
      credentials: 'omit', signal: abort.signal });
  } catch {
    throw new UploadError("Couldn't reach the upload server.", true);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return body || {};
  const why = typeof body?.detail === 'string' ? body.detail : `error ${res.status}`;
  if (res.status === 429) throw new UploadError('Too many uploads for now.', true);
  if (res.status === 400 || res.status === 413) throw new UploadError(`The server refused the file: ${why}.`, false);
  if (res.status === 503) throw new UploadError("Sharing isn't set up on the server yet.", true);
  throw new UploadError('The upload server is busy.', true);
}

// Keeps the player's sharing choice and sends finished episodes while it is on. Episodes
// that fail to send stay queued and go with the next one. DOM-free, so tests can drive it;
// onChange tells the page to redraw.
export class Sharer {
  constructor(recorder, { url = UPLOAD_URL, fetchImpl = globalThis.fetch, storage = globalThis.localStorage } = {}) {
    this.recorder = recorder;
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.queue = [];
    this.sentIds = new Set(); // episodes that are done: shared, refused or given up on
    this.tries = new Map(); // episode_id -> failed attempts
    this.sent = 0; // episodes shared in this session
    this.state = this.enabled ? 'idle' : 'off'; // off | idle | sending | error
    this.message = '';
    this.busy = false;
    this.onChange = () => {};
  }

  get available() { return !!this.url; }

  get enabled() {
    try { return this.available && this.storage?.getItem('handover.share') === 'on'; } catch { return false; }
  }

  // After consent: also sends the episodes already played in this session.
  enable() {
    try { this.storage?.setItem('handover.share', 'on'); } catch { /* choice lasts this session only */ }
    this.queue = this.recorder.episodes.filter((e) => !this.sentIds.has(e.episode_id));
    this.set('idle', '');
    return this.flush();
  }

  disable() {
    try { this.storage?.setItem('handover.share', 'off'); } catch { /* ignore */ }
    this.queue = [];
    this.set('off', '');
  }

  // Call with each finished episode (Recorder.finish()'s result).
  add(ep) {
    if (!ep || !this.enabled) return Promise.resolve();
    this.queue.push(ep);
    return this.flush();
  }

  async flush() {
    if (this.busy || !this.queue.length || !this.enabled) return;
    this.busy = true;
    const batch = this.queue.slice(0, MAX_PER_UPLOAD), n = batch.length;
    const plural = `episode${n === 1 ? '' : 's'}`;
    this.set('sending', `Sharing ${n} ${plural}…`);
    try {
      const { blob } = await this.recorder.file(batch);
      await uploadEpisodes(blob, this.url, this.fetchImpl);
      this.done(batch);
      this.sent += n;
      this.set('idle', `Shared ${n} ${plural}. Thank you!`);
    } catch (err) {
      if (err instanceof UploadError && !err.retry) {
        this.done(batch); // sending it again would be refused again
        this.set('error', `${err.message} Download keeps a copy.`);
      } else if (batch.every((e) => this.failed(e) >= MAX_TRIES)) {
        this.done(batch);
        this.set('error', `${err.message ?? 'Sharing failed.'} Gave up on this episode after ${MAX_TRIES} tries; ` +
          'Download keeps a copy.');
      } else {
        this.set('error', `${err.message ?? 'Sharing failed.'} Kept here; it goes with your next episode.`);
      }
      this.busy = false;
      return;
    }
    this.busy = false;
    if (this.queue.length) await this.flush();
  }

  failed(ep) {
    const n = (this.tries.get(ep.episode_id) || 0) + 1;
    this.tries.set(ep.episode_id, n);
    return n;
  }

  done(batch) {
    this.queue = this.queue.filter((e) => !batch.includes(e));
    for (const e of batch) this.sentIds.add(e.episode_id);
  }

  set(state, message) {
    this.state = state;
    this.message = message;
    this.onChange();
  }
}
