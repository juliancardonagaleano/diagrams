import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifestSchema } from '@iark/kernel';
import { createDefaultRegistry } from './registry';
import { createSuiteServer } from './serve';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';

// `iark serve (comando)` arranca el CLI como proceso: se empaqueta una vez y se ejecuta con `node` (en vez de arrancar
// `tsx` en cada llamada), con margen de sobra por si la máquina está saturada.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');
const security = example('seguridad-ejemplo.json');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('iark serve: API por módulo', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createSuiteServer({ registry: createDefaultRegistry(), version: '9.9.9' });
    base = await listen(server);
  });
  afterAll(() => void server.close());

  const post = (path: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', body, headers });

  it('publica el manifiesto de la instancia con la API por módulo y sin editores (no sirve el sitio)', async () => {
    const res = await fetch(`${base}/.well-known/iark.json`);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.version).toBe('9.9.9');
    const data = manifest.modules.find((m: { id: string }) => m.id === 'data');
    expect(data.endpoints).toEqual({ schema: '../api/data/schema', api: '../api/data' });
  });

  it('lista los módulos y sus capacidades', async () => {
    const modules = await (await fetch(`${base}/api/modules`)).json();
    expect(modules.map((m: { id: string }) => m.id)).toEqual(['c4', 'integration', 'data', 'enterprise', 'platform', 'security']);
    const caps = await (await fetch(`${base}/api/security/capabilities`)).json();
    expect(caps.exportFormats.map((f: { id: string }) => f.id)).toEqual(['json', 'mermaid', 'svg', 'drawio']);
    expect(caps.commands.map((c: { name: string }) => c.name)).toContain('risks');
  });

  it('entrega el JSON Schema del documento y el de la salida de IA', async () => {
    const doc = await (await fetch(`${base}/api/security/schema`)).json();
    expect(doc.type).toBe('object');
    const gen = await (await fetch(`${base}/api/security/schema?kind=generation`)).json();
    expect(gen.type).toBe('object');
    expect((await fetch(`${base}/api/security/schema?kind=otro`)).status).toBe(400);
  });

  it('valida un documento: válido, con problemas de dominio, de esquema y con JSON roto', async () => {
    const ok = await (await post('/api/security/validate', security)).json();
    expect(ok).toMatchObject({ module: 'security', valid: true, schemaIssues: [] });
    expect(ok.issues.some((i: { severity: string }) => i.severity === 'warning')).toBe(true);
    const bad = await (await post('/api/security/validate', JSON.stringify({ zones: [{ id: 'z', name: 'Z', trust: 'x' }] }))).json();
    expect(bad.valid).toBe(false);
    expect(bad.schemaIssues[0].path).toContain('zones');
    const syntax = await (await post('/api/security/validate', '{ roto')).json();
    expect(syntax.valid).toBe(false);
    expect((await post('/api/security/validate', '  ')).status).toBe(400);
  });

  it('lista las vistas y las vistas de traza de un documento', async () => {
    const views = await (await post('/api/security/views', security)).json();
    expect(views.views.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(['dfd', 'threats']));
    expect(views.traces.map((t: { prefix: string }) => t.prefix)).toEqual(['blast', 'exposure', 'focus']);
    const invalid = await post('/api/security/views', JSON.stringify({ version: '9', zones: 1 }));
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).issues.length).toBeGreaterThan(0);
  });

  it('exporta con el tipo de contenido del formato y rechaza los que no existen', async () => {
    const svg = await post('/api/security/export?format=svg&view=blast:pedidos', security);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await svg.text()).startsWith('<svg')).toBe(true);
    const mermaid = await (await post('/api/security/export?format=mermaid&view=dfd', security)).text();
    expect(mermaid.startsWith('flowchart')).toBe(true);
    const json = await post('/api/security/export', security);
    expect(json.headers.get('content-type')).toContain('application/json');
    const pdf = await post('/api/security/export?format=pdf', security);
    expect(pdf.status).toBe(400);
    expect((await pdf.json()).formats).toEqual(['json', 'mermaid', 'svg', 'drawio']);
  });

  it('importa Mermaid a un documento del módulo y explica los errores', async () => {
    const mermaid = await (await post('/api/security/export?format=mermaid&view=dfd', security)).text();
    const imported = await (await post('/api/security/import?importer=mermaid&name=Importado', mermaid)).json();
    expect(imported.importer).toBe('mermaid');
    expect(imported.document.workspace.name).toBe('Importado');
    expect((await post('/api/security/import', 'esto no es nada')).status).toBe(400);
    expect((await post('/api/security/import', '')).status).toBe(400);
    expect((await post('/api/security/import?importer=drawio', mermaid)).status).toBe(400);
  });

  it('ejecuta informes y conversiones del módulo con la envoltura JSON', async () => {
    const risks = await (await post('/api/security/run/risks', JSON.stringify({ input: JSON.parse(security), options: { status: 'open' } }))).json();
    expect(risks).toMatchObject({ module: 'security', command: 'risks', kind: 'report' });
    expect(risks.output).toContain('| Riesgo |');
    const lineage = await (await post('/api/data/run/lineage', JSON.stringify({ input: example('ventas-datos.json'), args: ['dwh-fact-ventas'] }))).json();
    expect(lineage.output.length).toBeGreaterThan(20);
    const converted = await (await post('/api/security/run/from-integration', JSON.stringify({ input: JSON.parse(example('pedidos-integracion.json')) }))).json();
    expect(converted.kind).toBe('convert');
    expect(JSON.parse(converted.output).zones).toBeDefined();

    const noInput = await post('/api/security/run/risks', '{}');
    expect(noInput.status).toBe(400);
    expect((await noInput.json()).error).toMatch(/Falta la entrada/);
    expect((await post('/api/security/run/nada', '{}')).status).toBe(400);
    expect((await post('/api/security/run', '{}')).status).toBe(404);
    expect((await post('/api/security/run/risks', '{ roto')).status).toBe(400);
  });

  it('run no lee archivos del servidor: `icons --pack` se rechaza con 400 y el mismo texto exista o no el archivo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-run-pack-'));
    try {
      const secret = join(dir, 'secreto.json');
      writeFileSync(secret, '{"clave":"valor-secreto-que-no-debe-salir"');
      const input = JSON.parse(example('plataforma-ejemplo.json'));
      const ask = (pack: unknown) => post('/api/platform/run/icons', JSON.stringify({ input, options: { pack } }));
      const existing = await ask(secret);
      const missing = await ask(join(dir, 'no-existe.json'));
      expect(existing.status).toBe(400);
      expect(missing.status).toBe(400);
      const text = await existing.text();
      expect(text).toBe(await missing.text()); // no es un oráculo de qué archivos existen
      expect(text).toMatch(/«--pack» de «icons» solo está disponible en el CLI local/);
      for (const leak of ['valor-secreto', dir, 'ENOENT']) expect(text).not.toContain(leak);
      // sin la opción local, el mismo comando funciona por HTTP
      const ok = await post('/api/platform/run/icons', JSON.stringify({ input }));
      expect(ok.status).toBe(200);
      expect((await ok.json()).output).toContain('Paquetes de iconos');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reúne documentos de varios módulos y sigue sus referencias (POST /api/trace)', async () => {
    const documents = [
      { module: 'security', document: JSON.parse(security), source: 'seguridad.json' },
      { module: 'platform', document: JSON.parse(example('plataforma-ejemplo.json')) },
      { module: 'integration', document: JSON.parse(example('pedidos-integracion.json')) },
    ];
    const general = await (await post('/api/trace', JSON.stringify({ documents }))).json();
    expect(general.graph.links).toHaveLength(11);
    expect(general.report).toContain('3 documentos');
    expect(general.mermaid.startsWith('flowchart LR')).toBe(true);
    expect(general.svg.startsWith('<svg')).toBe(true);
    const impact = await (await post('/api/trace', JSON.stringify({ documents, from: 'urn:iark:integration:pedidos', direction: 'referrers' }))).json();
    expect(impact.reached.map((r: { node: { urn: string } }) => r.node.urn)).toEqual(['urn:iark:integration:pedidos', 'urn:iark:platform:pedidos', 'urn:iark:security:pedidos']);
    expect(impact.report).toContain('a 2 saltos');

    expect((await post('/api/trace', '{ roto')).status).toBe(400);
    expect((await post('/api/trace', JSON.stringify({ documents: [] }))).status).toBe(400);
    expect((await post('/api/trace', JSON.stringify({ documents: [{ document: {} }] }))).status).toBe(400);
    expect((await post('/api/trace', JSON.stringify({ documents: [{ module: 'nada', document: {} }] }))).status).toBe(404);
    const bad = await post('/api/trace', JSON.stringify({ documents: [{ module: 'security', document: { version: '9', zones: 1 } }] }));
    expect(bad.status).toBe(422);
    const unknownStart = await post('/api/trace', JSON.stringify({ documents, from: 'urn:iark:platform:nada' }));
    expect(unknownStart.status).toBe(400);
    expect((await unknownStart.json()).error).toMatch(/No existe el elemento/);
    const twice = await post('/api/trace', JSON.stringify({ documents: [documents[0], documents[0]] }));
    expect((await twice.json()).error).toMatch(/aparece más de una vez/);
  });

  it('POST /api/trace: cada enlace trae su tipo y, sin los campos nuevos, la respuesta es la de siempre', async () => {
    const documents = [
      { module: 'security', document: JSON.parse(security) },
      { module: 'platform', document: JSON.parse(example('plataforma-ejemplo.json')) },
      { module: 'integration', document: JSON.parse(example('pedidos-integracion.json')) },
    ];
    const plain = await (await post('/api/trace', JSON.stringify({ documents }))).json();
    expect(Object.keys(plain).sort()).toEqual(['graph', 'mermaid', 'report', 'svg']);
    expect(plain.graph.links).toHaveLength(11);
    expect(plain.graph.links.map((l: { type: string }) => l.type).sort()).toEqual(['deploys', 'deploys', 'implements', 'implements', 'implements', 'implements', 'protects', 'protects', 'protects', 'protects', 'protects']);
    expect(plain.graph.notices).toEqual([]);
    expect(plain.mermaid).toContain('-.->|protects|');
    expect(plain.report).toContain('Por tipo: protects 5, implements 4, deploys 2.');
  });

  it('POST /api/trace: types filtra los enlaces; orphans, matrix y coverage añaden sus informes', async () => {
    const documents = [
      { module: 'security', document: JSON.parse(security) },
      { module: 'platform', document: JSON.parse(example('plataforma-ejemplo.json')) },
      { module: 'integration', document: JSON.parse(example('pedidos-integracion.json')) },
    ];
    const ask = async (extra: Record<string, unknown>) => (await post('/api/trace', JSON.stringify({ documents, ...extra }))).json();

    const typed = await ask({ types: ['implements'] });
    expect(typed.types).toEqual(['implements']);
    expect(typed.graph.links).toHaveLength(4);
    expect((typed.mermaid.match(/-\.->/g) ?? []).length).toBe(4);
    const reach = await ask({ types: ['implements'], from: 'urn:iark:integration:pedidos', direction: 'referrers' });
    expect(reach.reached.map((r: { node: { urn: string } }) => r.node.urn)).toEqual(['urn:iark:integration:pedidos', 'urn:iark:platform:pedidos']);

    const full = await ask({ orphans: true, matrix: 'module', coverage: ['security:asset -> platform', 'platform:service -> integration'] });
    expect(full.orphans).toMatchObject({ filter: {}, count: expect.any(Number) });
    expect(full.matrix).toMatchObject({ by: 'module', total: 11, rows: ['security', 'platform'] });
    expect(full.coverage).toHaveLength(2);
    expect(full.coverage[0]).toMatchObject({ applicable: true, total: 11, percent: 45.5 });
    expect(full.coverage[0].uncovered.map((n: { id: string }) => n.id)).toContain('cliente');
    expect(full.coverage[1].rule.text).toBe('platform:service -> integration');

    const scoped = await ask({ orphans: 'security:zone' });
    expect(scoped.orphans.filter).toEqual({ module: 'security', kind: 'zone' });
    expect(scoped.orphans.count).toBe(4);
    expect((await ask({ orphans: { module: 'platform', kind: 'service' } })).orphans.groups).toHaveLength(1);
    expect((await ask({ matrix: true })).matrix.by).toBe('module');
    expect((await ask({ matrix: 'kind' })).matrix.by).toBe('kind');

    // los errores de uso son 400 con un mensaje que dice qué campo
    const bad = async (extra: Record<string, unknown>) => {
      const response = await post('/api/trace', JSON.stringify({ documents, ...extra }));
      return { status: response.status, error: (await response.json()).error as string };
    };
    expect(await bad({ types: 'implements' })).toMatchObject({ status: 400, error: expect.stringMatching(/"types"/) });
    expect(await bad({ types: ['Mal Tipo'] })).toMatchObject({ status: 400 });
    expect(await bad({ orphans: 'nada' })).toMatchObject({ status: 400, error: expect.stringMatching(/"orphans": no existe el módulo «nada»/) });
    expect(await bad({ orphans: 'data' })).toMatchObject({ status: 400, error: expect.stringMatching(/«data» no está entre los documentos aportados/) });
    expect(await bad({ orphans: 3 })).toMatchObject({ status: 400 });
    expect(await bad({ matrix: 'raro' })).toMatchObject({ status: 400, error: expect.stringMatching(/"matrix"/) });
    expect(await bad({ coverage: 'security -> platform' })).toMatchObject({ status: 400, error: expect.stringMatching(/"coverage"/) });
    expect(await bad({ coverage: ['sin flecha'] })).toMatchObject({ status: 400, error: expect.stringMatching(/forma origen -> destino/) });
    expect(await bad({ coverage: ['nada -> platform'] })).toMatchObject({ status: 400, error: expect.stringMatching(/no existe el módulo «nada»/) });
  });

  it('responde 404 al módulo o la acción desconocidos y 405 (con Allow) al método equivocado', async () => {
    const unknown = await fetch(`${base}/api/nada/capabilities`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain('Módulos: c4, integration');
    expect((await fetch(`${base}/api/security/inventada`)).status).toBe(404);
    const wrong = await fetch(`${base}/api/security/validate`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await post('/api/modules', '')).status).toBe(405);
  });

  it('sin --static no sirve archivos', async () => {
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });
});

