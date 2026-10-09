import { readFileSync } from 'node:fs';
import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { analyzeIntegration } from '../issues';
import { integrationModule } from '../module';
import { integrationDocumentSchema } from '../schema';
import { fromAsyncApi, looksLikeAsyncApi } from './fromAsyncApi';
import { IntegrationImportError } from './fromMermaid';

const FIXTURES = 'tests/fixtures/importar/asyncapi';
const streetlights = readFileSync(`${FIXTURES}/streetlights-v2.yaml`, 'utf8');
const pagos = readFileSync(`${FIXTURES}/pagos-v3.yaml`, 'utf8');
const openapi = readFileSync('tests/fixtures/importar/openapi/petstore.yaml', 'utf8');
const registry = new ModuleRegistry().register(integrationModule);

describe('AsyncAPI: detect', () => {
  it('reconoce AsyncAPI 2.x y 3.x en YAML y en JSON', () => {
    expect(looksLikeAsyncApi(streetlights)).toBe(true);
    expect(looksLikeAsyncApi(pagos)).toBe(true);
    expect(looksLikeAsyncApi('{"info":{},"channels":{},"asyncapi":"2.0.0"}')).toBe(true);
    expect(looksLikeAsyncApi("asyncapi: '3.0.0' # comentario\n")).toBe(true);
  });

  it('no se confunde con OpenAPI, con JSON o YAML cualquiera ni con documentos de la suite', () => {
    expect(looksLikeAsyncApi(openapi)).toBe(false);
    expect(looksLikeAsyncApi('{"openapi":"3.0.0"}')).toBe(false);
    expect(looksLikeAsyncApi('{"asyncapi":"1.2.0"}')).toBe(false);
    expect(looksLikeAsyncApi('{"x":{"asyncapi":"2.0.0"}}')).toBe(false);
    expect(looksLikeAsyncApi('a: 1\n')).toBe(false);
    expect(looksLikeAsyncApi('[]')).toBe(false);
    expect(looksLikeAsyncApi('')).toBe(false);
    expect(looksLikeAsyncApi(readFileSync('examples/pedidos-integracion.json', 'utf8'))).toBe(false);
  });
});

