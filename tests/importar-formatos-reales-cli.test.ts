import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultRegistry } from '../src/cli/registry';
import { createSuiteServer } from '../src/cli/serve';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// Fase 3 · acción 13: cada módulo importa un formato real además de Mermaid. Aquí se recorre de punta a punta con el CLI
// empaquetado tal como se publica (`iark import --module <m> --format <id>` → `validate` → `convert --to mermaid`) y con
// `POST /api/<módulo>/import` del servicio, con los mismos archivos de `tests/fixtures/importar/`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
let cli: string;
const dir = mkdtempSync(join(tmpdir(), 'iark-importar-reales-'));
beforeAll(async () => {
  bundle = await buildCliBundle('importar-formatos-reales');
  cli = bundle.cli;
});
afterAll(() => {
  bundle?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const FIX = 'tests/fixtures/importar';

interface Case {
  module: string;
  format: string;
  /** Archivos o carpeta que se pasan al CLI. */
  inputs: string[];
  /** Nombre del documento importado: el del propio formato o, si no trae uno, el del archivo o la carpeta. */
  name: string;
  /** Tamaño de las listas del documento que se comprueban. */
  counts: Record<string, number>;
  /** Número de avisos que imprime el CLI por stderr. */
  warnings: number;
  /** Lo que dice el primer aviso. */
  firstWarning: RegExp;
  /** ¿Se puede leer también por la entrada estándar y por el servicio (un solo archivo)? */
  single?: string;
}

const CASES: Case[] = [
  { module: 'integration', format: 'openapi', inputs: [`${FIX}/openapi/petstore.yaml`], single: `${FIX}/openapi/petstore.yaml`, name: 'Tienda de mascotas', counts: { nodes: 5, contracts: 1, interactions: 3 }, warnings: 2, firstWarning: /^OpenAPI no dice quién llama a la API/ },
  { module: 'integration', format: 'openapi', inputs: [`${FIX}/openapi/pedidos-31.json`], single: `${FIX}/openapi/pedidos-31.json`, name: 'API de pedidos', counts: { nodes: 4, contracts: 1, interactions: 2 }, warnings: 5, firstWarning: /./ },
  { module: 'integration', format: 'asyncapi', inputs: [`${FIX}/asyncapi/pagos-v3.yaml`], single: `${FIX}/asyncapi/pagos-v3.yaml`, name: 'Servicio de pagos', counts: { nodes: 6, contracts: 1, interactions: 3 }, warnings: 5, firstWarning: /./ },
  { module: 'integration', format: 'asyncapi', inputs: [`${FIX}/asyncapi/streetlights-v2.yaml`], single: `${FIX}/asyncapi/streetlights-v2.yaml`, name: 'API de farolas inteligentes', counts: { nodes: 7, contracts: 1, interactions: 4 }, warnings: 3, firstWarning: /./ },
  { module: 'security', format: 'threat-dragon', inputs: [`${FIX}/threat-dragon/tienda-modelo.json`], single: `${FIX}/threat-dragon/tienda-modelo.json`, name: 'Tienda en línea', counts: { zones: 5, assets: 9, flows: 9, threats: 14, controls: 11 }, warnings: 9, firstWarning: /./ },
  { module: 'data', format: 'openlineage', inputs: [`${FIX}/openlineage/eventos-tienda.json`], single: `${FIX}/openlineage/eventos-tienda.json`, name: 'eventos-tienda', counts: { assets: 10, pipelines: 4 }, warnings: 7, firstWarning: /./ },
  { module: 'data', format: 'openlineage', inputs: [`${FIX}/openlineage/pagos-flink.ndjson`], single: `${FIX}/openlineage/pagos-flink.ndjson`, name: 'pagos-flink', counts: { assets: 3, pipelines: 1 }, warnings: 0, firstWarning: /./ },
  { module: 'enterprise', format: 'bpmn', inputs: [`${FIX}/bpmn/pedidos-colaboracion.bpmn`], single: `${FIX}/bpmn/pedidos-colaboracion.bpmn`, name: 'Proceso de pedidos', counts: { units: 8, processes: 17, relations: 41 }, warnings: 7, firstWarning: /./ },
  { module: 'enterprise', format: 'bpmn', inputs: [`${FIX}/bpmn/solicitud-vacaciones.bpmn`], single: `${FIX}/bpmn/solicitud-vacaciones.bpmn`, name: 'solicitud-vacaciones', counts: { units: 3, processes: 5, relations: 11 }, warnings: 1, firstWarning: /./ },
  { module: 'platform', format: 'cloudformation', inputs: [`${FIX}/cloudformation/tienda-aws.yaml`], single: `${FIX}/cloudformation/tienda-aws.yaml`, name: 'tienda-aws', counts: { environments: 1, networks: 4, resources: 6, dependencies: 6 }, warnings: 5, firstWarning: /^14 recursos de soporte que no se dibujan/ },
  { module: 'platform', format: 'cloudformation', inputs: [`${FIX}/cloudformation/api-contenedores.json`], single: `${FIX}/cloudformation/api-contenedores.json`, name: 'api-contenedores', counts: { resources: 6, services: 1, deployments: 1, dependencies: 3 }, warnings: 3, firstWarning: /./ },
  // La carpeta del chart: Chart.yaml + values.yaml juntos (el CLI los lee con el importador que declara `multiFile`).
  { module: 'platform', format: 'helm', inputs: [`${FIX}/helm/tienda`], name: 'tienda', counts: { environments: 1, resources: 7, services: 2, deployments: 2, dependencies: 7 }, warnings: 7, firstWarning: /^Helm \(Chart\.yaml \+ values\.yaml\): las plantillas \(templates\/, Go templates\) no se interpretan/ },
  { module: 'platform', format: 'helm', inputs: [`${FIX}/helm/legado`], name: 'blog', counts: { resources: 3, services: 1, deployments: 1, dependencies: 2 }, warnings: 3, firstWarning: /^Helm \(Chart\.yaml \+ values\.yaml\)/ },
];

const label = (c: Case): string => `${c.module} · ${c.format} · ${c.inputs[0]}`;

describe.each(CASES.map((c) => [label(c), c] as const))('iark import → validate → convert: %s', (_name, c) => {
  const out = join(dir, `${c.module}-${c.format}-${c.name.replace(/\W+/g, '-')}.json`);
  const imported = () => {
    const r = run(['import', '--module', c.module, '--format', c.format, ...c.inputs]);
    expect(r.status, r.stderr).toBe(0);
    return { r, doc: JSON.parse(r.stdout) as Record<string, unknown> & { workspace: { name: string } } };
  };

  it('importa un documento del módulo, con su resumen y todos los avisos por stderr', () => {
    const { r, doc } = imported();
    expect(doc.workspace.name).toBe(c.name);
    for (const [key, count] of Object.entries(c.counts)) expect(doc[key], key).toHaveLength(count);
    expect(r.stderr).toContain(`Importado "${c.name}" en el módulo ${c.module}: `);
    if (c.warnings > 0) expect(r.stderr).toMatch(new RegExp(`${c.warnings} aviso\\(s\\)\\.`));
    else expect(r.stderr).not.toMatch(/aviso/);
    const warnings = r.stderr.split('\n').filter((l) => l.startsWith('aviso: '));
    expect(warnings).toHaveLength(c.warnings);
    if (c.warnings > 0) expect(warnings[0].slice('aviso: '.length)).toMatch(c.firstWarning);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('con auto (sin --format) elige el mismo importador y da el mismo documento; dos veces, la misma salida', () => {
    const forced = imported();
    const auto = run(['import', '--module', c.module, ...c.inputs]);
    expect(auto.status, auto.stderr).toBe(0);
    expect(auto.stdout).toBe(forced.r.stdout);
    expect(auto.stderr).toBe(forced.r.stderr);
    expect(imported().r.stdout).toBe(forced.r.stdout);
  });

  it('lo importado pasa el esquema del módulo (validate) y se exporta a Mermaid y a SVG', () => {
    const wrote = run(['import', '--module', c.module, '--format', c.format, '-o', out, ...c.inputs]);
    expect(wrote.status, wrote.stderr).toBe(0);
    expect(wrote.stdout).toBe('');
    const valid = run(['validate', out, '--module', c.module]);
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    expect(valid.stdout).toMatch(new RegExp(`Documento válido \\(módulo ${c.module}\\)\\. 0 error\\(es\\)`));
    const mermaid = run(['convert', out, '--module', c.module, '--to', 'mermaid']);
    expect(mermaid.status, mermaid.stderr).toBe(0);
    expect(mermaid.stdout.length).toBeGreaterThan(40);
    expect(mermaid.stdout).not.toMatch(/undefined|NaN|\[object Object\]/);
    const svg = join(dir, `${c.module}-${c.format}-${c.name.replace(/\W+/g, '-')}.svg`);
    expect(run(['convert', out, '--module', c.module, '--to', 'svg', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('<svg');
  });

  it.runIf(c.single !== undefined)('también se lee por la entrada estándar y se reconoce solo por el contenido', () => {
    const text = readFileSync(c.single!, 'utf8');
    const stdin = run(['import', '--module', c.module, '--stdin'], text);
    expect(stdin.status, stdin.stderr).toBe(0);
    const doc = JSON.parse(stdin.stdout) as Record<string, unknown>;
    for (const [key, count] of Object.entries(c.counts)) expect(doc[key], key).toHaveLength(count);
  });
});

describe('iark import: Helm de las tres formas y la salida de helm template', () => {
  const chart = `${FIX}/helm/tienda`;

  it('la carpeta del chart, sus archivos sueltos y la carpeta con la forma explícita dan el mismo documento', () => {
    const folder = run(['import', '--module', 'platform', chart]);
    const files = run(['import', '--module', 'platform', `${chart}/values.yaml`, `${chart}/Chart.yaml`]);
    const forced = run(['import', '--module', 'platform', '--format', 'helm', chart]);
    expect(folder.status, folder.stderr).toBe(0);
    expect(files.status, files.stderr).toBe(0);
    expect(forced.status, forced.stderr).toBe(0);
    const a = JSON.parse(folder.stdout);
    const b = JSON.parse(files.stdout);
    expect(forced.stdout).toBe(folder.stdout);
    expect(b.services).toEqual(a.services);
    expect(b.resources).toEqual(a.resources);
    expect(b.dependencies).toEqual(a.dependencies);
    expect(a.services.map((s: { id: string }) => s.id)).toEqual(['servicio-tienda', 'pasarela']);
  });

  it('un Chart.yaml solo basta, y el Chart.yaml por la entrada estándar se reconoce por el contenido', () => {
    const one = run(['import', '--module', 'platform', `${chart}/Chart.yaml`]);
    expect(one.status, one.stderr).toBe(0);
    const viaStdin = run(['import', '--module', 'platform', '--stdin'], readFileSync(`${chart}/Chart.yaml`, 'utf8'));
    expect(viaStdin.status, viaStdin.stderr).toBe(0);
    expect(JSON.parse(viaStdin.stdout).services.map((s: { name: string }) => s.name)).toEqual(['tienda', 'pasarela', 'kube-prometheus-stack']);
    // sin values.yaml no se sabe que kube-prometheus-stack está desactivado: se importa, y el aviso de que las plantillas no se leen sigue primero
    expect(viaStdin.stderr.split('\n').find((l) => l.startsWith('aviso: '))).toMatch(/las plantillas \(templates\/, Go templates\) no se interpretan/);
  });

  it('nunca imprime las contraseñas de values.yaml', () => {
    const r = run(['import', '--module', 'platform', chart]);
    expect(r.stdout + r.stderr).not.toMatch(/no-copiar-esta-clave|tampoco-esta-otra/);
  });

  it('la salida de helm template llega por la entrada estándar al importador de Kubernetes, con el chart como nombre', () => {
    const rendered = readFileSync(`${FIX}/helm/tienda-renderizado.yaml`, 'utf8');
    const r = run(['import', '--module', 'platform', '--stdin'], rendered);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.workspace.name).toBe('tienda');
    expect(doc.environments[0]).toMatchObject({ name: 'tienda', provider: 'kubernetes' });
    expect(doc.resources.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['kubernetes', 'tienda-postgresql', 'tienda-redis-master', 'ingress-tienda']));
    expect(r.stderr).toMatch(/aviso: No se pudo deducir el entorno de las etiquetas ni de los namespaces: se crea el entorno «tienda» a partir del chart de Helm «tienda»\./);
    expect(r.stdout + r.stderr).not.toContain('no-copiar-esta-clave');
    const forced = run(['import', '--module', 'platform', '--format', 'kubernetes', '--stdin'], rendered);
    expect(forced.stdout).toBe(r.stdout);
  });

  it('un manifiesto de Kubernetes con --format helm, o un chart con --format kubernetes, se explican con código 2', () => {
    const wrong = run(['import', '--module', 'platform', '--format', 'helm', `${FIX}/helm/tienda-renderizado.yaml`]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/helm template … \| iark import --module platform/);
    const other = run(['import', '--module', 'platform', '--format', 'kubernetes', `${chart}/Chart.yaml`]);
    expect(other.status).toBe(2);
    expect(other.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('iark import: los formatos no se confunden entre sí', () => {
  it('OpenAPI no se lee como AsyncAPI ni al revés, y JSON ajeno no se reconoce como nada', () => {
    const asAsync = run(['import', '--module', 'integration', '--format', 'asyncapi', `${FIX}/openapi/petstore.yaml`]);
    expect(asAsync.status).toBe(2);
    expect(asAsync.stderr).toMatch(/AsyncAPI/);
    const asOpen = run(['import', '--module', 'integration', '--format', 'openapi', `${FIX}/asyncapi/pagos-v3.yaml`]);
    expect(asOpen.status).toBe(2);
    expect(asOpen.stderr).toMatch(/OpenAPI/);
    for (const [module, text] of [['integration', '{"hola": "mundo", "n": [1, 2]}'], ['security', '{"summary": {}}'], ['data', '{"a": 1}'], ['enterprise', '<root/>'], ['platform', 'a: 1\nb: 2\n']] as const) {
      const r = run(['import', '--module', module, '--stdin'], text);
      expect(r.status, `${module}: ${r.stdout}`).not.toBe(0);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('las listas de formatos de los cinco módulos con importadores nuevos', () => {
    const manifest = JSON.parse(run(['modules', '--json']).stdout) as { modules: Array<{ id: string; importFormats: string[] }> };
    const formats = Object.fromEntries(manifest.modules.map((m) => [m.id, m.importFormats]));
    expect(formats.integration).toEqual(['mermaid', 'openapi', 'asyncapi']);
    expect(formats.security).toEqual(['mermaid', 'threat-dragon']);
    expect(formats.data).toEqual(['mermaid', 'ddl', 'dbt', 'openlineage']);
    expect(formats.enterprise).toEqual(['mermaid', 'archimate', 'bpmn']);
    expect(formats.platform).toEqual(['mermaid', 'terraform', 'kubernetes', 'cloudformation', 'helm']);
  });
});

describe('iark import: entradas dañadas dan un error claro, sin traza ni cuelgue', () => {
  const nest = (open: string, close: string, depth = 20_000): string => `${open.repeat(depth)}${close.repeat(depth)}`;
  const damaged: Array<{ module: string; format: string; sample: string; deep: string }> = [
    { module: 'integration', format: 'openapi', sample: `${FIX}/openapi/petstore.yaml`, deep: `{"openapi":"3.0.0","x":${nest('[', ']')}}` },
    { module: 'integration', format: 'asyncapi', sample: `${FIX}/asyncapi/pagos-v3.yaml`, deep: `{"asyncapi":"2.6.0","x":${nest('[', ']')}}` },
    { module: 'security', format: 'threat-dragon', sample: `${FIX}/threat-dragon/tienda-modelo.json`, deep: `{"summary":{},"detail":{"diagrams":${nest('[', ']')}}}` },
    { module: 'data', format: 'openlineage', sample: `${FIX}/openlineage/eventos-tienda.json`, deep: nest('[', ']') },
    { module: 'enterprise', format: 'bpmn', sample: `${FIX}/bpmn/pedidos-colaboracion.bpmn`, deep: `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">${nest('<a>', '</a>', 5_000)}</definitions>` },
    { module: 'platform', format: 'cloudformation', sample: `${FIX}/cloudformation/tienda-aws.yaml`, deep: `Resources: ${nest('[', ']')}` },
    { module: 'platform', format: 'helm', sample: `${FIX}/helm/tienda/Chart.yaml`, deep: `apiVersion: v2\nname: x\nversion: 1.0.0\nx: ${nest('[', ']')}\n` },
  ];

  it.each(damaged.map((d) => [`${d.module} · ${d.format}`, d] as const))('%s', (_name, d) => {
    const failing = (input: string) => run(['import', '--module', d.module, '--format', d.format, '--stdin'], input);
    for (const input of ['', '   \n', '42', '"hola"', d.deep]) {
      const r = failing(input);
      expect(r.status, `entrada «${input.slice(0, 30)}»: ${r.stdout.slice(0, 100)}`).toBe(2);
      expect(r.stderr.trim().length).toBeGreaterThan(10);
      expect(r.stderr).not.toMatch(/\n\s+at |RangeError|Maximum call stack/);
    }
    // truncado a la mitad: o es un documento válido (YAML recortado en una frontera) o un error de importación; nunca una caída
    const text = readFileSync(d.sample, 'utf8');
    for (const cut of [0.2, 0.5, 0.9]) {
      const r = failing(text.slice(0, Math.floor(text.length * cut)));
      expect([0, 2], `${d.format} cortado al ${cut * 100}%: ${r.stderr.slice(0, 200)}`).toContain(r.status);
      expect(r.stderr).not.toMatch(/\n\s+at |RangeError|Maximum call stack/);
    }
  });
});

describe('POST /api/<módulo>/import del servicio con los formatos reales', () => {
  let server: Server;
  let base: string;
  const registry = createDefaultRegistry();
  beforeAll(async () => {
    server = createSuiteServer({ registry, version: '9.9.9' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const post = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', body });
  const singles = CASES.filter((c) => c.single !== undefined);

  it.each(singles.map((c) => [label(c), c] as const))('%s: importa, valida contra el módulo y exporta', async (_name, c) => {
    const text = readFileSync(c.single!, 'utf8');
    const res = await post(`/api/${c.module}/import?importer=${c.format}&name=${encodeURIComponent('Importado por HTTP')}`, text);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: Record<string, unknown>; warnings: string[]; importer: string };
    expect(body.importer).toBe(c.format);
    expect((body.document.workspace as { name: string }).name).toBe('Importado por HTTP');
    expect(body.warnings).toHaveLength(c.warnings);
    for (const [key, count] of Object.entries(c.counts)) expect(body.document[key], key).toHaveLength(count);

    const module = registry.require(c.module);
    expect(module.schema.safeParse(body.document).success).toBe(true);
    expect(module.validate(body.document as never).filter((i) => i.severity === 'error')).toEqual([]);

    const validated = (await (await post(`/api/${c.module}/validate`, JSON.stringify(body.document))).json()) as { valid: boolean; schemaIssues: unknown[] };
    expect(validated).toMatchObject({ valid: true, schemaIssues: [] });
    const mermaid = await post(`/api/${c.module}/export?format=mermaid`, JSON.stringify(body.document));
    expect(mermaid.status).toBe(200);
    expect((await mermaid.text()).length).toBeGreaterThan(40);

    // sin indicar el formato, el servicio lo reconoce por el contenido
    const auto = await post(`/api/${c.module}/import`, text);
    expect(auto.status).toBe(200);
    expect(((await auto.json()) as { importer: string }).importer).toBe(c.format);
  });

  it('un texto vacío, truncado, de otro formato o con miles de niveles se rechaza con 400 y un motivo, nunca con 500', async () => {
    const cases: Array<[string, string, string]> = [
      ['integration', 'openapi', ''],
      ['integration', 'openapi', '{"openapi": "3.0.0", "paths": {'],
      ['integration', 'openapi', '[]'],
      ['integration', 'asyncapi', readFileSync(`${FIX}/openapi/petstore.yaml`, 'utf8')],
      ['security', 'threat-dragon', `{"summary":{},"detail":{"diagrams":${'['.repeat(30_000)}${']'.repeat(30_000)}}}`],
      ['data', 'openlineage', '{"eventTime":'],
      ['enterprise', 'bpmn', '<definitions><process'],
      ['platform', 'cloudformation', 'Resources: [a'],
      ['platform', 'helm', 'name: [x'],
    ];
    for (const [module, importer, body] of cases) {
      const res = await post(`/api/${module}/import?importer=${importer}`, body);
      expect(res.status, `${module}/${importer}: ${body.slice(0, 40)}`).toBe(400);
      const error = (await res.json()) as { error?: string };
      expect(typeof error.error === 'string' && error.error.length > 5).toBe(true);
    }
  });
});
