import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';

// Cada prueba lanza el CLI como proceso, a veces varias veces seguidas. Se empaqueta una vez con tsup (como se publica)
// y se ejecuta con `node`, que arranca en una fracción de lo que tarda `tsx` en transpilar el árbol cada vez; y se da
// margen de sobra por si la máquina está saturada (con carga 20-28 en 4 núcleos los 30 s por defecto se agotaban).
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
let cli: string;
beforeAll(async () => {
  bundle = await buildCliBundle('cli');
  cli = bundle.cli;
});
afterAll(() => bundle?.dispose());

const example = 'examples/banca.json';

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
}

describe('iark (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c4cli-'));

  it('layout escribe coordenadas en todas las vistas', () => {
    const out = join(dir, 'laid.json');
    const r = run(['layout', example, '--out', out, '--direction', 'right']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    for (const v of doc.views) for (const e of v.elements) expect(typeof e.x).toBe('number');
  });

  it('convert produce un .drawio válido con una página por vista (desde stdin, con bloque de código)', () => {
    const input = '```json\n' + readFileSync(example, 'utf8') + '\n```';
    const r = run(['convert', '--stdin', '--locale', 'en'], input);
    expect(r.status).toBe(0);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(r.stdout);
    expect([].concat(parsed.mxfile.diagram)).toHaveLength(3);
    expect(r.stdout).toContain('System Scope Boundary');
  });

  it('validate devuelve código 2 con un documento inválido y 0 con uno válido', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ model: { elements: [{ id: 'a', type: 'component', name: 'A' }], relationships: [{ id: 'r', sourceId: 'a', targetId: 'b' }] } }));
    const r = run(['validate', bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/destino inexistente/);
    const ok = run(['validate', example]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido/);
  });

  it('schema, prompt y example imprimen contenido útil', () => {
    expect(JSON.parse(execFileSync(process.execPath, [cli, 'schema'], { encoding: 'utf8' })).type).toBe('object');
    expect(JSON.parse(execFileSync(process.execPath, [cli, 'schema', '--generation'], { encoding: 'utf8' })).properties.views).toBeDefined();
    const prompt = execFileSync(process.execPath, [cli, 'prompt', 'Un sistema de reservas', '--from', example], { encoding: 'utf8' });
    expect(prompt).toContain('Un sistema de reservas');
    expect(prompt).toContain('"cliente"');
    expect(JSON.parse(execFileSync(process.execPath, [cli, 'example'], { encoding: 'utf8' })).views).toHaveLength(3);
  });

  it('errores conocidos (vista inexistente, sin vistas) terminan en un mensaje de una línea, sin stack', () => {
    const r1 = run(['convert', example, '--view', 'no-existe']);
    expect(r1.status).toBe(3);
    expect(r1.stderr).not.toMatch(/\n\s+at /); // sin stack trace
    expect(r1.stderr.trim().split('\n').at(-1)).toBe('El documento no tiene vistas que exportar');

    const r2 = run(['layout', example, '--view', 'no-existe']);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toMatch(/no existe/);
    expect(r2.stderr).not.toMatch(/\n\s+at /);

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ version: '1.0', workspace: { name: 'x' }, model: { elements: [], relationships: [] }, views: [] }));
    const r3 = run(['convert', empty]);
    expect(r3.status).not.toBe(0);
    expect(r3.stderr).toMatch(/no tiene vistas/);
    expect(r3.stderr).not.toMatch(/\n\s+at /);
  });

  it('--spacing, --layer-spacing y --retries rechazan valores inválidos con un mensaje claro', () => {
    const bad1 = run(['layout', example, '--spacing', 'abc']);
    expect(bad1.status).not.toBe(0);
    expect(bad1.stderr).toMatch(/separación/i);

    const bad2 = run(['layout', example, '--spacing', '-5']);
    expect(bad2.status).not.toBe(0);
    expect(bad2.stderr).toMatch(/separación/i);

    const bad3 = run(['layout', example, '--layer-spacing', 'NaN']);
    expect(bad3.status).not.toBe(0);
    expect(bad3.stderr).toMatch(/separación/i);

    const bad4 = run(['generate', 'algo', '--retries', '-1']);
    expect(bad4.status).not.toBe(0);
    expect(bad4.stderr).toMatch(/reintentos/i);

    const ok = run(['layout', example, '--spacing', '80', '--layer-spacing', '120']);
    expect(ok.status).toBe(0);
  });

  it('generate falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Una tienda'], {
      encoding: 'utf8',
      // Se vacían también las variables de Foundry / API compatible con OpenAI: si el entorno
      // que ejecuta las pruebas las define, `generate` haría una llamada real en vez de fallar.
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});

