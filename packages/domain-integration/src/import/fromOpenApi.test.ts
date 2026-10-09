import { readFileSync } from 'node:fs';
import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { analyzeIntegration } from '../issues';
import { integrationModule } from '../module';
import { integrationDocumentSchema } from '../schema';
import { fromOpenApi, looksLikeOpenApi } from './fromOpenApi';
import { IntegrationImportError } from './fromMermaid';

const FIXTURES = 'tests/fixtures/importar/openapi';
const petstore = readFileSync(`${FIXTURES}/petstore.yaml`, 'utf8');
const pedidos = readFileSync(`${FIXTURES}/pedidos-31.json`, 'utf8');
const registry = new ModuleRegistry().register(integrationModule);
const asyncapi = readFileSync('tests/fixtures/importar/asyncapi/streetlights-v2.yaml', 'utf8');

const idsOf = (doc: { nodes: Array<{ id: string }> }): string[] => doc.nodes.map((n) => n.id);

describe('OpenAPI: detect', () => {
  it('reconoce OpenAPI 3.x y Swagger 2.0 en YAML y en JSON, con cualquier orden de claves', () => {
    expect(looksLikeOpenApi(petstore)).toBe(true);
    expect(looksLikeOpenApi(pedidos)).toBe(true);
    expect(looksLikeOpenApi('{"info":{"title":"x"},"paths":{},"openapi":"3.0.1"}')).toBe(true);
    expect(looksLikeOpenApi('swagger: "2.0"\ninfo: {title: x, version: "1"}\npaths: {}\n')).toBe(true);
    expect(looksLikeOpenApi("openapi: '3.1.0' # comentario\n")).toBe(true);
    expect(looksLikeOpenApi('﻿openapi: 3.0.0\n')).toBe(true);
  });

  it('no se confunde con AsyncAPI, con JSON o YAML cualquiera ni con documentos de la suite', () => {
    expect(looksLikeOpenApi(asyncapi)).toBe(false);
    expect(looksLikeOpenApi('{"asyncapi":"2.6.0","info":{}}')).toBe(false);
    expect(looksLikeOpenApi('{"a":1,"b":[1,2]}')).toBe(false);
    expect(looksLikeOpenApi('[1,2,3]')).toBe(false);
    expect(looksLikeOpenApi('a: 1\nb: 2\n')).toBe(false);
    expect(looksLikeOpenApi('flowchart LR\n  a --> b\n')).toBe(false);
    expect(looksLikeOpenApi('')).toBe(false);
    expect(looksLikeOpenApi(readFileSync('examples/pedidos-integracion.json', 'utf8'))).toBe(false);
    // una clave openapi anidada o con otra versión no cuenta
    expect(looksLikeOpenApi('ejemplo:\n  openapi: 3.0.0\n')).toBe(false);
    expect(looksLikeOpenApi('{"openapi":"4.0.0"}')).toBe(false);
    expect(looksLikeOpenApi('{"x":{"openapi":"3.0.0"}}')).toBe(false);
  });

  it('el módulo elige OpenAPI o AsyncAPI por el contenido cuando comparten extensión', () => {
    expect(registry.detectImporter('integration', 'petstore.yaml', petstore)?.id).toBe('openapi');
    expect(registry.detectImporter('integration', 'pedidos.json', pedidos)?.id).toBe('openapi');
    expect(registry.detectImporter('integration', 'eventos.yaml', asyncapi)?.id).toBe('asyncapi');
    expect(registry.detectImporter('integration', undefined, petstore)?.id).toBe('openapi');
    expect(registry.detectImporter('integration', 'diagrama.mmd', 'flowchart LR\n a --> b')?.id).toBe('mermaid');
  });
});

