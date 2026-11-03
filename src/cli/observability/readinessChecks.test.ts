import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../registry';
import { FolderProjectStore } from '../workspace';
import { createToken, TokenStore } from '../../diagrams-identity/core/tokens';
import { buildReadinessChecks } from './readinessChecks';
import { Readiness } from './health';

describe('buildReadinessChecks (spec 009)', () => {
  it('diagrams-app: solo workspace, sin tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-app-ready-'));
    const store = new FolderProjectStore(root);
    const tokens = join(root, 'tokens.json');
    createToken(tokens, { name: 'admin', role: 'admin' });
    const ready = new Readiness(
      buildReadinessChecks({ process: 'app', projects: store, tokens: TokenStore.open(tokens) }),
      { cacheMs: 0 },
    );
    expect((await ready.status()).checks).toEqual({ workspace: 'ok' });
  });

  it('diagrams-gateway: registro y cálculo', async () => {
    const ready = new Readiness(
      buildReadinessChecks({
        process: 'gateway',
        registry: createDefaultRegistry(),
        compute: { healthy: () => true, close: async () => undefined, run: async () => ({ kind: 'ok' as const, contentType: 'application/json', body: '{}' }) },
      }),
      { cacheMs: 0 },
    );
    expect(await ready.status()).toMatchObject({ ok: true, checks: { registry: 'ok', compute: 'ok' } });
  });

  it('diagrams-identity: tokens y cuentas cuando se pasan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-id-ready-'));
    const tokens = join(root, 'tokens.json');
    createToken(tokens, { name: 'admin', role: 'admin' });
    const ready = new Readiness(
      buildReadinessChecks({ process: 'identity', tokens: TokenStore.open(tokens) }),
      { cacheMs: 0 },
    );
    expect((await ready.status()).checks).toEqual({ tokens: 'ok' });
  });

  it('diagrams-sse: comprueba el listener Postgres si se pasa', async () => {
    let pings = 0;
    const ready = new Readiness(
      buildReadinessChecks({
        process: 'sse',
        events: true,
        eventsListener: async () => {
          pings += 1;
          return pings > 0;
        },
      }),
      { cacheMs: 0 },
    );
    expect(await ready.status()).toMatchObject({ ok: true, checks: { events: 'ok' } });
    expect(pings).toBe(1);
  });
});
