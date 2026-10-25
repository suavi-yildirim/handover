// Send-my-episodes: the issue link, the blocked-tab fallback and the episode file.
//   node tests/upload.mjs
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { Recorder, GAME_VERSION } = await import(path.join(WEB, 'src/recorder.js'));
const { issueUrl, openIssue, ISSUE_REPO } = await import(path.join(WEB, 'src/upload.js'));

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// Issue link: goes to the project's repo, prefills title and body, names the file to attach.
const url = new URL(issueUrl({ count: 2, gameVersion: GAME_VERSION, filename: 'ep.jsonl.gz' }));
check('issue link points at the project repo', url.origin === 'https://github.com' &&
  url.pathname === `/${ISSUE_REPO}/issues/new`);
check('title says how many episodes and which game version', url.searchParams.get('title') ===
  `Episodes: 2 from game ${GAME_VERSION}`);
check('body names the file and states the CC-BY-4.0 publication',
  url.searchParams.get('body').includes('`ep.jsonl.gz`') && url.searchParams.get('body').includes('CC-BY-4.0'));
check('one episode is singular', new URL(issueUrl({ count: 1, gameVersion: '1', filename: 'x' }))
  .searchParams.get('title') === 'Episodes: 1 from game 1');

// Blocked tab: window.open returns null, so the caller must see false and show a link.
check('blocked tab is reported', openIssue('https://example.test', { open: () => null }) === false);
let opened = null;
const tab = { opener: 'set' };
check('opened tab is reported and detached from its opener',
  openIssue('https://example.test', { open: (u) => { opened = u; return tab; } }) === true &&
  tab.opener === null && opened === 'https://example.test');

// Episode file: gzipped JSON Lines, one episode per line, with the blob type saying so.
const rec = new Recorder(null, null, { level: 'models/kitchen.xml' });
rec.episodes = [{ episode_id: 'a', score: 90 }, { episode_id: 'b', score: 80 }];
const { blob, name } = await rec.file();
check('file name ends in .jsonl.gz', /\.jsonl\.gz$/.test(name));
check('file is typed as gzip', blob.type === 'application/gzip');
const lines = gunzipSync(Buffer.from(await blob.arrayBuffer())).toString('utf8').trim().split('\n');
check('one episode per line, in order', lines.length === 2 &&
  JSON.parse(lines[0]).episode_id === 'a' && JSON.parse(lines[1]).episode_id === 'b');

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