describe('AsyncAPI 2.x: mapeo', () => {
  const { document: doc, warnings } = fromAsyncApi(streetlights);

  it('la aplicación es un sistema, cada servidor un broker y cada canal un tema (o una cola) dentro de un broker', () => {
    expect(doc.workspace.name).toBe('API de farolas inteligentes');
    expect(doc.nodes.map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ['api-de-farolas-inteligentes', 'system', undefined],
      ['production', 'broker', undefined],
      ['pruebas', 'broker', undefined],
      ['ciudad-farolas-1-0-evento-farolaid-luz-medida', 'topic', 'production'],
      ['ciudad-farolas-1-0-accion-farolaid-encender', 'topic', 'production'],
      ['ciudad-farolas-1-0-accion-farolaid-atenuar', 'topic', 'production'],
      ['ciudad-farolas-1-0-incidencias', 'queue', 'production'],
    ]);
    expect(doc.nodes[0]).toMatchObject({ technology: 'AsyncAPI 2.6.0', owner: 'Equipo de Alumbrado', tags: ['asyncapi'] });
    expect(doc.nodes[0].description).toContain('Versión 1.0.0');
  });

  it('los brokers llevan el protocolo y la dirección con las variables resueltas y sin credenciales', () => {
    const production = doc.nodes.find((n) => n.id === 'production')!;
    const pruebas = doc.nodes.find((n) => n.id === 'pruebas')!;
    expect(production).toMatchObject({ technology: 'MQTT 3.1.1', description: 'Broker MQTT de producción · mqtt://broker.ciudad.example.com:8883' });
    expect(pruebas.description).toBe('Broker de pruebas · mqtt://pruebas.ciudad.example.com:1883');
    expect(JSON.stringify(doc.nodes)).not.toContain('clave-de-prueba');
  });

  it('en 2.x «publish» es lo que la aplicación consume y «subscribe» lo que publica', () => {
    expect(doc.interactions.map((i) => [i.sourceId, i.targetId, i.style, i.dataObjects])).toEqual([
      ['ciudad-farolas-1-0-evento-farolaid-luz-medida', 'api-de-farolas-inteligentes', 'async-message', ['MedidaDeLuz']],
      ['api-de-farolas-inteligentes', 'ciudad-farolas-1-0-accion-farolaid-encender', 'async-message', ['OrdenEncender']],
      ['api-de-farolas-inteligentes', 'ciudad-farolas-1-0-accion-farolaid-atenuar', 'async-message', ['OrdenAtenuar', 'OrdenEncender']],
      ['ciudad-farolas-1-0-incidencias', 'api-de-farolas-inteligentes', 'async-message', ['incidencia']],
    ]);
    expect(doc.interactions.every((i) => i.protocol === 'MQTT' && i.contractId === doc.contracts[0].id)).toBe(true);
    expect(doc.interactions[0].description).toBe('alRecibirMedida: Informa de las condiciones de luz de una farola.');
  });

  it('un único contrato asyncapi con el texto original, enlazado a los canales', () => {
    expect(doc.contracts).toHaveLength(1);
    expect(doc.contracts[0]).toMatchObject({ format: 'asyncapi', version: '1.0.0', content: streetlights });
    for (const channel of doc.nodes.filter((n) => n.kind === 'topic' || n.kind === 'queue')) expect(channel.contractId).toBe(doc.contracts[0].id);
  });

  it('avisa de lo que no importa y de nada más', () => {
    expect(warnings).toEqual([
      '3 canal(es) no dicen en qué servidor están y hay 2 servidores: se colocan en el primero («production»).',
      'AsyncAPI describe solo a esta aplicación: quien consume lo que publica y quien publica lo que consume (4 canal(es)) no está en el contrato, así que la validación del módulo avisará de canales sin productor o sin consumidor.',
      'No se importa el detalle por protocolo de servidores, canales y operaciones, que sigue completo en el contrato: bindings (1), traits (1), seguridad (1).',
    ]);
  });

  it('pasa el esquema y el análisis del módulo sin errores (los avisos del análisis son los canales de un solo lado)', () => {
    expect(integrationDocumentSchema.safeParse(doc).success).toBe(true);
    const issues = analyzeIntegration(doc);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map((i) => i.message)).toContain('Broker «pruebas» no participa en ninguna interacción.');
  });

  it('el JSON y el YAML del mismo contrato dan el mismo mapa; importar dos veces da lo mismo', () => {
    const fromJson = fromAsyncApi(JSON.stringify(parse(streetlights))).document;
    expect({ ...fromJson, contracts: [] }).toEqual({ ...doc, contracts: [] });
    expect(fromAsyncApi(streetlights)).toEqual({ document: doc, warnings });
  });
});

