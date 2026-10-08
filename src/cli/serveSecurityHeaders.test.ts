import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultRegistry } from './registry';
import { HSTS } from './securityHeaders';
import { createSuiteServer, type ServeOptions } from './serve';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';

// El último bloque arranca el CLI como proceso (se empaqueta una vez), con margen de sobra por si la máquina está saturada.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

/** Un sitio mínimo con la forma del compilado: páginas HTML, un asset con hash, un JSON y un SVG. */
function makeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iark-sitio-cabeceras-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'schema'));
  for (const page of ['index.html', 'modulos.html', 'suite.html']) writeFileSync(join(dir, page), '<!doctype html><title>x</title><script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'export {};');
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}');
  writeFileSync(join(dir, 'schema', 'x.schema.json'), '{}');
  return dir;
}

async function start(options: Partial<ServeOptions> = {}): Promise<{ server: Server; base: string }> {
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '0.0.0', ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const frameAncestors = (res: Response): string => /frame-ancestors ([^;]*)/.exec(res.headers.get('content-security-policy') ?? '')?.[1] ?? '';

describe('iark serve: cabeceras de seguridad (HTTP real)', () => {
  const site = makeSite();
  let server: Server;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await start({ staticDir: site }));
  });
  afterAll(() => {
    server.close();
    rmSync(site, { recursive: true, force: true });
  });

  it('las páginas HTML llevan CSP, Referrer-Policy, Permissions-Policy, nosniff y solo ellas mismas como marco', async () => {
    for (const path of ['/', '/index.html', '/modulos.html?module=data', '/suite.html']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('permissions-policy'), path).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
      expect(res.headers.get('x-frame-options'), path).toBe('SAMEORIGIN');
      const csp = res.headers.get('content-security-policy')!;
      expect(csp, path).toContain("script-src 'self';");
      expect(csp, path).toContain("object-src 'none'");
      expect(frameAncestors(res), path).toBe("'self'");
      expect(res.headers.get('cache-control'), path).toBe('no-cache'); // lo que ya ponía el servicio sigue ahí
    }
  });

  it('una carga embebida (?embed=1) se puede incrustar desde cualquier sitio por omisión, y sin X-Frame-Options', async () => {
    const res = await fetch(`${base}/modulos.html?embed=1&proto=json&module=data&origin=https%3A%2F%2Fhost.example`);
    expect(frameAncestors(res)).toBe('*');
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self';");
    expect(frameAncestors(await fetch(`${base}/?embed=1&proto=json`))).toBe('*');
  });

  it('los scripts, estilos y JSON del sitio y la API no llevan CSP ni políticas de documento, solo nosniff', async () => {
    for (const path of ['/assets/app.js', '/assets/app.css', '/schema/x.schema.json', '/.well-known/iark.json', '/api/modules', '/api/security/capabilities']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      for (const name of ['content-security-policy', 'referrer-policy', 'permissions-policy', 'x-frame-options', 'strict-transport-security']) expect(res.headers.get(name), `${path} ${name}`).toBeNull();
    }
    expect((await fetch(`${base}/api/modules?embed=1`)).headers.get('content-security-policy')).toBeNull();
  });

  it('también las respuestas de error y las de HEAD/OPTIONS llevan lo que les toca', async () => {
    const notFound = await fetch(`${base}/no-existe.html`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff');
    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    expect(head.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const options = await fetch(`${base}/api/modules`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sin proxy de confianza no hay HSTS aunque el cliente mande X-Forwarded-Proto: https (no es una conexión https)', async () => {
    const res = await fetch(`${base}/index.html`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('el SVG exportado conserva su propia CSP restrictiva (la del servicio prevalece)', async () => {
    const res = await fetch(`${base}/api/security/export?format=svg`, { method: 'POST', body: readFileSync('examples/seguridad-ejemplo.json', 'utf8') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });
});

describe('iark serve: HSTS tras un proxy de confianza', () => {
  const site = makeSite();
  let server: Server;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await start({ staticDir: site, trustProxy: true }));
  });
  afterAll(() => {
    server.close();
    rmSync(site, { recursive: true, force: true });
  });

  it('solo si el proxy dice que la petición era https', async () => {
    const secure = { 'x-forwarded-proto': 'https' };
    for (const path of ['/index.html', '/assets/app.js', '/api/modules']) {
      expect((await fetch(`${base}${path}`, { headers: secure })).headers.get('strict-transport-security'), path).toBe(HSTS);
    }
    expect((await fetch(`${base}/index.html`, { headers: { 'x-forwarded-proto': 'http' } })).headers.get('strict-transport-security')).toBeNull();
    expect((await fetch(`${base}/index.html`)).headers.get('strict-transport-security')).toBeNull();
  });
});

describe('iark serve: quién puede incrustar las cargas embebidas', () => {
  const site = makeSite();
  let server: Server;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await start({ staticDir: site, frameAncestors: ['https://app.example', 'https://*.partner.example'] }));
  });
  afterAll(() => {
    server.close();
    rmSync(site, { recursive: true, force: true });
  });

  it('la lista configurada rige solo las cargas embebidas, y siempre incluye self (el banco incrusta el editor C4)', async () => {
    expect(frameAncestors(await fetch(`${base}/?embed=1`))).toBe("'self' https://app.example https://*.partner.example");
    expect(frameAncestors(await fetch(`${base}/modulos.html?embed=1&module=data`))).toBe("'self' https://app.example https://*.partner.example");
    expect(frameAncestors(await fetch(`${base}/`))).toBe("'self'");
  });
});

describe('iark serve --frame-ancestors / IARK_FRAME_ANCESTORS (comando)', () => {
  let bundle: CliBundle;
  const site = makeSite();
  beforeAll(async () => {
    bundle = await buildCliBundle('serve-cabeceras');
  });
  afterAll(() => {
    bundle?.dispose();
    rmSync(site, { recursive: true, force: true });
  });

  /** Arranca el CLI, deja que `check` consulte el servicio y lo para; devuelve lo que `check` devolvió. */
  async function withServer<T>(args: string[], env: Record<string, string>, check: (url: string) => Promise<T>): Promise<T> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', '--static', site, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`no arrancó: ${stderr}`));
      }, PROCESS_TEST_TIMEOUT - 10_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    try {
      return await check(url);
    } finally {
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
  }

  it('el valor del argumento y el de la variable de entorno llegan a la cabecera (el argumento gana)', async () => {
    expect(await withServer(['--frame-ancestors', 'https://host.example'], {}, async (url) => frameAncestors(await fetch(`${url}/?embed=1`)))).toBe("'self' https://host.example");
    expect(await withServer([], { IARK_FRAME_ANCESTORS: 'https://uno.example, https://dos.example' }, async (url) => frameAncestors(await fetch(`${url}/?embed=1`)))).toBe("'self' https://uno.example https://dos.example");
    expect(await withServer(['--frame-ancestors', 'https://arg.example'], { IARK_FRAME_ANCESTORS: 'https://env.example' }, async (url) => frameAncestors(await fetch(`${url}/?embed=1`)))).toBe("'self' https://arg.example");
    expect(await withServer([], { IARK_FRAME_ANCESTORS: '' }, async (url) => frameAncestors(await fetch(`${url}/?embed=1`)))).toBe('*');
  });

  it('un origen inválido impide arrancar con un error de uso (código 2) en vez de acabar dentro de la cabecera', async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', '--frame-ancestors', "https://a.example; script-src 'unsafe-inline'"], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no es un origen válido para frame-ancestors/);
  });
});
