import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startUiServer } from '../ui-server.mjs';

test('desktop UI server serves SPA, static assets, and safe 404s on loopback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'contexa-ui-'));
  let server;
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<main>Contexa UI</main>');
    await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("ui");');
    server = await startUiServer({ distRoot: root, port: 0 });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/);
    assert.match(await home.text(), /Contexa UI/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /javascript/);

    const spaRoute = await fetch(`${base}/history`);
    assert.equal(spaRoute.status, 200);
    assert.match(await spaRoute.text(), /Contexa UI/);

    const missingAsset = await fetch(`${base}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop UI server refuses to start when the compiled UI is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'contexa-empty-ui-'));
  try {
    await assert.rejects(() => startUiServer({ distRoot: root, port: 0 }), /Compiled UI is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