describe('AsyncAPI 3.x: mapeo', () => {
  const { document: doc, warnings } = fromAsyncApi(pagos);

  it('los canales toman su «address» como nombre y se colocan en el servidor que declaran', () => {
    expect(doc.nodes.map((n) => [n.id, n.kind, n.name, n.parentId])).toEqual([
      ['servicio-de-pagos', 'system', 'Servicio de pagos', undefined],
      ['kafka-produccion', 'broker', 'kafka-produccion', undefined],
      ['kafka-dr', 'broker', 'kafka-dr', undefined],
      ['pagos-cobro-solicitado', 'topic', 'pagos.cobro.solicitado', 'kafka-produccion'],
      ['pagos-cobro-resuelto', 'topic', 'pagos.cobro.resuelto', 'kafka-produccion'],
      ['notificaciones', 'topic', 'notificaciones', 'kafka-produccion'],
    ]);
    expect(doc.nodes.find((n) => n.id === 'kafka-produccion')).toMatchObject({ technology: 'Kafka (TLS)', description: 'Clúster de Kafka de producción · kafka-secure://kafka.pagos.example.com:9093' });
    expect(doc.nodes.find((n) => n.id === 'pagos-cobro-solicitado')!.description).toBe('Solicitudes de cobro que llegan de pedidos. · Canal «cobroSolicitado»');
  });

  it('«receive» es lo que la aplicación consume y «send» lo que publica; los mensajes salen con su nombre', () => {
    expect(doc.interactions.map((i) => [i.sourceId, i.targetId, i.dataObjects])).toEqual([
      ['pagos-cobro-solicitado', 'servicio-de-pagos', ['SolicitudCobro']],
      ['servicio-de-pagos', 'pagos-cobro-resuelto', ['CobroAceptado', 'Cobro rechazado']],
      ['servicio-de-pagos', 'notificaciones', undefined],
    ]);
    expect(doc.interactions.every((i) => i.protocol === 'Kafka (TLS)')).toBe(true);
  });

  it('avisa de la operación huérfana, del «reply», de los bindings y de los canales de un solo lado', () => {
    expect(warnings).toEqual([
      '2 canal(es) no dicen en qué servidor están y hay 2 servidores: se colocan en el primero («kafka-produccion»).',
      '1 operación(es) apuntan a un canal que no existe o no declaran «action» válida (send o receive): se omiten.',
      'AsyncAPI describe solo a esta aplicación: quien consume lo que publica y quien publica lo que consume (3 canal(es)) no está en el contrato, así que la validación del módulo avisará de canales sin productor o sin consumidor.',
      '1 operación(es) declaran «reply» (petición-respuesta): solo se importa el mensaje de ida.',
      'No se importa el detalle por protocolo de servidores, canales y operaciones, que sigue completo en el contrato: bindings (1).',
    ]);
  });

  it('la referencia rota se conserva en el contrato y la validación del módulo la señala', () => {
    expect(integrationDocumentSchema.safeParse(doc).success).toBe(true);
    const messages = analyzeIntegration(doc).map((i) => i.message);
    expect(messages.some((m) => m.includes('#/channels/noExiste'))).toBe(true);
  });
});

describe('AsyncAPI: casos pequeños', () => {
  const minimal = (extra: string): string => `asyncapi: 3.0.0\ninfo:\n  title: Mínimo\n  version: '1'\n${extra}`;

  it('un canal AMQP de tipo cola o un servidor SQS dan una cola', () => {
    const sqs = fromAsyncApi(minimal("servers:\n  aws:\n    host: sqs.eu-west-1.amazonaws.com\n    protocol: sqs\nchannels:\n  pedidos:\n    address: pedidos\n")).document;
    expect(sqs.nodes.find((n) => n.id === 'pedidos')).toMatchObject({ kind: 'queue', parentId: 'aws' });
    const amqp = fromAsyncApi(minimal("channels:\n  pedidos:\n    address: pedidos\n    bindings:\n      amqp:\n        is: queue\n")).document;
    expect(amqp.nodes.find((n) => n.id === 'pedidos')).toMatchObject({ kind: 'queue' });
    expect(amqp.nodes.find((n) => n.id === 'pedidos')!.parentId).toBeUndefined();
  });

  it('sin operaciones importa los canales y avisa de que no sabe quién publica o consume', () => {
    const { document, warnings } = fromAsyncApi(minimal('channels:\n  a:\n    address: a\n'));
    expect(document.interactions).toEqual([]);
    expect(warnings.some((w) => w.includes('no declara operaciones'))).toBe(true);
  });

  it('sin título usa el nombre del archivo y lo dice', () => {
    const { document, warnings } = fromAsyncApi('asyncapi: 2.6.0\nchannels:\n  a: {}\n', { fallbackName: 'eventos' });
    expect(document.workspace.name).toBe('eventos');
    expect(warnings[0]).toContain('no declara «info.title»');
  });

  it('un $ref a otro archivo o a una URL no se sigue y se avisa; uno circular no se cuelga', () => {
    const text = [
      'asyncapi: 2.6.0',
      'info: {title: Refs, version: "1"}',
      'channels:',
      '  a:',
      '    publish:',
      '      message:',
      "        $ref: 'https://ejemplo.invalid/mensajes.yaml#/Uno'",
      '  b:',
      '    subscribe:',
      '      message:',
      "        $ref: './local.yaml#/Dos'",
      '  c:',
      '    publish:',
      '      message:',
      "        $ref: '#/components/messages/x'",
      'components:',
      '  messages:',
      "    x: {$ref: '#/components/messages/y'}",
      "    y: {$ref: '#/components/messages/x'}",
      '',
    ].join('\n');
    const { document, warnings } = fromAsyncApi(text);
    expect(document.nodes.filter((n) => n.kind === 'topic')).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/a otros archivos o URL no se siguen/);
    expect(warnings.join('\n')).toMatch(/dan vueltas sobre sí mismas/);
  });
});

