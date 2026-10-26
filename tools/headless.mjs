// Loads the game's own simulation code in Node (no browser, no GPU), for tests and tools.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Sim loads the level over HTTP like the browser does, so serve web/ briefly.
export async function loadSim(level = 'models/kitchen.xml') {
  const { Sim } = await import(path.join(WEB, 'src/sim.js'));
  const server = http.createServer(async (req, res) => {
    try { res.end(await readFile(path.join(WEB, decodeURIComponent(req.url)))); }
    catch { res.statusCode = 404; res.end(); }
  }).listen(0);
  const sim = await Sim.create(`http://localhost:${server.address().port}/${level}`);
  server.close();
  return sim;
}
