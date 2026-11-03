import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './registry';
import { FolderProjectStore } from '../diagrams-app/modules/projects/infrastructure/workspace';
import { createToken, TokenStore } from '../diagrams-identity/core/tokens';
import { inlineExecutor } from './compute';
import { createSuiteServer } from './serve';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('procesos partidos (spec 009): rutas y /readyz', () => {
  let server: Server | undefined;

  afterEach(() => void server?.close());

  it('gateway: /api/modules sí, /api/projects no; /readyz solo registry y compute', async () => {
    const registry = createDefaultRegistry();
    server = createSuiteServer({
      registry,
      version: '0.0.0',
      compute: { ...inlineExecutor(registry), healthy: () => true },
      readinessProcess: 'gateway',
    });
    const base = await listen(server);
    expect((await fetch(`${base}/api/modules`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects`)).status).toBe(404);
    expect(await (await fetch(`${base}/readyz`)).json()).toMatchObject({
      status: 'ok',
      checks: { registry: 'ok', compute: 'ok' },
    });
  });

  it('app: /api/projects sí, /api/modules no; /readyz solo workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-split-app-'));
    const store = new FolderProjectStore(root);
    server = createSuiteServer({
      registry: createDefaultRegistry(),
      version: '0.0.0',
      projects: store,
      readinessProcess: 'app',
      readyCacheMs: 0,
    });
    const base = await listen(server);
    expect((await fetch(`${base}/api/projects`)).status).toBe(200);
    expect((await fetch(`${base}/api/modules`)).status).toBe(404);
    const ready = await (await fetch(`${base}/readyz`)).json();
    expect(ready.checks).toEqual({ workspace: 'ok' });
    expect(ready.checks.tokens).toBeUndefined();
  });

  it('identity: /api/whoami sí, /api/projects no; /readyz con tokens si se pasan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-split-id-'));
    const tokens = join(root, 'tokens.json');
    createToken(tokens, { name: 'admin', role: 'admin' });
    server = createSuiteServer({
      registry: createDefaultRegistry(),
      version: '0.0.0',
      tokens: TokenStore.open(tokens),
      readinessProcess: 'identity',
      readyCacheMs: 0,
    });
    const base = await listen(server);
    expect((await fetch(`${base}/api/whoami`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects`)).status).toBe(404);
    expect(await (await fetch(`${base}/readyz`)).json()).toMatchObject({ status: 'ok', checks: { tokens: 'ok' } });
    expect((await fetch(`${base}/.well-known/iark.json`)).status).toBe(404);
  });
});
