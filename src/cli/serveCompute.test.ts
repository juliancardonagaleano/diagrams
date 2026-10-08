import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BETO, call as callCloud, cleanupCloud, signIn, startCloud } from '../../tests/helpers/cloud';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';
import type { ComputeExecutor } from './compute';
import { ComputePool, type ComputePoolOptions } from './computePool';
import { createDefaultRegistry } from './registry';
import { createSuiteServer, type ServeOptions } from './serve';
import { createToken, TokenStore } from './tokens';

/**
 * El cálculo de la API de `iark serve` (validar, vistas, exportar, importar, comparar, informes y trazas) corre en hilos de trabajo, con
 * tiempo límite y cola acotada, y con autenticación exige credencial; `run` no abre archivos del servidor. El hilo de trabajo de las
 * pruebas es el de verdad, empaquetado con tsup como se publica (dist/cli/compute-worker.js), o uno de mentira que se cuelga a propósito.
 */

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');
const security = example('seguridad-ejemplo.json');
const banca = example('banca.json');
const STUB = new URL('../../tests/fixtures/compute-stub-worker.mjs', import.meta.url);

const servers: Server[] = [];
const pools: ComputePool[] = [];
const folders: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await cleanupCloud();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Un servidor que se apaga al terminar la prueba. */
async function start(options: Partial<ServeOptions> = {}): Promise<string> {
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', ...options });
  servers.push(server);
  return listen(server);
}

function newPool(options: ComputePoolOptions = {}): ComputePool {
  const pool = new ComputePool({ workerFile: STUB, size: 1, timeoutMs: 10_000, ...options });
  pools.push(pool);
  return pool;
}

