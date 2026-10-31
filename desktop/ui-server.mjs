import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** Serve the compiled React SPA on loopback for the Electron BrowserWindow. */
export async function startUiServer({ distRoot, host = '127.0.0.1', port = 4173 }) {
  const root = path.resolve(distRoot);
  const indexPath = path.join(root, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(`Compiled UI is missing at ${indexPath}. Run Start-Contexa.ps1 to build it.`);
  }

  const server = createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url || '/', `http://${host}:${port}`);
      const pathname = decodeURIComponent(parsed.pathname || '/');
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let filePath = path.resolve(root, relative);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
      }

      let body;
      try {
        body = await readFile(filePath);
      } catch {
        // Unknown SPA paths return the app shell, while missing asset URLs stay 404.
        if (path.extname(pathname)) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }
        filePath = indexPath;
        body = await readFile(indexPath);
      }

      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      });
      response.end(body);
    } catch (error) {
      console.error('Contexa UI server request failed:', error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Contexa UI could not be served.');
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      server.on('error', (error) => console.error('Contexa UI server error:', error));
      resolve();
    });
  });

  return server;
}