describe('iark serve: límites, CORS y sitio estático', () => {
  it('rechaza los cuerpos que superan el máximo con 413', async () => {
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', maxBodyBytes: 100 });
    const base = await listen(server);
    const res = await fetch(`${base}/api/security/validate`, { method: 'POST', body: 'x'.repeat(500) });
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
    server.close();
  });

  it('no abre la API a otros orígenes salvo los autorizados (y responde al preflight)', async () => {
    const closed = createSuiteServer({ registry: createDefaultRegistry(), version: '1' });
    const closedBase = await listen(closed);
    expect((await fetch(`${closedBase}/api/modules`, { headers: { origin: 'https://otra.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    closed.close();

    const open = createSuiteServer({ registry: createDefaultRegistry(), version: '1', cors: ['https://app.example'] });
    const openBase = await listen(open);
    const allowed = await fetch(`${openBase}/api/modules`, { headers: { origin: 'https://app.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(allowed.headers.get('vary')).toBe('Origin');
    const denied = await fetch(`${openBase}/api/modules`, { headers: { origin: 'https://mala.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${openBase}/api/security/validate`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    open.close();

    const wildcard = createSuiteServer({ registry: createDefaultRegistry(), version: '1', cors: ['*'] });
    const wildBase = await listen(wildcard);
    expect((await fetch(`${wildBase}/.well-known/iark.json`, { headers: { origin: 'https://cualquiera.example' } })).headers.get('access-control-allow-origin')).toBe('*');
    wildcard.close();
  });

  it('sirve el sitio compilado, sin salir de su carpeta, y el manifiesto anuncia los editores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-site-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>sitio</title>');
    writeFileSync(join(dir, 'modulos.html'), '<!doctype html><title>módulos</title>');
    writeFileSync(join(dir, 'assets', 'app-abc.js'), 'export {}');
    writeFileSync(join(tmpdir(), 'iark-secreto.txt'), 'no debe verse');
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', staticDir: dir });
    const base = await listen(server);

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('sitio');
    const asset = await fetch(`${base}/assets/app-abc.js`);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/no-existe.html`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e%2firark-secreto.txt`)).status).toBe(403);
    expect((await fetch(`${base}/assets/%2e%2e%2f%2e%2e%2firark-secreto.txt`)).status).toBe(403);

    const manifest = await (await fetch(`${base}/.well-known/iark.json`)).json();
    const security = manifest.modules.find((m: { id: string }) => m.id === 'security');
    expect(security.endpoints).toEqual({ embed: '../modulos.html?module=security', schema: '../schema/security-document.schema.json', api: '../api/security' });
    server.close();
  });
});

describe('iark serve (comando)', () => {
  let bundle: CliBundle;
  beforeAll(async () => {
    bundle = await buildCliBundle('serve');
  });
  afterAll(() => bundle?.dispose());

  it('arranca en un puerto libre, responde y se detiene con SIGTERM', async () => {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      // Si el servidor no llega a arrancar, falla poco antes que la prueba, con lo que escribió en stderr y sin dejar el proceso vivo.
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
    expect(stderr).toContain('solo API');
    const modules = await (await fetch(`${url}/api/modules`)).json();
    expect(modules).toHaveLength(6);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });

  it('rechaza un puerto inválido y una carpeta de sitio que no existe', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [bundle.cli, 'serve', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('exit', (code) => resolve({ code, stderr }));
      });
    const port = await run(['--port', 'abc']);
    expect(port.code).not.toBe(0);
    expect(port.stderr).toMatch(/puerto debe ser un entero/);
    const site = await run(['--port', '0', '--static', '/no/existe']);
    expect(site.code).not.toBe(0);
    expect(site.stderr).toMatch(/no existe/);
  });
});