const post = (base: string, path: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', body, headers });
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
// El .drawio lleva la hora de la exportación (`modified`): lo único que difiere entre dos cálculos del mismo documento.
const snapshot = async (res: Response) => ({ status: res.status, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), body: (await res.text()).replace(/modified="[^"]*"/, 'modified="…"') });

// El CLI y su hilo de trabajo, empaquetados una vez con tsup (como se publican) para todo el archivo.
let bundle: CliBundle;
beforeAll(async () => {
  bundle = await buildCliBundle('serve-compute');
});
afterAll(() => bundle?.dispose());

// ───────────── el hilo de trabajo de verdad ─────────────

describe('iark serve: el cálculo corre en el hilo de trabajo empaquetado', () => {
  let pool: ComputePool;
  const shared: Server[] = [];
  let pooled: string;
  let inline: string;
  let mermaid: string;
  const platform = example('plataforma-ejemplo.json');

  beforeAll(async () => {
    pool = new ComputePool({ workerFile: join(dirname(bundle.cli), 'compute-worker.js'), size: 2, timeoutMs: 90_000 });
    // Servidores de todo el bloque (los de `start` se apagan tras cada prueba).
    shared.push(createSuiteServer({ registry: createDefaultRegistry(), version: '1', compute: pool }), createSuiteServer({ registry: createDefaultRegistry(), version: '1' }));
    [pooled, inline] = await Promise.all(shared.map(listen));
    mermaid = await (await post(inline, '/api/security/export?format=mermaid&view=dfd', security)).text();
  });
  afterAll(async () => {
    for (const server of shared) server.close();
    await pool?.close();
  });

  it('tsup construye el hilo de trabajo junto al CLI, donde lo busca el pool', () => {
    expect(existsSync(join(dirname(bundle.cli), 'compute-worker.js'))).toBe(true);
  });

  const documents = (): string => JSON.stringify({ documents: [{ module: 'security', document: JSON.parse(security) }, { module: 'platform', document: JSON.parse(platform) }, { module: 'integration', document: JSON.parse(example('pedidos-integracion.json')) }], from: 'urn:iark:integration:pedidos', direction: 'referrers' });
  const cases: Array<[string, string, () => string]> = [
    ['validar', '/api/security/validate', () => security],
    ['validar un documento que no cumple el esquema', '/api/security/validate', () => JSON.stringify({ zones: [{ id: 'z', name: 'Z', trust: 'x' }] })],
    ['validar sin documento (400)', '/api/security/validate', () => '  '],
    ['vistas', '/api/security/views', () => security],
    ['vistas de un documento inválido (422 con incidencias)', '/api/security/views', () => JSON.stringify({ version: '9', zones: 1 })],
    ['exportar a SVG con el CSP del archivo', '/api/security/export?format=svg&view=blast:pedidos', () => security],
    ['exportar a Mermaid', '/api/security/export?format=mermaid&view=dfd', () => security],
    ['exportar a un formato que no existe (400 con la lista)', '/api/security/export?format=pdf', () => security],
    ['exportar C4 a SVG (ELK)', '/api/c4/export?format=svg', () => banca],
    ['exportar C4 a draw.io (ELK)', '/api/c4/export?format=drawio', () => banca],
    ['importar Mermaid', '/api/security/import?importer=mermaid&name=Importado', () => mermaid],
    ['importar algo que no se reconoce (400)', '/api/security/import', () => 'esto no es nada'],
    ['comparar', '/api/security/diff', () => JSON.stringify({ before: security, after: security })],
    ['comparar sin «after» (400)', '/api/security/diff', () => JSON.stringify({ before: security })],
    ['informe', '/api/security/run/risks', () => JSON.stringify({ input: JSON.parse(security), options: { status: 'open' } })],
    ['informe con un argumento', '/api/data/run/lineage', () => JSON.stringify({ input: example('ventas-datos.json'), args: ['dwh-fact-ventas'] })],
    ['conversión', '/api/security/run/from-integration', () => JSON.stringify({ input: JSON.parse(example('pedidos-integracion.json')) })],
    ['informe sin entrada (400)', '/api/security/run/risks', () => '{}'],
    ['comando que no existe (400)', '/api/security/run/nada', () => '{}'],
    ['trazabilidad (grafo y SVG)', '/api/trace', documents],
    ['trazabilidad con un cuerpo roto (400)', '/api/trace', () => '{ roto'],
  ];

  it.each(cases)('responde lo mismo que calculando en el propio proceso: %s', async (_name, path, body) => {
    const [a, b] = await Promise.all([post(pooled, path, body()), post(inline, path, body())]);
    expect(await snapshot(a)).toEqual(await snapshot(b));
  });

  it('el cálculo se hizo en hilos del pool', () => {
    expect(pool.workers).toBeGreaterThanOrEqual(1);
    expect(pool.workers).toBeLessThanOrEqual(2);
  });

  it('un módulo o una ruta que no existen se responden sin pedirle nada al pool', async () => {
    const executor: ComputeExecutor = { run: vi.fn(), close: async () => {} };
    const base = await start({ compute: executor });
    expect((await post(base, '/api/nada/validate', '{}')).status).toBe(404);
    expect((await post(base, '/api/security/run', '{}')).status).toBe(404); // falta el comando
    expect((await fetch(`${base}/api/security/validate`)).status).toBe(405); // método equivocado
    expect(executor.run).not.toHaveBeenCalled();
  });

  describe('POST /api/<módulo>/run/<comando> no abre archivos del servidor', () => {
    const dirs: string[] = [];
    afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    const ask = (base: string, options: unknown) => post(base, '/api/platform/run/icons', JSON.stringify({ input: JSON.parse(platform), options }), { 'Content-Type': 'application/json' });

    it.each([
      ['en el hilo de trabajo', () => pooled],
      ['en el propio proceso', () => inline],
    ])('rechaza options.pack con 400, con el mismo texto exista o no el archivo y sin filtrar su contenido (%s)', async (_where, base) => {
      const dir = mkdtempSync(join(tmpdir(), 'iark-run-pack-'));
      dirs.push(dir);
      const secret = join(dir, 'secreto');
      writeFileSync(secret, '{"clave":"valor-secreto-que-no-debe-salir"');
      const answers = [];
      for (const pack of [secret, join(dir, 'no-existe.json'), '/dev/zero', '/etc/hostname', '../../etc/passwd', true]) {
        const res = await ask(base(), { pack });
        expect(res.status, String(pack)).toBe(400);
        answers.push(await res.text());
      }
      expect(new Set(answers).size).toBe(1);
      const error = JSON.parse(answers[0]).error as string;
      expect(error).toMatch(/«--pack» de «icons» solo está disponible en el CLI local/);
      for (const leak of ['valor-secreto', 'clave', dir, 'ENOENT', 'JSON']) expect(answers[0]).not.toContain(leak);
    });

    it.each([
      ['en el hilo de trabajo', () => pooled],
      ['en el propio proceso', () => inline],
    ])('importar un DSL de Structurizr no resuelve sus !include contra el disco del servidor (%s)', async (_where, base) => {
      const dir = mkdtempSync(join(tmpdir(), 'iark-import-include-'));
      dirs.push(dir);
      const secret = join(dir, 'secreto.dsl');
      writeFileSync(secret, 'model { espia = person "valor-secreto-del-include" }');
      const dsl = `workspace "Prueba" {\n  !include ${secret}\n  model {\n    ana = person "Ana"\n  }\n  views {\n    systemLandscape { include * }\n  }\n}\n`;
      const res = await post(base(), '/api/c4/import?importer=dsl', dsl);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('no se puede resolver aquí');
      expect(text).not.toContain('valor-secreto-del-include');
    });

    it('sin la opción local el mismo comando funciona, y las opciones que no son texto o booleano se rechazan', async () => {
      const ok = await ask(inline, {});
      expect(ok.status).toBe(200);
      expect((await ok.json()).output).toContain('Paquetes de iconos');
      expect((await ask(pooled, { pack: '' })).status).toBe(200); // vacía = no indicada
      const bad = await post(pooled, '/api/platform/run/impact', JSON.stringify({ input: JSON.parse(platform), args: ['pedidos'], options: { direction: { x: 1 } } }));
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toMatch(/«direction» debe ser un texto, un número o un booleano/);
      expect((await post(inline, '/api/platform/run/impact', 'null')).status).toBe(400);
    });
  });
});

// ───────────── el hilo principal sigue libre; tiempo límite y cola ─────────────

describe('iark serve: el hilo principal sigue atendiendo mientras se calcula', () => {
  it('un cálculo que se cuelga no frena /api/modules, /api/whoami ni el manifiesto, y al vencer el tiempo límite responde 503', async () => {
    const pool = newPool({ timeoutMs: 3000 });
    const base = await start({ compute: pool });
    let settled = false;
    const hung = post(base, '/api/security/validate', 'hang').then(async (res) => {
      settled = true;
      return { status: res.status, body: await res.json() };
    });
    await vi.waitFor(() => expect(pool.active).toBe(1)); // el hilo ya tiene el trabajo
    for (let round = 0; round < 3; round++) {
      for (const path of ['/api/modules', '/api/whoami', '/.well-known/iark.json', '/api/security/capabilities']) {
        const started = Date.now();
        const res = await fetch(`${base}${path}`);
        expect(res.status, path).toBe(200);
        expect(Date.now() - started, path).toBeLessThan(1000);
      }
    }
    expect(settled).toBe(false); // todo eso respondió con el cálculo todavía en marcha
    const result = await hung;
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'timeout' });
    expect(result.body.error).toMatch(/tiempo límite de 3 s/);
    // el servicio sigue entero y el siguiente cálculo va a un hilo de relevo
    const next = await post(base, '/api/security/validate', 'otra vez');
    expect(next.status).toBe(200);
    expect(await next.text()).toMatch(/^eco:validate:otra vez:\d+$/);
  });

  it('con todos los hilos ocupados y la cola llena responde 503 con Retry-After; lo que cupo se atiende y lo que cuelga en la cola se descarta', async () => {
    const pool = newPool({ maxQueue: 1, retryAfterSeconds: 3 });
    const base = await start({ compute: pool });
    const running = post(base, '/api/security/validate', 'slow:600');
    await vi.waitFor(() => expect(pool.active).toBe(1));
    const waiting = post(base, '/api/security/validate', 'slow:10');
    await vi.waitFor(() => expect(pool.queued).toBe(1));
    const rejected = await post(base, '/api/security/export?format=svg', 'cualquiera');
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('3');
    expect(await rejected.json()).toMatchObject({ code: 'busy', error: expect.stringMatching(/ocupado calculando/) });
    // las rutas que no calculan no hacen cola
    expect((await fetch(`${base}/api/modules`)).status).toBe(200);
    expect((await running).status).toBe(200);
    expect((await waiting).status).toBe(200);

    // un cliente que se va con su operación en cola la deja sin calcular
    const first = post(base, '/api/security/validate', 'slow:400');
    await vi.waitFor(() => expect(pool.active).toBe(1));
    const gone = new AbortController();
    const abandoned = fetch(`${base}/api/security/validate`, { method: 'POST', body: 'nadie la espera', signal: gone.signal }).catch(() => 'cancelada');
    await vi.waitFor(() => expect(pool.queued).toBe(1));
    gone.abort();
    expect(await abandoned).toBe('cancelada');
    await vi.waitFor(() => expect(pool.queued).toBe(0));
    expect((await first).status).toBe(200);
  });

  it('un error de la petición llega como 4xx con su mensaje y un fallo del programa como 500 sin detalles (y con su traza en stderr)', async () => {
    const pool = newPool();
    const base = await start({ compute: pool });
    const invalid = await post(base, '/api/security/validate', 'http-error');
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: 'No vale.', issues: [{ path: 'a', message: 'b' }] });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const body of ['internal', 'crash']) {
        const res = await post(base, '/api/security/validate', body);
        expect(res.status, body).toBe(500);
        expect(await res.json()).toEqual({ error: 'Error interno del servicio.' });
      }
      const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(logged).toContain('error interno: Error: falló el programa');
      expect(logged).toContain('boom');
    } finally {
      stderr.mockRestore();
    }
  });
});

