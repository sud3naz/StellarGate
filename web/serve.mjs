/**
 * Serves this directory over plain http, for testing against a local watcher.
 *
 * Not a build step and not part of the deployment. It exists because a page on
 * https cannot fetch a service on http — browsers refuse, and recent Chrome
 * asks about local network access besides — so testing the real flow against a
 * watcher running on the same machine needs the page to be on http too.
 *
 * Production is the opposite arrangement: the page on https and the watcher
 * behind https with it. This is only for the arrangement where the watcher is
 * on your own laptop.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const port = Number(process.argv[2] ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const asked = new URL(req.url, 'http://localhost').pathname;
  // Anything that climbs out of this directory is a request for a file that
  // was never meant to be served.
  const path = join(root, normalize(asked === '/' ? '/index.html' : asked));
  if (!path.startsWith(root)) {
    res.writeHead(403).end('no');
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`the page is at http://localhost:${port}`);
  console.log('the watcher should be at http://localhost:8787');
});
