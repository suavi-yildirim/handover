// Sharing episodes with the Handover dataset. The player turns sharing on once, after a
// consent step in the page; from then on each finished episode is sent in the background to
// the project's Hugging Face Space (server/hf_space), which checks it and saves it to the
// dataset. No login and no key in the game: the Space holds the upload token.
// See docs/upload.md for setup and the privacy notes.

// The Space's upload address, e.g. 'https://suavi-yildirim-handover-upload.hf.space/episodes'.
// Empty until the Space exists; sharing then shows as not set up.
export const UPLOAD_URL = '';

const MAX_PER_UPLOAD = 20; // the Space accepts up to 50
const TIMEOUT_MS = 90000; // a free Space that was asleep takes about 30 s to wake

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
  throw new UploadError('The upload server is busy or waking up.', true);
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
    this.sentIds = new Set();
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
      } else {
        this.set('error', `${err.message ?? 'Sharing failed.'} Kept here; it goes with your next episode.`);
      }
      this.busy = false;
      return;
    }
    this.busy = false;
    if (this.queue.length) await this.flush();
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