// ───────────── autenticación de las rutas de cálculo ─────────────

describe('iark serve: las rutas de cálculo exigen credencial cuando hay tokens o cuentas', () => {
  const mermaidText = 'flowchart TD\n  a[A] --> b[B]';
  const platform = example('plataforma-ejemplo.json');
  const compute: Array<[string, string, string]> = [
    ['validate', '/api/security/validate', security],
    ['views', '/api/security/views', security],
    ['export', '/api/security/export?format=mermaid&view=dfd', security],
    ['import', '/api/c4/import?importer=mermaid', mermaidText],
    ['diff', '/api/security/diff', JSON.stringify({ before: security, after: security })],
    ['run', '/api/security/run/risks', JSON.stringify({ input: JSON.parse(security) })],
    ['run (comando de plataforma)', '/api/platform/run/icons', JSON.stringify({ input: JSON.parse(platform) })],
    ['trace', '/api/trace', JSON.stringify({ documents: [{ module: 'security', document: JSON.parse(security) }] })],
  ];
  const open = ['/api/modules', '/api/security/capabilities', '/api/security/schema', '/api/security/schema?kind=generation', '/.well-known/iark.json'];

  async function withTokens(options: Partial<ServeOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'iark-compute-auth-'));
    folders.push(dir);
    const file = join(dir, 'tokens.json');
    const tokens = { viewer: createToken(file, { name: 'Vic', role: 'viewer' }).token, admin: createToken(file, { name: 'Ana', role: 'admin' }).token };
    const run = vi.fn<ComputeExecutor['run']>(async () => ({ kind: 'ok', contentType: 'text/plain; charset=utf-8', body: 'calculado' }));
    // Sin `projects`: los tokens también protegen el cálculo aunque no haya espacio de trabajo.
    const base = await start({ tokens: TokenStore.open(file), compute: { run, close: async () => {} }, authLimits: { freeAttempts: 1000 }, ...options });
    return { base, tokens, run };
  }

  it.each(compute)('%s: 401 sin credencial (sin leer el cuerpo ni calcular), 401 con un token que no vale, 200 con un token de cualquier rol', async (_name, path, body) => {
    const { base, tokens, run } = await withTokens();
    for (const headers of [{}, bearer('iark_no-existe'), { Authorization: 'Basic eDp5' }, { Authorization: tokens.viewer.slice(0, -1) }]) {
      const res = await post(base, path, body, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="iark"');
      expect(await res.json()).toMatchObject({ code: 'unauthorized' });
    }
    expect(run).not.toHaveBeenCalled();
    expect((await post(base, path, body, bearer(tokens.viewer))).status).toBe(200); // un viewer basta
    expect((await post(base, path, body, bearer(tokens.admin))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('la respuesta no depende de si el módulo, el comando o el método existen: sin credencial siempre 401', async () => {
    const { base, tokens, run } = await withTokens();
    for (const [method, path] of [['POST', '/api/nada/validate'], ['GET', '/api/security/validate'], ['POST', '/api/security/run'], ['DELETE', '/api/security/export'], ['GET', '/api/trace']] as const) {
      expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
    // con credencial, las respuestas de siempre
    expect((await post(base, '/api/nada/validate', '{}', bearer(tokens.viewer))).status).toBe(404);
    expect((await fetch(`${base}/api/security/validate`, { headers: bearer(tokens.viewer) })).status).toBe(405);
    expect(run).not.toHaveBeenCalled();
  });

  it('siguen públicos /api/modules, capabilities, schema y el manifiesto: la federación los descubre sin credencial', async () => {
    const { base } = await withTokens();
    for (const path of open) expect((await fetch(`${base}${path}`)).status, path).toBe(200);
  });

  it('--public-compute (publicCompute) restaura el cálculo abierto, y los tokens siguen protegiendo lo demás', async () => {
    const { base, run } = await withTokens({ publicCompute: true });
    for (const [name, path, body] of compute) expect((await post(base, path, body)).status, name).toBe(200);
    expect(run).toHaveBeenCalledTimes(compute.length);
    expect((await fetch(`${base}/api/whoami`)).status).toBe(401);
  });

  it('sin tokens ni cuentas todo queda abierto como siempre, con o sin publicCompute', async () => {
    for (const publicCompute of [undefined, true]) {
      const base = await start({ publicCompute });
      for (const [name, path, body] of compute) {
        const status = (await post(base, path, body)).status;
        expect(status, `${name} ${publicCompute}`).not.toBe(401);
        expect(status, `${name} ${publicCompute}`).toBeLessThan(500); // (el Mermaid de ejemplo puede no ser de C4: 400)
      }
    }
  });

  it('el freno de intentos fallidos también cuenta aquí: con credenciales equivocadas repetidas, 429', async () => {
    const { base, tokens } = await withTokens({ authLimits: { freeAttempts: 2 } });
    const wrong = bearer('iark_equivocado');
    expect((await post(base, '/api/security/validate', security, wrong)).status).toBe(401);
    expect((await post(base, '/api/security/validate', security, wrong)).status).toBe(401);
    const limited = await post(base, '/api/security/validate', security, wrong);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await post(base, '/api/trace', '{}', bearer(tokens.admin))).status).toBe(429); // frenada la dirección, también con un token bueno
  });

  it('con cuentas de GitHub vale la sesión de cualquier persona, también la de una invitada', async () => {
    const cloud = await startCloud({ signup: 'open', serve: { compute: { run: async () => ({ kind: 'ok', contentType: 'text/plain; charset=utf-8', body: 'calculado' }), close: async () => {} } } });
    const session = await signIn(cloud, BETO);
    expect(await (await post(cloud.base, '/api/security/validate', security)).json()).toMatchObject({ code: 'unauthorized' });
    expect((await post(cloud.base, '/api/security/validate', security, bearer(session))).status).toBe(200);
    expect((await callCloud(cloud.base, session).post('/api/trace', '{}')).status).toBe(200);
    expect((await fetch(`${cloud.base}/api/security/capabilities`)).status).toBe(200);
    // sin sesión de verdad (cerrada): vuelve a ser 401
    expect((await callCloud(cloud.base, session).post('/api/auth/logout')).status).toBe(200);
    expect((await post(cloud.base, '/api/security/validate', security, bearer(session))).status).toBe(401);

    const publicCompute = await startCloud({ signup: 'open', serve: { publicCompute: true, compute: { run: async () => ({ kind: 'ok', contentType: 'text/plain; charset=utf-8', body: 'calculado' }), close: async () => {} } } });
    expect((await post(publicCompute.base, '/api/security/validate', security)).status).toBe(200);
  });

  it('CORS: las rutas de cálculo con credencial anuncian Authorization en el preflight; las públicas, lo de siempre', async () => {
    const preflight = (base: string, path: string) => fetch(`${base}${path}`, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
    const guarded = await withTokens({ cors: ['*'] });
    for (const path of ['/api/security/export', '/api/security/run/risks', '/api/trace', '/api/security/validate']) {
      const res = await preflight(guarded.base, path);
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-headers'), path).toBe('Content-Type, Authorization');
    }
    for (const path of ['/api/modules', '/api/security/capabilities', '/api/security/schema']) {
      expect((await preflight(guarded.base, path)).headers.get('access-control-allow-headers'), path).toBe('Content-Type');
    }
    // una respuesta 401 también lleva las cabeceras de CORS: el navegador deja leer el motivo
    const denied = await post(guarded.base, '/api/security/validate', security, { Origin: 'https://app.example' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');

    const open = await withTokens({ cors: ['*'], publicCompute: true });
    expect((await preflight(open.base, '/api/security/export')).headers.get('access-control-allow-headers')).toBe('Content-Type');
  });
});

// ───────────── `iark serve` como proceso ─────────────

describe('iark serve (comando): hilos de trabajo, tiempo límite y autenticación del cálculo', () => {
  async function startCli(args: string[], env: Record<string, string> = {}): Promise<{ url: string; stderr: () => string; stop: () => Promise<number | null> }> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    children.push(child);
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no arrancó: ${stderr}`)), PROCESS_TEST_TIMEOUT - 10_000);
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => reject(new Error(`terminó con ${code}: ${stderr}`)));
    });
    return {
      url,
      stderr: () => stderr,
      stop: () => {
        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        return exited;
      },
    };
  }

  it('calcula en hilos de trabajo (el hilo empaquetado está junto al CLI), anuncia los límites y se detiene limpiamente con SIGTERM', async () => {
    const cli = await startCli(['--workers', '1', '--compute-timeout', '45s', '--compute-queue', '3']);
    await vi.waitFor(() => expect(cli.stderr()).toContain('cálculo: hasta 1 hilo(s) de trabajo · tiempo límite 45 s por operación · cola de 3'));
    const svg = await post(cli.url, '/api/security/export?format=svg&view=blast:pedidos', security);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect((await svg.text()).startsWith('<svg')).toBe(true);
    const banking = await post(cli.url, '/api/c4/export?format=svg', banca); // ELK
    expect(banking.status).toBe(200);
    expect((await fetch(`${cli.url}/api/modules`)).status).toBe(200);
    expect(await cli.stop()).toBe(0);
  });

  it('con --tokens (también sin espacio de trabajo) el cálculo exige credencial; --public-compute y --workers 0 lo dicen al arrancar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-compute-cli-'));
    folders.push(dir);
    const file = join(dir, 'tokens.json');
    const { token } = createToken(file, { name: 'Vic', role: 'viewer' });
    const guarded = await startCli(['--tokens', file, '--workers', '1']);
    await vi.waitFor(() => expect(guarded.stderr()).toContain('las rutas de cálculo (validar, exportar, importar, informes, trazas) exigen credencial'));
    expect((await post(guarded.url, '/api/security/validate', security)).status).toBe(401);
    expect((await post(guarded.url, '/api/security/validate', security, bearer(token))).status).toBe(200);
    expect((await fetch(`${guarded.url}/api/modules`)).status).toBe(200);
    expect(await guarded.stop()).toBe(0);

    const open = await startCli(['--tokens', file, '--public-compute', '--workers', '0']);
    await vi.waitFor(() => expect(open.stderr()).toContain('aviso: --public-compute'));
    expect(open.stderr()).toContain('aviso: --workers 0');
    expect((await post(open.url, '/api/security/validate', security)).status).toBe(200);
    expect(await open.stop()).toBe(0);

    const viaEnv = await startCli(['--tokens', file], { IARK_PUBLIC_COMPUTE: '1', IARK_WORKERS: '1', IARK_COMPUTE_QUEUE: '2', IARK_COMPUTE_TIMEOUT_MS: '20000' });
    await vi.waitFor(() => expect(viaEnv.stderr()).toContain('cálculo: hasta 1 hilo(s) de trabajo · tiempo límite 20 s por operación · cola de 2'));
    expect((await post(viaEnv.url, '/api/security/validate', security)).status).toBe(200);
    await viaEnv.stop();
  });
});