describe('iark import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c4import-'));
  const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

  it('importa un .drawio a JSON válido (stdout limpio, resumen por stderr) con el nombre del archivo', () => {
    const r = run(['import', 'examples/banca-c4.drawio']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.workspace.name).toBe('banca-c4');
    expect(doc.model.elements).toHaveLength(13);
    expect(doc.model.relationships).toHaveLength(19);
    expect(doc.views.map((v: { id: string; type: string; scopeId: string }) => [v.id, v.type, v.scopeId])).toEqual([
      ['contexto', 'systemContext', 'banca'],
      ['contenedores', 'container', 'banca'],
      ['componentes-api', 'component', 'api'],
    ]);
    expect(r.stderr).toMatch(/Importado "banca-c4": 13 elementos, 19 relaciones, 3 vistas\./);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('--out escribe el archivo y --name fija el nombre del diagrama', () => {
    const out = join(dir, 'nested', 'banca.json');
    const r = run(['import', 'examples/banca-tarjetas.drawio', '--out', out, '--name', 'Mi banca']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).workspace.name).toBe('Mi banca');
    expect(r.stderr).toContain(`Documento C4 escrito en ${out}`);
  });

  it('convert → import recupera los ids del documento original (ida y vuelta por el CLI)', () => {
    const drawio = run(['convert', example]);
    expect(drawio.status).toBe(0);
    const r = run(['import', '--stdin'], drawio.stdout);
    expect(r.status).toBe(0);
    const original = JSON.parse(readFileSync(example, 'utf8'));
    const imported = JSON.parse(r.stdout);
    expect(ids(imported.model.elements)).toEqual(ids(original.model.elements));
    expect(ids(imported.model.relationships)).toEqual(ids(original.model.relationships));
    expect(imported.views.map((v: { id: string }) => v.id)).toEqual(original.views.map((v: { id: string }) => v.id));
    // Y el resultado se valida y se encadena con el resto de comandos.
    expect(run(['validate', '--stdin'], r.stdout).status).toBe(0);
  });

  it('avisa por stderr de lo que no puede importar sin ensuciar el JSON de stdout', () => {
    const xml =
      '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="A" value="Alfa" style="html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="N" value="Una nota" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="200" width="120" height="30" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const r = run(['import', '--stdin'], xml);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).model.elements).toHaveLength(1);
    expect(r.stderr).toMatch(/aviso: Página «P»: se omitieron 1 nota\(s\) de texto suelto\./);
    expect(r.stderr).toMatch(/1 vistas, 1 aviso\(s\)|1 vistas, 1 aviso/);
  });

  it('lee un stdin grande que llega despacio y por trozos (un pipe con productor lento no falla con EAGAIN)', async () => {
    let cells = '';
    for (let i = 0; i < 1500; i += 1) {
      cells += `<mxCell id="C${i}" value="Elemento ${i}" style="html=1;" vertex="1" parent="1"><mxGeometry x="${(i % 30) * 150}" y="${Math.floor(i / 30) * 90}" width="120" height="60" as="geometry"/></mxCell>`;
    }
    const xml = `<mxfile><diagram id="p" name="Grande"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
    expect(xml.length).toBeGreaterThan(200 * 1024); // varios bloques de lectura de 64 KB
    const child = spawn(process.execPath, [cli, 'import', '--stdin']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await pause(1500); // el lector ya está esperando datos cuando empieza a llegar la entrada
    const half = Math.floor(xml.length / 2);
    child.stdin.write(xml.slice(0, half));
    await pause(400);
    child.stdin.end(xml.slice(half));
    expect(await exit, stderr).toBe(0);
    expect(JSON.parse(stdout).model.elements).toHaveLength(1500);
  }, 60000);

  it('los errores son mensajes de una línea con código 2 (no un stack), y un archivo inexistente, código 1', () => {
    const notDrawio = join(dir, 'no-drawio.drawio');
    writeFileSync(notDrawio, '<html><body>hola</body></html>');
    const r1 = run(['import', notDrawio]);
    expect(r1.status).toBe(2);
    expect(r1.stderr.trim()).toMatch(/^No se pudo importar el \.drawio: No parece un archivo de draw\.io/);
    expect(r1.stderr).not.toMatch(/\n\s+at /);

    const empty = join(dir, 'vacio.drawio');
    writeFileSync(empty, '');
    const r2 = run(['import', empty]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/El archivo está vacío/);

    const r3 = run(['import', join(dir, 'no-existe.drawio')]);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toMatch(/No se pudo leer/);
    expect(r3.stderr).not.toMatch(/\n\s+at /);
  });
  it('importa un DSL de Structurizr: formato deducido de la extensión, nombre del workspace y vistas con alcance', () => {
    const r = run(['import', 'examples/banca.dsl']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.workspace.name).toBe('Banca en línea');
    expect(doc.model.elements).toHaveLength(13);
    expect(doc.model.relationships).toHaveLength(19);
    expect(doc.views.map((v: { id: string; type: string; scopeId: string }) => [v.id, v.type, v.scopeId])).toEqual([
      ['contexto', 'systemContext', 'banca'],
      ['contenedores', 'container', 'banca'],
      ['componentes-api', 'component', 'api'],
    ]);
    expect(r.stderr).toMatch(/Importado "Banca en línea": 13 elementos, 19 relaciones, 3 vistas\./);
    // Un DSL no trae coordenadas.
    expect(doc.views.every((v: { elements: Array<{ x?: number }> }) => v.elements.every((e) => e.x === undefined))).toBe(true);
  });

  it('--name sustituye al del workspace; sin nombre en el DSL se usa el del archivo', () => {
    expect(JSON.parse(run(['import', 'examples/banca.dsl', '--name', 'Otro']).stdout).workspace.name).toBe('Otro');
    const file = join(dir, 'mi-tienda.dsl');
    writeFileSync(file, 'workspace { model { s = softwareSystem "Tienda" } }');
    expect(JSON.parse(run(['import', file]).stdout).workspace.name).toBe('mi-tienda');
  });

  it('--layout coloca las vistas sin coordenadas; sin él quedan sin colocar', () => {
    const laid = JSON.parse(run(['import', 'examples/banca.dsl', '--layout']).stdout);
    for (const v of laid.views) for (const e of v.elements) expect(typeof e.x).toBe('number');
    // Y el resultado se encadena con el resto de comandos: DSL → JSON con posiciones → .drawio.
    const drawio = run(['convert', '--stdin'], JSON.stringify(laid));
    expect(drawio.status).toBe(0);
    expect((drawio.stdout.match(/<diagram /g) ?? []).length).toBe(3);
  });

  it('deduce el formato del contenido cuando no hay extensión (stdin) y --format lo fuerza', () => {
    const fromDsl = run(['import', '--stdin'], readFileSync('examples/banca.dsl', 'utf8'));
    expect(fromDsl.status).toBe(0);
    expect(JSON.parse(fromDsl.stdout).model.elements).toHaveLength(13);
    const fromDrawio = run(['import', '--stdin'], readFileSync('examples/banca-c4.drawio', 'utf8'));
    expect(JSON.parse(fromDrawio.stdout).model.elements).toHaveLength(13);

    const odd = join(dir, 'sin-extension');
    writeFileSync(odd, '\n\n# nada que ver con la extensión\nworkspace "Raro" { model { s = softwareSystem "S" } }');
    expect(JSON.parse(run(['import', odd]).stdout).workspace.name).toBe('Raro');
    expect(run(['import', odd, '--format', 'drawio']).status).toBe(2);
    expect(run(['import', odd, '--format', 'nope']).stderr).toMatch(/Formato inválido/);
  });

  it('un archivo que no es ni draw.io ni DSL pide indicar el formato', () => {
    const json = join(dir, 'datos.json');
    writeFileSync(json, '{"a": 1}');
    const r = run(['import', json]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toMatch(/^No se reconoce el formato de ".*datos\.json": use --format drawio, dsl o mermaid\./);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('un DSL inválido termina con código 2 y el motivo con su línea, sin stack', () => {
    const bad = join(dir, 'roto.dsl');
    writeFileSync(bad, 'workspace "x" {\n  model {\n    s = softwareSystem "sin cerrar\n  }\n}\n');
    const r = run(['import', bad]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('No se pudo importar el DSL: línea 3: cadena sin cerrar (falta la comilla de cierre)');

    const empty = join(dir, 'vacio.dsl');
    writeFileSync(empty, '# solo un comentario\n');
    const r2 = run(['import', empty]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/No se encontró el bloque «workspace/);
  });

  it('avisa por stderr de lo que no puede importar de un DSL, sin ensuciar el JSON de stdout', () => {
    const file = join(dir, 'con-despliegue.dsl');
    writeFileSync(file, 'workspace "D" {\n  model {\n    s = softwareSystem "S"\n    live = deploymentEnvironment "Live" {\n    }\n  }\n  views {\n    systemContext s "c" { include * }\n  }\n}\n');
    const r = run(['import', file]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).model.elements).toHaveLength(1);
    expect(r.stderr).toMatch(/aviso: Se ignoró 1 sentencia «despliegue \(deploymentEnvironment/);
    expect(r.stderr).toMatch(/1 vistas, 1 aviso\(s\)/);
  });

  it('resuelve !include relativos al archivo, pero no lee nada fuera de su directorio (ni por enlace simbólico)', () => {
    const root = mkdtempSync(join(tmpdir(), 'c4dsl-'));
    const project = join(root, 'proyecto');
    mkdirSync(join(project, 'partes'), { recursive: true });
    writeFileSync(join(root, 'secreto.dsl'), 'secreto = person "Secreto"');
    writeFileSync(join(project, 'partes', 'modelo.dsl'), 's = softwareSystem "Sistema"\n!include personas.dsl');
    writeFileSync(join(project, 'partes', 'personas.dsl'), 'u = person "Usuario"');
    symlinkSync(join(root, 'secreto.dsl'), join(project, 'enlace.dsl'));
    writeFileSync(
      join(project, 'main.dsl'),
      'workspace "Con includes" {\n  model {\n    !include partes/modelo.dsl\n    !include ../secreto.dsl\n    !include enlace.dsl\n    u -> s "Usa"\n  }\n}\n',
    );
    const r = run(['import', join(project, 'main.dsl')]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.model.elements.map((e: { name: string }) => e.name)).toEqual(['Sistema', 'Usuario']);
    expect(doc.model.relationships).toHaveLength(1);
    expect(r.stderr).toMatch(/no se pudo leer el !include «\.\.\/secreto\.dsl» \(no existe o está fuera del directorio del archivo\)/);
    expect(r.stderr).toMatch(/no se pudo leer el !include «enlace\.dsl»/);
    expect(r.stdout).not.toContain('Secreto');

    // Por stdin no hay directorio de referencia: los !include se omiten con un aviso.
    const viaStdin = run(['import', '--stdin', '--format', 'dsl'], 'workspace "x" { model { s = softwareSystem "S"\n !include partes/modelo.dsl } }');
    expect(viaStdin.stderr).toMatch(/no se puede resolver aquí/);
  });
});

describe('iark: Mermaid', () => {
  it('importa un .mmd (C4 nativo) a JSON válido con el nombre del título', () => {
    const r = run(['import', 'examples/banca.mmd']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.workspace.name).toBe('Banca en línea');
    expect(doc.model.elements).toHaveLength(6);
    expect(doc.model.relationships).toHaveLength(4);
    expect(r.stderr).toMatch(/Importado "Banca en línea": 6 elementos, 4 relaciones/);
    expect(run(['validate', '--stdin'], r.stdout).status).toBe(0);
  });

  it('detecta Mermaid por el contenido cuando llega por stdin', () => {
    const r = run(['import', '--stdin'], 'flowchart LR\n  A[Web] --> B[(BD)]');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).model.elements).toHaveLength(2);
  });

  it('un tipo de diagrama no soportado falla con un mensaje claro', () => {
    const r = run(['import', '--stdin', '--format', 'mermaid'], 'pie title x\n "a": 1');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No se pudo importar el diagrama de Mermaid: No se reconoce/);
  });

  it('convert --to mermaid exporta una vista y se puede volver a importar', () => {
    const out = run(['convert', example, '--to', 'mermaid', '--view', 'contenedores']);
    expect(out.status).toBe(0);
    expect(out.stdout.startsWith('C4Container')).toBe(true);
    const back = run(['import', '--stdin'], out.stdout);
    expect(back.status).toBe(0);
    expect(JSON.parse(back.stdout).model.elements.length).toBeGreaterThan(3);
  });

  it('prompt --from acepta un .mmd como documento base', () => {
    const r = run(['prompt', 'Añade una caché', '--from', 'examples/banca.mmd']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Aplicación web');
  });
});

describe('iark: módulos de la suite', () => {
  it('modules lista los módulos instalados y --json emite el manifiesto', () => {
    const list = run(['modules']);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/^c4 {2}Arquitectura de soluciones \(C4\) {2}v1\.0\.0/);
    expect(list.stdout).toMatch(/importa: drawio, mermaid, dsl {2}·/);
    const manifest = JSON.parse(run(['modules', '--json']).stdout);
    expect(manifest).toMatchObject({ schema: 'iark.manifest/1', name: 'DIAgrams' });
    expect(manifest.modules[0]).toMatchObject({ id: 'c4', importFormats: ['drawio', 'mermaid', 'dsl'], exportFormats: ['drawio', 'svg', 'mermaid'] });
  });

  it('--module desconocido falla con la lista de módulos disponibles', () => {
    const r = run(['import', 'examples/banca.mmd', '--module', 'datos']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No existe el módulo «datos»\. Módulos disponibles: c4, integration, data, enterprise, platform, security\./);
  });

  it('modules lista también el módulo de integraciones con sus formatos', () => {
    const list = run(['modules']);
    expect(list.stdout).toMatch(/^integration {2}Arquitectura de integraciones {2}v0\.1\.0/m);
    expect(list.stdout).toMatch(/importa: mermaid, openapi, asyncapi {2}· {2}exporta: mermaid, svg, drawio/);
    const manifest = JSON.parse(run(['modules', '--json']).stdout);
    expect(manifest.modules.map((m: { id: string }) => m.id)).toEqual(['c4', 'integration', 'data', 'enterprise', 'platform', 'security']);
    expect(manifest.modules[1]).toMatchObject({ exportFormats: ['mermaid', 'svg', 'drawio'], importFormats: ['mermaid', 'openapi', 'asyncapi'] });
  });

  it('--format inválido lista los formatos del módulo', () => {
    const r = run(['import', 'examples/banca.mmd', '--format', 'visio']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Formato inválido «visio»\. Use: auto, drawio, dsl, mermaid\./);
  });
});

describe('iark: módulo de integraciones', () => {
  const integ = 'examples/pedidos-integracion.json';
  const dir = mkdtempSync(join(tmpdir(), 'iarkint-'));

  it('validate --module integration valida el documento y devuelve 3 con errores semánticos', () => {
    const ok = run(['validate', integ, '--module', 'integration']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido \(módulo integration\)\. 0 error\(es\)/);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ nodes: [{ id: 'a', kind: 'system', name: 'A' }], interactions: [{ id: 'i', sourceId: 'a', targetId: 'fantasma', style: 'event' }] }));
    const r = run(['validate', bad, '--module', 'integration']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «integration»/);
    expect(r.stderr).toMatch(/destino inexistente/);
  });

  it('schema y prompt --module integration usan el contrato del módulo', () => {
    expect(JSON.parse(run(['schema', '--module', 'integration']).stdout).properties.nodes).toBeDefined();
    expect(JSON.parse(run(['schema', '--module', 'integration', '--generation']).stdout).properties.interactions).toBeDefined();
    const prompt = run(['prompt', 'Pagos con eventos', '--module', 'integration', '--from', integ]);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('arquitecto de integraciones');
    expect(prompt.stdout).toContain('Pagos con eventos');
    expect(prompt.stdout).toContain('tienda-web');
  });

  it('convert --module integration exporta Mermaid (flujo secuencial incluido), SVG y draw.io según --to o la extensión', () => {
    const mmd = run(['convert', integ, '--module', 'integration', '--to', 'mermaid']);
    expect(mmd.status).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart LR/);
    const seq = run(['convert', integ, '--module', 'integration', '--to', 'mermaid', '--view', 'flow:crear-pedido']);
    expect(seq.stdout).toMatch(/^sequenceDiagram/);

    const svg = join(dir, 'mapa.svg');
    expect(run(['convert', integ, '--module', 'integration', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toMatch(/^<svg /);

    const drawio = join(dir, 'mapa.drawio');
    expect(run(['convert', integ, '--module', 'integration', '--out', drawio]).status).toBe(0);
    expect(new XMLParser({ ignoreAttributes: false }).parse(readFileSync(drawio, 'utf8')).mxfile.diagram).toBeDefined();

    const bad = run(['convert', integ, '--module', 'integration', '--to', 'visio']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Formato de salida inválido «visio» para el módulo «integration»\. Use: mermaid, svg, drawio\./);
  });

  it('import --module integration recupera el mapa desde su Mermaid (ida y vuelta)', () => {
    const mmd = join(dir, 'ida.mmd');
    const json = join(dir, 'vuelta.json');
    run(['convert', integ, '--module', 'integration', '--to', 'mermaid', '--out', mmd]);
    const r = run(['import', mmd, '--module', 'integration', '--out', json]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Importado "ida" en el módulo integration: 17 elementos/);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    const names = Object.fromEntries(doc.nodes.map((n: { id: string; name: string }) => [n.id, n.name]));
    expect(names).toMatchObject({ pedidos: 'Servicio de pedidos', kafka: 'Kafka', 'pedidos-api': 'API de pedidos', cliente: 'Cliente', 'pedidos-mcp': 'MCP de pedidos' });
    const kinds = Object.fromEntries(doc.nodes.map((n: { id: string; kind: string }) => [n.id, n.kind]));
    expect(kinds).toMatchObject({ cliente: 'user', 'pedidos-mcp': 'mcp', 'traducir-erp': 'pattern', 'exportador-erp': 'connector', 'reintento-pagos': 'scheduler', gateway: 'gateway' });
    expect(run(['validate', json, '--module', 'integration']).status).toBe(0);
  });

  it('integration from-c4 convierte un documento C4 y deja la referencia urn:iark:c4', () => {
    const r = run(['integration', 'from-c4', example]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.nodes.find((n: { id: string }) => n.id === 'banca').ref).toBe('urn:iark:c4:banca');
    expect(r.stderr).toMatch(/Convertido "Integración - Banca en línea"/);
    const out = join(dir, 'de-c4.json');
    expect(run(['integration', 'from-c4', example, '--out', out, '--name', 'Mi mapa']).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).workspace.name).toBe('Mi mapa');
  });

  it('integration catalog y matrix emiten tablas Markdown (también desde stdin)', () => {
    const catalog = run(['integration', 'catalog', integ]);
    expect(catalog.status).toBe(0);
    expect(catalog.stdout).toContain('| API de pedidos | openapi | 2.1.0 | API Gateway → API de pedidos |');
    const matrix = run(['integration', 'matrix', '--stdin'], readFileSync(integ, 'utf8'));
    expect(matrix.status).toBe(0);
    expect(matrix.stdout).toMatch(/^\| Origen \\ Destino \| Tienda web/);
    expect(matrix.stdout).toContain('evento');
  });

  it('integration contracts valida el contenido de cada contrato y contract-export lo saca a su archivo', () => {
    const report = run(['integration', 'contracts', integ]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain('| Servicio de facturación | protobuf | 1.0.0 | válido |');
    expect(report.stdout).toContain('FacturacionService.ConsultarFactura');
    expect(report.stdout).toContain('| Herramientas MCP de pedidos | mcp | 1.0.0 | válido |');

    const broken = JSON.parse(readFileSync(integ, 'utf8'));
    broken.contracts.find((c: { id: string }) => c.id === 'pedido-creado-ce').content = '{"specversion":"0.3","id":"1"}';
    const withProblems = run(['integration', 'contracts', '--stdin'], JSON.stringify(broken));
    expect(withProblems.stdout).toMatch(/Evento PedidoCreado \(CloudEvents\) \| cloudevents \| 1\.3 \| \d+ problema\(s\)/);
    expect(withProblems.stdout).toContain('### Problemas');

    const proto = run(['integration', 'contract-export', 'facturacion-proto', integ]);
    expect(proto.status).toBe(0);
    expect(proto.stdout).toMatch(/^syntax = "proto3";/);
    expect(proto.stdout).toContain('service FacturacionService');
    const missing = run(['integration', 'contract-export', 'nada', integ]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/No existe el contrato «nada»\. Contratos: /);
  });

  it('integration cloudevents formatea un payload suelto o un envoltorio incompleto como CloudEvents 1.0', () => {
    const wrapped = run(['integration', 'cloudevents', '--stdin', '--type', 'com.tienda.pedido.creado', '--source', '/pedidos'], '{"pedidoId":"1042"}');
    expect(wrapped.status).toBe(0);
    const event = JSON.parse(wrapped.stdout);
    expect(Object.keys(event)).toEqual(['specversion', 'id', 'source', 'type', 'datacontenttype', 'data']);
    expect(event).toMatchObject({ specversion: '1.0', source: '/pedidos', type: 'com.tienda.pedido.creado', data: { pedidoId: '1042' } });

    const completed = run(['integration', 'cloudevents', '--stdin'], '{"type":"com.tienda.pedido.pagado","source":"/pagos","data":{"ok":true}}');
    expect(JSON.parse(completed.stdout)).toMatchObject({ specversion: '1.0', id: 'A234-1234-1234' });

    const invalid = run(['integration', 'cloudevents', '--stdin'], '{ roto');
    expect(invalid.status).not.toBe(0);
  });

  it('convert --view system:<id> dibuja un sistema y sus vecinos', () => {
    const svg = run(['convert', integ, '--module', 'integration', '--to', 'svg', '--view', 'system:pedidos']);
    expect(svg.status).toBe(0);
    expect(svg.stdout).toContain('Sistema - Servicio de pedidos');
    expect(svg.stdout).toContain('MCP de pedidos');
    expect(svg.stdout).not.toContain('ERP corporativo');
  });

  it('generate --module integration falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Un sistema de pagos', '--module', 'integration', '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('iark: módulo de datos', () => {
  const data = 'examples/ventas-datos.json';
  const dir = mkdtempSync(join(tmpdir(), 'iarkdata-'));

  it('modules lista el módulo de datos con sus formatos', () => {
    expect(run(['modules']).stdout).toMatch(/^data {2}Arquitectura de datos {2}v0\.1\.0\n {4}importa: mermaid, ddl, dbt, openlineage {2}· {2}exporta: mermaid, svg, drawio/m);
  });

  it('validate --module data valida el documento y devuelve 2 con errores de estructura', () => {
    const ok = run(['validate', data, '--module', 'data']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido \(módulo data\)\. 0 error\(es\), 0 aviso\(s\)/);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ assets: [{ id: 'a', kind: 'table', name: 'A' }], pipelines: [{ id: 'p', name: 'P', kind: 'batch', inputs: ['a'], outputs: ['fantasma'] }] }));
    const r = run(['validate', bad, '--module', 'data']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «data»/);
    expect(r.stderr).toMatch(/escribe un activo inexistente/);
  });

  it('validate muestra avisos de gobierno y --strict los convierte en fallo', () => {
    const risky = join(dir, 'risky.json');
    writeFileSync(risky, JSON.stringify({ assets: [{ id: 'clientes', kind: 'table', name: 'Clientes', owner: 'CRM', pii: true }] }));
    const r = run(['validate', risky, '--module', 'data']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contiene datos personales pero no tiene clasificación/);
    expect(run(['validate', risky, '--module', 'data', '--strict']).status).toBe(3);
  });

  it('schema y prompt --module data usan el contrato del módulo', () => {
    expect(JSON.parse(run(['schema', '--module', 'data']).stdout).properties.pipelines).toBeDefined();
    expect(JSON.parse(run(['schema', '--module', 'data', '--generation']).stdout).properties.relations).toBeDefined();
    const prompt = run(['prompt', 'Un lago con clientes', '--module', 'data', '--from', data]);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('arquitecto de datos');
    expect(prompt.stdout).toContain('Un lago con clientes');
    expect(prompt.stdout).toContain('dwh-dim-cliente');
  });

  it('convert --module data exporta Mermaid, SVG y draw.io, y elige las vistas por nombre', () => {
    const mmd = run(['convert', data, '--module', 'data', '--to', 'mermaid']);
    expect(mmd.status).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart LR/);
    expect(run(['convert', data, '--module', 'data', '--to', 'mermaid', '--view', 'erd']).stdout).toMatch(/erDiagram/);
    expect(run(['convert', data, '--module', 'data', '--to', 'mermaid', '--view', 'downstream:silver-ventas']).stdout).toMatch(/Carga de hechos/);

    const svg = join(dir, 'linaje.svg');
    expect(run(['convert', data, '--module', 'data', '--out', svg, '--view', 'domain:clientes']).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('Dominio - Clientes');

    const drawio = join(dir, 'datos.drawio');
    expect(run(['convert', data, '--module', 'data', '--out', drawio]).status).toBe(0);
    // Linaje, ERD en pata de gallo, ERD en UML y tres dominios.
    expect([].concat(new XMLParser({ ignoreAttributes: false }).parse(readFileSync(drawio, 'utf8')).mxfile.diagram)).toHaveLength(6);

    const missing = run(['convert', data, '--module', 'data', '--to', 'mermaid', '--view', 'nada']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/No existe la vista «nada»/);
  });

  it('import --module data recupera el linaje desde su Mermaid (ida y vuelta) y un erDiagram', () => {
    const mmd = join(dir, 'linaje.mmd');
    const json = join(dir, 'linaje.json');
    run(['convert', data, '--module', 'data', '--to', 'mermaid', '--out', mmd]);
    const r = run(['import', mmd, '--module', 'data', '--out', json]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Importado "linaje" en el módulo data: 21 elementos/);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(doc.pipelines).toHaveLength(7);
    expect(run(['validate', json, '--module', 'data']).status).toBe(0);

    const er = run(['import', '--stdin', '--module', 'data'], 'erDiagram\n  CLIENTE ||--o{ PEDIDO : realiza\n  CLIENTE {\n    int id PK\n  }');
    expect(er.status).toBe(0);
    expect(JSON.parse(er.stdout).relations[0]).toMatchObject({ cardinality: '1:N', description: 'realiza' });
  });

  it('un Mermaid que no se puede importar termina en un mensaje de una línea con código 2, sin stack', () => {
    const r = run(['import', '--stdin', '--module', 'data'], 'sequenceDiagram\n  A->>B: hola');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no se puede importar como datos/);
    expect(r.stderr).not.toMatch(/Error inesperado|\n\s+at /);
  });

  it('data lineage, catalog y pii', () => {
    const lineage = run(['data', 'lineage', 'dwh-dim-cliente', data]);
    expect(lineage.status).toBe(0);
    expect(lineage.stdout).toContain('Aguas arriba (de dónde vienen sus datos): 6 activo(s)');
    expect(lineage.stdout).toContain('Responsables a avisar: Equipo Plataforma, Ciencia de datos');
    expect(run(['data', 'lineage', 'dwh-dim-cliente', data, '--direction', 'upstream']).stdout).not.toContain('Aguas abajo');

    const unknown = run(['data', 'lineage', 'nada', data]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/No existe el activo «nada»/);

    expect(run(['data', 'catalog', data]).stdout).toContain('| Panel de ventas | Informe | — | Ventas | Equipo BI | interna | No | Actualiza el panel |');
    const pii = run(['data', 'pii', '--stdin'], readFileSync(data, 'utf8'));
    expect(pii.status).toBe(0);
    expect(pii.stdout).toContain('**Adónde llegan sin anonimizarse (linaje aguas abajo)**');
  });

  it('data from-integration crea el inventario con referencias URN', () => {
    const r = run(['data', 'from-integration', 'examples/pedidos-integracion.json']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.assets.find((a: { id: string }) => a.id === 'pedidos-db')).toMatchObject({ kind: 'database', ref: 'urn:iark:integration:pedidos-db' });
    expect(doc.assets.find((a: { id: string }) => a.id === 'pedido-creado').kind).toBe('stream');
    expect(r.stderr).toMatch(/No se crean pipelines/);
  });

  it('generate --module data falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Un lago de datos', '--module', 'data', '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});

describe('iark: módulo empresarial', () => {
  const ent = 'examples/empresa-arquitectura.json';
  const dir = mkdtempSync(join(tmpdir(), 'iarkent-'));

  it('modules lista el módulo empresarial con sus formatos', () => {
    expect(run(['modules']).stdout).toMatch(/^enterprise {2}Arquitectura empresarial {2}v0\.1\.0\n {4}importa: mermaid, archimate, bpmn {2}· {2}exporta: mermaid, svg, drawio/m);
  });

  it('validate --module enterprise valida el documento y devuelve 2 con errores de estructura', () => {
    const ok = run(['validate', ent, '--module', 'enterprise']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido \(módulo enterprise\)\. 0 error\(es\), 0 aviso\(s\)/);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ applications: [{ id: 'a', name: 'A' }], capabilities: [{ id: 'c', name: 'C' }], relations: [{ id: 'r', kind: 'supports', sourceId: 'c', targetId: 'a' }] }));
    const r = run(['validate', bad, '--module', 'enterprise']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «enterprise»/);
    expect(r.stderr).toMatch(/no puede unir capacidad → aplicación/);
  });

  it('validate muestra avisos de gobierno y --strict los convierte en fallo', () => {
    const risky = join(dir, 'risky.json');
    writeFileSync(risky, JSON.stringify({ units: [{ id: 'u', name: 'U' }], capabilities: [{ id: 'c', name: 'Clave', ownerId: 'u', importance: 'core' }] }));
    const r = run(['validate', risky, '--module', 'enterprise']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Capacidad «Clave» no está soportada por ninguna aplicación/);
    expect(run(['validate', risky, '--module', 'enterprise', '--strict']).status).toBe(3);
  });

  it('schema y prompt --module enterprise usan el contrato del módulo', () => {
    expect(JSON.parse(run(['schema', '--module', 'enterprise']).stdout).properties.capabilities).toBeDefined();
    expect(JSON.parse(run(['schema', '--module', 'enterprise', '--generation']).stdout).properties.relations).toBeDefined();
    const prompt = run(['prompt', 'Un banco', '--module', 'enterprise', '--from', ent]);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('arquitecto empresarial');
    expect(prompt.stdout).toContain('Un banco');
    expect(prompt.stdout).toContain('motor-precios');
  });

  it('convert --module enterprise exporta Mermaid, SVG y draw.io, y elige las vistas por nombre', () => {
    const mmd = run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid']);
    expect(mmd.status).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart TB/);
    expect(run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid', '--view', 'landscape']).stdout).toMatch(/erp\["ERP corporativo<br\/>SAP S\/4HANA"\]:::application/);
    expect(run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid', '--view', 'impact:hana']).stdout).toMatch(/Tienda online/);

    const svg = join(dir, 'mapa.svg');
    expect(run(['convert', ent, '--module', 'enterprise', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('Mapa de capacidades');

    const drawio = join(dir, 'empresa.drawio');
    expect(run(['convert', ent, '--module', 'enterprise', '--out', drawio]).status).toBe(0);
    expect([].concat(new XMLParser({ ignoreAttributes: false }).parse(readFileSync(drawio, 'utf8')).mxfile.diagram)).toHaveLength(12);

    const missing = run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid', '--view', 'nada']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/No existe la vista «nada»/);
  });

  it('import --module enterprise recupera el paisaje desde su Mermaid (ida y vuelta)', () => {
    const mmd = join(dir, 'paisaje.mmd');
    const json = join(dir, 'paisaje.json');
    run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid', '--view', 'landscape', '--out', mmd]);
    const r = run(['import', mmd, '--module', 'enterprise', '--out', json]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Importado "paisaje" en el módulo enterprise: 31 elementos/);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(doc.relations).toHaveLength(39);
    expect(doc.applications).toHaveLength(11);
    expect(run(['validate', json, '--module', 'enterprise']).status).toBe(0);
  });

  describe('import --module enterprise con ArchiMate', () => {
    const fixtures = 'tests/fixtures/importar/archimate';
    const comercio = `${fixtures}/comercio-andino.xml`;

    it('--format archimate convierte el modelo, lo valida y resume en avisos lo que no importa', () => {
      const json = join(dir, 'comercio.json');
      const r = run(['import', comercio, '--module', 'enterprise', '--format', 'archimate', '--out', json]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/Importado "Comercio Andino - arquitectura empresarial" en el módulo enterprise: 66 elementos, \d+ aviso\(s\)\./);
      expect(r.stderr).toContain('aviso: 4 elementos de motivación sin equivalente en el módulo, no se importan (Driver, Goal, Requirement, Stakeholder)');
      expect(r.stderr).toMatch(/aviso: .*(implementación y migración|vistas)/);
      expect(r.stderr).not.toMatch(/Error inesperado|\n\s+at /);
      const doc = JSON.parse(readFileSync(json, 'utf8'));
      expect(doc.applications).toHaveLength(14);
      expect(doc.capabilities).toHaveLength(16);
      expect(doc.relations).toHaveLength(61);
      const valid = run(['validate', json, '--module', 'enterprise']);
      expect(valid.status).toBe(0);
      expect(valid.stdout).toMatch(/Documento válido \(módulo enterprise\)\. 0 error\(es\)/);
    });

    it('sin --format elige ArchiMate por la extensión (.xml y .archimate) y por el contenido (stdin)', () => {
      const porXml = run(['import', comercio, '--module', 'enterprise']);
      expect(porXml.status).toBe(0);
      expect(JSON.parse(porXml.stdout).workspace.name).toBe('Comercio Andino - arquitectura empresarial');

      const archi = run(['import', `${fixtures}/tienda-archi.archimate`, '--module', 'enterprise']);
      expect(archi.status).toBe(0);
      expect(archi.stderr).toMatch(/Importado "Tienda de barrio" en el módulo enterprise: \d+ elementos/);
      expect(JSON.parse(archi.stdout).applications.map((a: { id: string }) => a.id)).toEqual(['tpv', 'hoja-de-existencias', 'inventario']);

      const porContenido = run(['import', '--stdin', '--module', 'enterprise'], readFileSync(`${fixtures}/bizbank-en.xml`, 'utf8'));
      expect(porContenido.status).toBe(0);
      expect(JSON.parse(porContenido.stdout).workspace.name).toBe('BizBank - retail banking architecture');
      // lo mismo con --name: el nombre explícito manda sobre el del modelo
      expect(JSON.parse(run(['import', comercio, '--module', 'enterprise', '--name', 'Mi empresa']).stdout).workspace.name).toBe('Mi empresa');
    });

    it('el documento importado se exporta: Mermaid del paisaje, SVG del mapa de capacidades y draw.io', () => {
      const json = join(dir, 'andino.json');
      expect(run(['import', comercio, '--module', 'enterprise', '--out', json]).status).toBe(0);
      const mmd = run(['convert', json, '--module', 'enterprise', '--to', 'mermaid', '--view', 'landscape']);
      expect(mmd.status).toBe(0);
      expect(mmd.stdout).toMatch(/\["Tienda online<br\/>React \+ Node\.js"\]:::application/);
      expect(run(['convert', json, '--module', 'enterprise', '--to', 'mermaid', '--view', 'impact:tienda-web-1-8-2']).stdout).toMatch(/Tienda online/);
      const svg = join(dir, 'andino.svg');
      expect(run(['convert', json, '--module', 'enterprise', '--out', svg]).status).toBe(0);
      expect(readFileSync(svg, 'utf8')).toContain('Mapa de capacidades');
      const gov = run(['enterprise', 'coverage', json]);
      expect(gov.status).toBe(0);
      expect(gov.stdout).toMatch(/Cobertura: 11 de 12 capacidad\(es\) hoja tienen al menos una aplicación\./);
    });

    it('un XML roto o que no es ArchiMate termina en un mensaje de una línea con código 2, sin stack', () => {
      const roto = run(['import', `${fixtures}/xml-roto.xml`, '--module', 'enterprise', '--format', 'archimate']);
      expect(roto.status).toBe(2);
      expect(roto.stderr).toBe('XML mal formado: se esperaba «</elements>» (abierta en la línea 8, columna 3) y se encontró «</model>» (línea 20, columna 1).\n');
      const otro = run(['import', '--stdin', '--module', 'enterprise', '--format', 'archimate'], '<?xml version="1.0"?><mxfile><diagram/></mxfile>');
      expect(otro.status).toBe(2);
      expect(otro.stderr).toMatch(/^La raíz del XML es «mxfile»: un modelo de ArchiMate empieza por «model»/);
      expect(otro.stderr).not.toMatch(/Error inesperado|\n\s+at /);
      expect(run(['import', comercio, '--module', 'enterprise', '--format', 'visio']).stderr).toMatch(/Formato inválido «visio»\. Use: auto, archimate, bpmn, mermaid\./);
    });
  });

  it('la matriz capacidad × aplicación exportada como block-beta se importa de vuelta, por extensión y por contenido, y los avisos dicen lo que no viaja', () => {
    const exported = run(['convert', ent, '--module', 'enterprise', '--to', 'mermaid', '--view', 'matrix']);
    expect(exported.status).toBe(0);
    expect(exported.stdout.split('\n')[0]).toBe('block-beta');
    const file = join(dir, 'matriz.mmd');
    writeFileSync(file, exported.stdout);
    const names = (doc: { capabilities: Array<{ name: string }>; applications: Array<{ name: string }> }) => [doc.capabilities.map((c) => c.name), doc.applications.map((a) => a.name)];
    const original = JSON.parse(readFileSync(ent, 'utf8'));

    const json = join(dir, 'matriz.json');
    const porExtension = run(['import', file, '--module', 'enterprise', '--out', json]);
    expect(porExtension.status).toBe(0);
    expect(porExtension.stderr).toMatch(/Importado "matriz" en el módulo enterprise: 27 elementos, 3 aviso\(s\)\./);
    expect(porExtension.stderr).toContain('aviso: 2 celdas ○ (soporte por un proceso que realiza la capacidad) no se importan como relaciones');
    expect(porExtension.stderr).toMatch(/aviso: \d+ celdas · \(soporte heredado de una capacidad hija\) no se importan/);
    expect(porExtension.stderr).toContain('aviso: Solo se importan los nombres, la jerarquía de capacidades y el soporte directo (●)');
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(names(doc)).toEqual(names(original));
    expect(doc.relations.filter((r: { kind: string }) => r.kind === 'supports')).toHaveLength(original.relations.filter((r: { kind: string; targetId: string }) => r.kind === 'supports' && original.capabilities.some((c: { id: string }) => c.id === r.targetId)).length);
    expect(run(['validate', json, '--module', 'enterprise']).stdout).toMatch(/Documento válido \(módulo enterprise\)\. 0 error\(es\)/);

    // Sin extensión (stdin) lo reconoce por el contenido, y con --format mermaid también.
    expect(names(JSON.parse(run(['import', '--stdin', '--module', 'enterprise'], exported.stdout).stdout))).toEqual(names(original));
    expect(names(JSON.parse(run(['import', file, '--module', 'enterprise', '--format', 'mermaid']).stdout))).toEqual(names(original));

    // Un diagrama de bloques que no es una matriz termina en un mensaje de una línea con código 2.
    const roto = run(['import', '--stdin', '--module', 'enterprise'], 'block-beta\n  columns 3\n  space:1 a["A"] total["Total"]\n  r["R"] c["●"]');
    expect(roto.status).toBe(2);
    expect(roto.stderr).toMatch(/Las 5 entradas del diagrama no forman filas de 3 columnas/);
    expect(roto.stderr).not.toMatch(/Error inesperado|\n\s+at /);
  });

  it('un Mermaid que no se puede importar termina en un mensaje de una línea con código 2, sin stack', () => {
    const r = run(['import', '--stdin', '--module', 'enterprise'], 'sequenceDiagram\n  A->>B: hola');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no se puede importar como arquitectura empresarial/);
    expect(r.stderr).not.toMatch(/Error inesperado|\n\s+at /);
  });

  it('enterprise coverage, impact y lifecycle', () => {
    const coverage = run(['enterprise', 'coverage', ent]);
    expect(coverage.status).toBe(0);
    expect(coverage.stdout).toContain('Cobertura: 12 de 12 capacidad(es) hoja tienen al menos una aplicación.');

    const impact = run(['enterprise', 'impact', 'kubernetes', ent]);
    expect(impact.status).toBe(0);
    expect(impact.stdout).toContain('Impacto de «Kubernetes» (Tecnología)');
    expect(impact.stdout).toContain('Responsables a avisar: Equipo Plataforma');
    expect(run(['enterprise', 'impact', 'tienda-web', ent, '--direction', 'dependencies']).stdout).not.toContain('Responsables a avisar');

    const unknown = run(['enterprise', 'impact', 'nada', ent]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/No existe el elemento «nada»/);

    const lifecycle = run(['enterprise', 'lifecycle', '--stdin', '--today', '2026-06-15'], readFileSync(ent, 'utf8'));
    expect(lifecycle.status).toBe(0);
    expect(lifecycle.stdout).toContain('| WMS heredado | Aplicación | en retirada | — | Gestión de inventario | Gestión de inventario |');
  });

  it('enterprise matrix imprime la matriz capacidad × aplicación en tabla o CSV y rechaza formatos desconocidos', () => {
    const table = run(['enterprise', 'matrix', ent]);
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('| Capacidad | Tienda online |');
    expect(table.stdout).toContain('Cobertura: 12 de 12 capacidad(es) sin hijas tienen al menos una aplicación.');
    expect(table.stdout).toContain('Solapamientos sin criterio');

    const csv = run(['enterprise', 'matrix', '--format', 'csv', '--stdin'], readFileSync(ent, 'utf8'));
    expect(csv.status).toBe(0);
    expect(csv.stdout.split('\n')[0]).toMatch(/^Id,Capacidad,Ruta,Nivel,Tienda online,/);
    expect(csv.stdout).toContain('gestion-pedidos');

    const bad = run(['enterprise', 'matrix', ent, '--format', 'xml']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Formato inválido «xml»/);
  });

  it('enterprise from-integration crea el inventario de aplicaciones con referencias URN', () => {
    const r = run(['enterprise', 'from-integration', 'examples/pedidos-integracion.json']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.applications.length).toBeGreaterThan(0);
    expect(doc.applications[0].ref).toMatch(/^urn:iark:integration:/);
    expect(doc.technologies.every((t: { kind: string }) => t.kind === 'database')).toBe(true);
    expect(r.stderr).toMatch(/No se crean capacidades ni procesos/);
    expect(run(['validate', '--stdin', '--module', 'enterprise'], r.stdout).status).toBe(0);
  });

  it('generate --module enterprise falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Un banco', '--module', 'enterprise', '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});

describe('iark: módulo de plataforma', () => {
  const plat = 'examples/plataforma-ejemplo.json';
  const dir = mkdtempSync(join(tmpdir(), 'iarkplat-'));

  it('modules lista el módulo de plataforma con sus formatos', () => {
    expect(run(['modules']).stdout).toMatch(/^platform {2}Arquitectura de plataforma {2}v0\.1\.0\n {4}importa: mermaid, terraform, kubernetes, cloudformation, helm {2}· {2}exporta: mermaid, svg, drawio/m);
  });

  it('validate --module platform valida el documento y devuelve 2 con errores de estructura', () => {
    const ok = run(['validate', plat, '--module', 'platform']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido \(módulo platform\)\. 0 error\(es\), 0 aviso\(s\)/);

    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        environments: [{ id: 'prod', name: 'Prod' }],
        resources: [{ id: 'db', name: 'db', kind: 'database', environmentId: 'prod' }],
        services: [{ id: 'api', name: 'API' }],
        deployments: [{ id: 'd', serviceId: 'api', environmentId: 'prod', hostId: 'db' }],
      }),
    );
    const r = run(['validate', bad, '--module', 'platform']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «platform»/);
    expect(r.stderr).toMatch(/un servicio solo se despliega en un clúster o una máquina virtual/);
  });

  it('validate muestra avisos de gobierno y --strict los convierte en fallo', () => {
    const risky = join(dir, 'risky.json');
    writeFileSync(risky, JSON.stringify({ services: [{ id: 'api', name: 'API', criticality: 'critical', owner: 'Equipo' }] }));
    const r = run(['validate', risky, '--module', 'platform']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Servicio «API» no se despliega en ningún entorno/);
    expect(run(['validate', risky, '--module', 'platform', '--strict']).status).toBe(3);
  });

  it('schema y prompt --module platform usan el contrato del módulo', () => {
    expect(JSON.parse(run(['schema', '--module', 'platform']).stdout).properties.deployments).toBeDefined();
    expect(JSON.parse(run(['schema', '--module', 'platform', '--generation']).stdout).properties.pipelines).toBeDefined();
    const prompt = run(['prompt', 'Una tienda', '--module', 'platform', '--from', plat]);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('arquitecto de plataforma');
    expect(prompt.stdout).toContain('Una tienda');
    expect(prompt.stdout).toContain('pedidos-db-prod');
  });

  it('convert --module platform exporta Mermaid, SVG y draw.io, y elige las vistas por nombre', () => {
    const mmd = run(['convert', plat, '--module', 'platform', '--to', 'mermaid']);
    expect(mmd.status).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart LR/);
    expect(mmd.stdout).toContain('pedidos_db_dev[("Base de pedidos (dev)');
    const prod = run(['convert', plat, '--module', 'platform', '--to', 'mermaid', '--view', 'env:prod']);
    expect(prod.stdout).toContain('subgraph env_prod["Entorno: Producción"]');
    expect(run(['convert', plat, '--module', 'platform', '--to', 'mermaid', '--view', 'impact:kafka-prod']).stdout).toMatch(/facturacion -\.->\|"Kafka · Consume PedidoCreado"\| kafka_prod/);

    const svg = join(dir, 'topologia.svg');
    expect(run(['convert', plat, '--module', 'platform', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('Topología');

    const drawio = join(dir, 'plataforma.drawio');
    expect(run(['convert', plat, '--module', 'platform', '--out', drawio]).status).toBe(0);
    expect([].concat(new XMLParser({ ignoreAttributes: false }).parse(readFileSync(drawio, 'utf8')).mxfile.diagram)).toHaveLength(6);

    const missing = run(['convert', plat, '--module', 'platform', '--to', 'mermaid', '--view', 'nada']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/No existe la vista «nada»/);
  });

  it('import --module platform recupera un entorno desde su Mermaid (ida y vuelta)', () => {
    const mmd = join(dir, 'produccion.mmd');
    const json = join(dir, 'produccion.json');
    run(['convert', plat, '--module', 'platform', '--to', 'mermaid', '--view', 'env:prod', '--out', mmd]);
    const r = run(['import', mmd, '--module', 'platform', '--out', json]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Importado "produccion" en el módulo platform: 15 elementos/);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(doc.deployments).toHaveLength(5);
    expect(doc.dependencies).toHaveLength(8);
    expect(run(['validate', json, '--module', 'platform']).status).toBe(0);
  });

  it('un Mermaid que no se puede importar termina en un mensaje de una línea con código 2, sin stack', () => {
    const r = run(['import', '--stdin', '--module', 'platform'], 'sequenceDiagram\n  A->>B: hola');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no se puede importar como plataforma/);
    expect(r.stderr).not.toMatch(/Error inesperado|\n\s+at /);
  });

  it('platform deployments e impact', () => {
    const deployments = run(['platform', 'deployments', plat]);
    expect(deployments.status).toBe(0);
    expect(deployments.stdout).toContain('| Servicio de pedidos | crítica | k8s-dev ×1 v3.1.0 | k8s-prod ×3 v3.0.2 |');

    const impact = run(['platform', 'impact', 'k8s-prod', plat]);
    expect(impact.status).toBe(0);
    expect(impact.stdout).toContain('Impacto de «k8s-prod» (Clúster) en el entorno «Producción»');
    expect(impact.stdout).toContain('Responsables a avisar: Plataforma, Equipo Web');
    expect(run(['platform', 'impact', 'pedidos', plat, '--env', 'dev', '--direction', 'dependencies']).stdout).toContain('- k8s-dev (Clúster) · Plataforma');

    const unknown = run(['platform', 'impact', 'nada', plat]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/No existe el servicio ni el recurso «nada»/);
  });

  it('platform from-integration crea el inventario de la plataforma con referencias URN', () => {
    const r = run(['platform', 'from-integration', 'examples/pedidos-integracion.json']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.services.length).toBeGreaterThan(0);
    expect(doc.services[0].ref).toMatch(/^urn:iark:integration:/);
    expect(doc.resources.map((x: { kind: string }) => x.kind)).toEqual(['gateway', 'queue', 'database']);
    expect(r.stderr).toMatch(/No se crean redes, anfitriones ni despliegues/);
    expect(run(['validate', '--stdin', '--module', 'platform'], r.stdout).status).toBe(0);
  });

  it('generate --module platform falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Una tienda', '--module', 'platform', '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});

describe('iark: módulo de seguridad', () => {
  const sec = 'examples/seguridad-ejemplo.json';
  const dir = mkdtempSync(join(tmpdir(), 'iarksec-'));

  it('modules lista el módulo de seguridad con sus formatos', () => {
    expect(run(['modules']).stdout).toMatch(/^security {2}Arquitectura de seguridad {2}v0\.1\.0\n {4}importa: mermaid, threat-dragon {2}· {2}exporta: mermaid, svg, drawio/m);
  });

  it('validate --module security valida el documento, muestra los avisos de gobierno y devuelve 2 con errores de estructura', () => {
    const ok = run(['validate', sec, '--module', 'security']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido \(módulo security\)\. 0 error\(es\), 7 aviso\(s\)/);
    expect(ok.stdout).toMatch(/Flujo «Confirmación del pedido» cruza la frontera de «Red interna» a «Internet» sin cifrar/);
    expect(run(['validate', sec, '--module', 'security', '--strict']).status).toBe(3);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ zones: [{ id: 'z', name: 'Z' }], assets: [{ id: 'a', name: 'A', kind: 'process', zoneId: 'z' }], flows: [{ id: 'f', sourceId: 'a', targetId: 'z' }] }));
    const r = run(['validate', bad, '--module', 'security']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «security»/);
    expect(r.stderr).toMatch(/Un flujo une activos, pero "z" es zona/);
  });

  it('schema y prompt --module security usan el contrato del módulo', () => {
    expect(JSON.parse(run(['schema', '--module', 'security']).stdout).properties.zones).toBeDefined();
    expect(JSON.parse(run(['schema', '--module', 'security', '--generation']).stdout).properties.threats).toBeDefined();
    const prompt = run(['prompt', 'Una tienda', '--module', 'security', '--from', sec]);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('arquitecto de seguridad');
    expect(prompt.stdout).toContain('Una tienda');
    expect(prompt.stdout).toContain('pedidos-db');
  });

  it('convert --module security exporta Mermaid, SVG y draw.io, y elige las vistas por nombre', () => {
    const mmd = run(['convert', sec, '--module', 'security', '--to', 'mermaid']);
    expect(mmd.status).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart LR/);
    expect(mmd.stdout).toContain('subgraph internet["Zona no confiable: Internet"]');
    expect(run(['convert', sec, '--module', 'security', '--to', 'mermaid', '--view', 'threats']).stdout).toContain(':::threat');
    expect(run(['convert', sec, '--module', 'security', '--to', 'mermaid', '--view', 'blast:pedidos']).stdout).toContain('pedidos ==>|"Kafka sobre TLS');

    const svg = join(dir, 'flujos.svg');
    expect(run(['convert', sec, '--module', 'security', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('Flujos de datos y fronteras de confianza');

    const drawio = join(dir, 'seguridad.drawio');
    expect(run(['convert', sec, '--module', 'security', '--out', drawio]).status).toBe(0);
    expect([].concat(new XMLParser({ ignoreAttributes: false }).parse(readFileSync(drawio, 'utf8')).mxfile.diagram)).toHaveLength(4);

    const missing = run(['convert', sec, '--module', 'security', '--to', 'mermaid', '--view', 'nada']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/No existe la vista «nada»/);
  });

  it('import --module security recupera zonas, activos y flujos desde su Mermaid (ida y vuelta)', () => {
    const mmd = join(dir, 'flujos.mmd');
    const json = join(dir, 'flujos.json');
    run(['convert', sec, '--module', 'security', '--to', 'mermaid', '--out', mmd]);
    const r = run(['import', mmd, '--module', 'security', '--out', json]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Importado "flujos" en el módulo security: 15 elementos/);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(doc.zones).toHaveLength(4);
    expect(doc.assets).toHaveLength(11);
    expect(doc.flows).toHaveLength(10);
    expect(run(['validate', json, '--module', 'security']).status).toBe(0);
  });

  it('un Mermaid que no se puede importar termina en un mensaje de una línea con código 2, sin stack', () => {
    const r = run(['import', '--stdin', '--module', 'security'], 'sequenceDiagram\n  A->>B: hola');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no se puede importar como seguridad/);
    expect(r.stderr).not.toMatch(/Error inesperado|\n\s+at /);
  });

  it('security risks, stride y exposure', () => {
    const risks = run(['security', 'risks', sec]);
    expect(risks.status).toBe(0);
    expect(risks.stdout).toContain('| crítico (9) | Robo de credenciales de clientes (credential stuffing) |');
    expect(risks.stdout).toContain('| Estado | Controles | Residual |');
    expect(risks.stdout).toContain('Abiertas por riesgo residual: 0 crítico, 2 alto, 2 medio, 0 bajo');
    expect(run(['security', 'risks', sec, '--status', 'accepted']).stdout).toContain('Denegación de servicio distribuida');
    expect(run(['security', 'risks', sec, '--status', 'cerrada']).status).toBe(2);

    const stride = run(['security', 'stride', sec]);
    expect(stride.stdout).toContain('| Servicio de pedidos | Proceso | ○ | ✓1 | ✓1 | ○ | ○ | ●1 |');
    expect(stride.stdout).toContain('Analizadas: 10 · Sin analizar: 70');

    const exposure = run(['security', 'exposure', sec]);
    expect(exposure.stdout).toContain('Puntos de entrada desde zonas no confiables: 1');
    expect(exposure.stdout).toContain('Caminos hasta los activos que interesa proteger: 6');
  });

  it('security heatmap y standards: la matriz de calor (inherente o residual) y la cobertura de estándares', () => {
    const heatmap = run(['security', 'heatmap', sec]);
    expect(heatmap.status).toBe(0);
    expect(heatmap.stdout).toContain('| Probabilidad \\ Impacto | bajo | medio | alto | crítico |');
    expect(heatmap.stdout).toContain('- prob. alta × impacto alto · riesgo crítico (9) · 1 amenaza\n  - Robo de credenciales de clientes (credential stuffing)');
    const residual = run(['security', 'heatmap', sec, '--residual']);
    expect(residual.stdout).toContain('Matriz de calor (riesgo residual)');
    expect(residual.stdout).toContain('| baja | 0 | 1 | 5 | 0 |');

    // El ejemplo no remite a ningún estándar: se le añaden a algunos controles.
    const json = JSON.parse(readFileSync(sec, 'utf8'));
    for (const c of json.controls) if (c.id === 'tls-borde' || c.id === 'mfa') c.standard = 'asvs';
    const withStandards = JSON.stringify(json);
    expect(run(['security', 'standards', sec]).stdout).toMatch(/^Ningún control remite a un estándar/);
    const all = run(['security', 'standards', '--stdin'], withStandards);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain('| OWASP ASVS | 2 | 1 | 1 | 8 |');
    const asvs = run(['security', 'standards', '--stdin', '--catalogo', 'asvs'], withStandards);
    expect(asvs.stdout).toContain('Cobertura de estándares (OWASP ASVS)');
    const bad = run(['security', 'standards', sec, '--catalogo', 'pci']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Catálogo inválido «pci»/);
  });

  it('security from-integration y from-platform crean el modelo con referencias URN', () => {
    const fromIntegration = run(['security', 'from-integration', 'examples/pedidos-integracion.json']);
    expect(fromIntegration.status).toBe(0);
    const integ = JSON.parse(fromIntegration.stdout);
    expect(integ.assets[0].ref).toMatch(/^urn:iark:integration:/);
    expect(integ.zones.map((z: { id: string }) => z.id)).toEqual(['red-interna', 'perimetro', 'externo']);
    expect(fromIntegration.stderr).toMatch(/Las zonas de confianza se proponen por heurística/);
    expect(run(['validate', '--stdin', '--module', 'security'], fromIntegration.stdout).status).toBe(0);

    const fromPlatform = run(['security', 'from-platform', 'examples/plataforma-ejemplo.json', '--env', 'prod']);
    expect(fromPlatform.status).toBe(0);
    const plat = JSON.parse(fromPlatform.stdout);
    expect(plat.assets.find((a: { id: string }) => a.id === 'pedidos').ref).toBe('urn:iark:platform:pedidos');
    expect(plat.zones.find((z: { id: string }) => z.id === 'subred-datos').trust).toBe('restricted');
    expect(run(['validate', '--stdin', '--module', 'security'], fromPlatform.stdout).status).toBe(0);
    const unknown = run(['security', 'from-platform', 'examples/plataforma-ejemplo.json', '--env', 'qa']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/No existe el entorno «qa»/);
  });

  it('generate --module security falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(process.execPath, [cli, 'generate', 'Una tienda', '--module', 'security', '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_PROFILE: 'inexistente-c4-test',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_FOUNDRY_API_KEY: '',
        ANTHROPIC_FOUNDRY_BASE_URL: '',
        ANTHROPIC_FOUNDRY_RESOURCE: '',
        ANTHROPIC_FOUNDRY_MODEL: '',
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        HOME: dir,
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});
