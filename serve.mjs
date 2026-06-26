// Tiny static file server for the PDF Keyword Scanner.
// Serves this folder on http://localhost:PORT so PDF.js + its worker
// load correctly (file:// blocks workers). No dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8131;
const HOST = process.env.HOST || '0.0.0.0';  // listen on all interfaces so the LAN can reach it (firewall is the real gate)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // prevent path traversal
    const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, safe);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',  // always serve fresh code — no stale-cache surprises
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  PDF Keyword Scanner running:`);
  console.log(`    on this PC:     http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`    other devices:  http://<this-PC-IP>:${PORT}   (run "Host on LAN (admin).cmd" once to allow it through the firewall)`);
  console.log('');
});