describe('OpenAPI: mapeo', () => {
  const { document: doc, warnings } = fromOpenApi(petstore);

  it('la API es un sistema con un nodo api por tag, hijo suyo, y un contrato enlazado a cada uno', () => {
    expect(doc.workspace.name).toBe('Tienda de mascotas');
    expect(doc.nodes.map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ['tienda-de-mascotas', 'system', undefined],
      ['cliente-de-la-api', 'system', undefined],
      ['pet', 'api', 'tienda-de-mascotas'],
      ['store', 'api', 'tienda-de-mascotas'],
      ['user', 'api', 'tienda-de-mascotas'],
    ]);
    const system = doc.nodes[0];
    expect(system).toMatchObject({ technology: 'OpenAPI 3.0.3', owner: 'Equipo de Catálogo', tags: ['openapi'] });
    expect(system.description).toContain('Versión 1.0.7');
    expect(system.description).not.toContain('Segundo párrafo');
    expect(doc.contracts).toHaveLength(1);
    expect(doc.contracts[0]).toMatchObject({ format: 'openapi', version: '1.0.7', content: petstore });
    for (const api of doc.nodes.filter((n) => n.kind === 'api')) expect(api).toMatchObject({ contractId: doc.contracts[0].id, owner: 'Equipo de Catálogo', technology: 'REST' });
    expect(doc.nodes.find((n) => n.id === 'pet')!.description).toBe('Todo sobre tus mascotas · 5 operación(es) · 1 obsoleta(s)');
  });

  it('los servidores salen sin credenciales y con las variables resueltas, y fijan el protocolo', () => {
    const system = doc.nodes[0].description!;
    expect(system).toContain('https://mascotas.tienda.example.com/api/v3');
    expect(system).toContain('https://staging.tienda.example.com/api/v3');
    expect(system).not.toContain('secreto');
    expect(system).toContain('oauth2 (petstore_auth), apiKey (api_key)');
    expect(new Set(doc.interactions.map((i) => i.protocol))).toEqual(new Set(['REST (HTTPS)']));
    expect(warnings).toContain('1 URL de servidor con usuario y clave: se quitaron de las descripciones, pero el contrato conserva el texto original.');
  });

  it('cada grupo recibe una interacción desde el cliente implícito, con sus operaciones y los esquemas que alcanza', () => {
    expect(doc.nodes[1]).toMatchObject({ external: true, kind: 'system', name: 'Cliente de la API' });
    expect(doc.interactions.map((i) => [i.sourceId, i.targetId, i.style, i.dataObjects])).toEqual([
      ['cliente-de-la-api', 'pet', 'request-response', ['Pet', 'Category', 'Tag']],
      ['cliente-de-la-api', 'store', 'request-response', ['Order']],
      ['cliente-de-la-api', 'user', 'request-response', ['User']],
    ]);
    expect(doc.interactions[0].description).toBe('PUT /pet, POST /pet, GET /pet/findByStatus, GET /pet/{petId}, DELETE /pet/{petId}');
    expect(doc.interactions.every((i) => i.contractId === doc.contracts[0].id)).toBe(true);
  });

  it('avisa del cliente implícito y de nada más', () => {
    expect(warnings).toEqual([
      'OpenAPI no dice quién llama a la API: se añadió el sistema externo «Cliente de la API» con una interacción hacia cada grupo de operaciones.',
      '1 URL de servidor con usuario y clave: se quitaron de las descripciones, pero el contrato conserva el texto original.',
    ]);
  });

  it('pasa el esquema y el análisis del módulo sin errores', () => {
    expect(integrationDocumentSchema.safeParse(doc).success).toBe(true);
    expect(analyzeIntegration(doc).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('el JSON y el YAML del mismo contrato dan el mismo mapa; importar dos veces da lo mismo', () => {
    const asJson = JSON.stringify(parse(petstore));
    const fromJson = fromOpenApi(asJson).document;
    expect({ ...fromJson, contracts: [] }).toEqual({ ...doc, contracts: [] });
    expect(fromOpenApi(petstore)).toEqual({ document: doc, warnings });
  });

  it('sin tags agrupa por el primer segmento de la ruta que nombra algo (salta api, v2…)', () => {
    const { document, warnings: w } = fromOpenApi(pedidos);
    expect(document.workspace.name).toBe('API de pedidos');
    expect(document.nodes.filter((n) => n.kind === 'api').map((n) => [n.id, n.parentId, n.description])).toEqual([
      ['pedidos', 'api-de-pedidos', '3 operación(es)'],
      ['facturas', 'api-de-pedidos', '1 operación(es)'],
    ]);
    // los esquemas circulares (Pedido ↔ Factura, Pedido → Pedido) se listan una sola vez cada uno
    expect(document.interactions.find((i) => i.targetId === 'pedidos')!.dataObjects).toEqual(['Pedido', 'Linea', 'Factura']);
    expect(document.interactions.find((i) => i.targetId === 'facturas')!.protocol).toBe('REST');
    expect(w.some((x) => x.includes('/api/v2'))).toBe(false);
  });

  it('el nombre explícito manda sobre el título', () => {
    expect(fromOpenApi(petstore, { name: 'Mi catálogo' }).document.workspace.name).toBe('Mi catálogo');
  });

  it('Swagger 2.0 se importa con los servidores de host, basePath y schemes, y un aviso', () => {
    const swagger = 'swagger: "2.0"\ninfo: {title: Viejo, version: "1"}\nhost: api.viejo.example.com\nbasePath: /v1\nschemes: [https]\npaths:\n  /cosas:\n    get:\n      tags: [cosas]\n      responses:\n        "200": {description: ok, schema: {$ref: "#/definitions/Cosa"}}\ndefinitions:\n  Cosa: {type: object}\n';
    const { document, warnings: w } = fromOpenApi(swagger);
    expect(document.nodes[0]).toMatchObject({ technology: 'Swagger 2.0' });
    expect(document.nodes[0].description).toContain('https://api.viejo.example.com/v1');
    expect(document.interactions[0].dataObjects).toEqual(['Cosa']);
    expect(w[0]).toMatch(/Swagger 2\.0/);
  });
});

describe('OpenAPI: lo que no se importa se avisa', () => {
  const { warnings } = fromOpenApi(pedidos);

  it('webhooks, callbacks y $ref externos o rotos se cuentan, sin seguirlos', () => {
    expect(warnings).toEqual(
      expect.arrayContaining([
        '1 webhook(s) no se importan (la API que llama al cliente): siguen en el contrato.',
        '1 callback(s) no se importan (la API que llama al cliente): siguen en el contrato.',
        '1 referencia(s) «$ref» a otros archivos o URL no se siguen (por seguridad el importador no lee de la red ni del disco): https://ejemplo.invalid/errores.yaml#/Validacion.',
        '1 referencia(s) «$ref» apuntan a algo que no existe en el documento: #/components/responses/NoExiste.',
      ]),
    );
  });

  it('un $ref a un archivo local no lo lee nunca: solo lo cuenta', () => {
    const spec = { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: { tags: ['a'], responses: { '200': { $ref: '/etc/passwd' }, '201': { $ref: 'file:///etc/passwd#/x' }, '202': { $ref: '../secreto.yaml#/Y' } } } } } };
    const { warnings: w, document } = fromOpenApi(JSON.stringify(spec));
    expect(w.find((x) => x.includes('a otros archivos o URL'))).toContain('/etc/passwd');
    expect(JSON.stringify(document)).not.toContain('root:');
  });

  it('un ciclo de referencias entre sí (a → b → a) se corta con aviso y sin colgarse', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: { '/a': { get: { tags: ['a'], responses: { '200': { $ref: '#/components/responses/R1' } } } } },
      components: { responses: { R1: { $ref: '#/components/responses/R2' }, R2: { $ref: '#/components/responses/R1' } } },
    };
    const { warnings: w } = fromOpenApi(JSON.stringify(spec));
    expect(w.find((x) => x.includes('dan vueltas'))).toContain('#/components/responses/R1');
  });

  it('una ruta que no es un objeto se omite con aviso', () => {
    const spec = { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/malo': 'texto', '/bueno': { get: { responses: {} } } } };
    const { warnings: w, document } = fromOpenApi(JSON.stringify(spec));
    expect(w).toContain('1 ruta(s) de «paths» no son un objeto o su «$ref» no se pudo resolver: se omiten.');
    expect(idsOf(document)).toContain('bueno');
  });
});