describe('AsyncAPI: entradas patológicas', () => {
  const fails = (text: string, message: RegExp): void => {
    expect(() => fromAsyncApi(text)).toThrow(IntegrationImportError);
    expect(() => fromAsyncApi(text)).toThrow(message);
  };

  it('vacío, en blanco, lista, cadena o nulo dan un motivo claro', () => {
    fails('', /vacío/);
    fails('   \n\t', /vacío/);
    fails('[1, 2]', /lista/);
    fails('"hola"', /tipo string/);
    fails('null', /vacío/);
  });

  it('JSON o YAML truncado se señala con línea y columna', () => {
    fails('{"asyncapi":"2.6.0","channels":{"a":', /no se puede leer \(línea \d+, columna \d+\)/);
    fails('asyncapi: 2.6.0\nchannels:\n  a: [1, 2\n', /no se puede leer \(línea \d+, columna \d+\)/);
  });

  it('versión ausente o no admitida, o un OpenAPI, dan un motivo claro', () => {
    fails('info: {title: x}\nchannels: {a: {}}\n', /no declara «asyncapi»/);
    fails('asyncapi: 1.2.0\nchannels: {a: {}}\n', /no se admite/);
    fails('openapi: 3.0.0\ninfo: {title: x}\n', /Es un contrato OpenAPI/);
  });

  it('sin canales no hay nada que importar', () => {
    fails('asyncapi: 2.6.0\ninfo: {title: x}\n', /ningún canal/);
    fails('asyncapi: 3.0.0\nchannels: {}\n', /ningún canal/);
  });

  it('un anidamiento enorme se rechaza sin agotar la pila', () => {
    fails(`{"asyncapi":"2.6.0","x":${'['.repeat(50_000)}${']'.repeat(50_000)}}`, /anidado|demasiado/);
    fails(`asyncapi: 2.6.0\nx: ${'['.repeat(20_000)}${']'.repeat(20_000)}\n`, /anidado|demasiado/);
  });

  it('un texto de más de 32 MiB se rechaza sin analizarlo', () => {
    fails(`asyncapi: 2.6.0\nx: ${'a'.repeat(33 * 1024 * 1024)}\n`, /demasiado grande/);
  });

  it('una bomba de alias YAML no se expande', () => {
    const levels = Array.from({ length: 12 }, (_, i) => `l${i + 1}: &l${i + 1} [${i === 0 ? '"x"' : `*l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}`}]`);
    const text = `asyncapi: 2.6.0\nchannels: {a: {}}\n${levels.join('\n')}\n`;
    const started = Date.now();
    expect(() => fromAsyncApi(text)).toThrow(IntegrationImportError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('diez mil canales se importan en tiempo lineal', () => {
    const channels = Array.from({ length: 10_000 }, (_, i) => `  canal-${i}:\n    publish:\n      message:\n        name: M${i}`).join('\n');
    const started = Date.now();
    const { document } = fromAsyncApi(`asyncapi: 2.6.0\ninfo: {title: Grande, version: "1"}\nchannels:\n${channels}\n`);
    expect(document.nodes.filter((n) => n.kind === 'topic')).toHaveLength(10_000);
    expect(document.interactions).toHaveLength(10_000);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