describe('OpenAPI: entradas patológicas', () => {
  const fails = (text: string, message: RegExp): void => {
    expect(() => fromOpenApi(text)).toThrow(IntegrationImportError);
    expect(() => fromOpenApi(text)).toThrow(message);
  };

  it('vacío, solo espacios, tipo equivocado y JSON/YAML truncado o roto dan un error claro', () => {
    fails('', /está vacío/);
    fails('   \n  ', /está vacío/);
    fails('[1, 2]', /es una lista/);
    fails('"hola"', /un valor de tipo string/);
    fails('null', /vacío/);
    fails(pedidos.slice(0, 400), /no se puede leer \(línea \d+, columna \d+\)/);
    fails('openapi: 3.0.0\ninfo: [sin cerrar\n', /no se puede leer \(línea \d+/);
    fails('{"openapi": "3.0.0", ', /no se puede leer/);
  });

  it('un objeto que no es un OpenAPI, una versión ajena o un AsyncAPI explican por qué', () => {
    fails('{"a": 1}', /no declara «openapi»/);
    fails(asyncapi, /Es un contrato AsyncAPI: impórtalo con el formato «asyncapi»/);
    fails('{"openapi": "4.0.0", "paths": {}}', /«openapi: 4\.0\.0» no se admite/);
    fails('{"swagger": "1.2"}', /«swagger: 1\.2» no se admite/);
    fails('{"openapi": "3.0.0", "info": {"title": "T", "version": "1"}, "paths": {}}', /no declara ninguna operación/);
    fails('{"openapi": "3.1.0", "webhooks": {"x": {}}}', /Solo declara webhooks/);
  });

  it('un anidamiento enorme se rechaza sin agotar la pila', () => {
    fails(`{"openapi":"3.0.0","x":${'['.repeat(50_000)}${']'.repeat(50_000)}}`, /anidado|demasiado/);
    fails(`openapi: 3.0.0\nx: ${'['.repeat(20_000)}${']'.repeat(20_000)}\n`, /anidado|demasiado/);
  });

  it('un texto de más del tope se rechaza antes de analizarlo', () => {
    fails(`{"openapi":"3.0.0","x":"${'a'.repeat(33 * 1024 * 1024)}"}`, /demasiado grande/);
  });

  it('las «bombas» de alias de YAML no se expanden', () => {
    const lol = ['openapi: 3.0.0', 'a: &a [x, x, x, x, x, x, x, x, x, x]', ...'bcdefghi'.split('').map((k, i) => `${k}: &${k} [${Array(10).fill(`*${i === 0 ? 'a' : 'bcdefghi'[i - 1]}`).join(', ')}]`)].join('\n');
    expect(() => fromOpenApi(lol)).toThrow(IntegrationImportError);
  });

  it('10 000 rutas se importan en un tiempo razonable (agrupadas, sin recorridos cuadráticos)', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i += 1) paths[`/cosas/${i}`] = { get: { tags: [`t${i % 20}`], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/S' } } } } } } };
    const spec = { openapi: '3.0.0', info: { title: 'Grande', version: '1' }, paths, components: { schemas: { S: { type: 'object', properties: { yo: { $ref: '#/components/schemas/S' } } } } } };
    const started = Date.now();
    const { document } = fromOpenApi(JSON.stringify(spec));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(document.nodes.filter((n) => n.kind === 'api')).toHaveLength(20);
    expect(integrationDocumentSchema.safeParse(document).success).toBe(true);
  });
});
