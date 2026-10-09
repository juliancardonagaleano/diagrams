/**
 * Importador de OpenAPI (3.x, y 2.0 con aviso) para el módulo de integración. Acepta JSON o YAML y reconoce el formato por el
 * campo raíz `openapi` (o `swagger`). Nunca sigue un `$ref` a otro archivo o a una URL; los internos (`#/…`) se resuelven con
 * control de ciclos y de profundidad.
 *
 * El modelo de integración no tiene un tipo «operación»: sus nodos son sistemas, APIs, brokers… y lo que describe a fondo una API
 * es su contrato. Por eso el mapeo es este:
 *
 *   OpenAPI                                        → integración
 *   ---------------------------------------------------------------------------------------------------------------
 *   `info` (título, versión, descripción, contacto) → sistema «título» (el servicio que publica la API); `owner` = contacto
 *   operaciones (`paths`) agrupadas por la primera   → un nodo `api` por grupo, hijo del sistema (la tag, o el primer segmento
 *   tag de cada una                                   de la ruta si no tiene): su descripción cuenta las operaciones
 *   `servers` (o `host`/`basePath`/`schemes`)       → URL del servicio en la descripción del sistema y protocolo de las
 *                                                     interacciones (`REST (HTTPS)`); las credenciales de una URL se quitan
 *   esquemas alcanzados por las operaciones         → `dataObjects` de la interacción del grupo (`#/components/schemas/X`,
 *   (`#/components/schemas`, `#/definitions`)         también los que alcanzan a través de otros esquemas)
 *   `components.securitySchemes`                    → descripción del sistema (tipo de cada esquema)
 *   el documento entero                             → un contrato `openapi` con el texto original, enlazado a cada API
 *   (implícito) quien llama a la API                → sistema externo «Cliente de la API» con una interacción de
 *                                                     petición-respuesta hacia cada API (OpenAPI no dice quién la usa; se avisa)
 *
 * Lo que NO se importa y cómo se avisa: `webhooks` y `callbacks` (la API que llama al cliente), los `$ref` a otros archivos o
 * URL, los rotos o circulares, las rutas que no son un objeto y, sin aviso porque siguen en el contrato, el detalle de cada
 * operación (parámetros, cuerpos, respuestas, ejemplos), las extensiones `x-` y los enlaces (`links`).
 */
import { pickId, Warnings } from '@iark/kernel';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { INTEGRATION_DOCUMENT_VERSION, type Contract, type IntegrationNode, type Interaction } from '../types';
import { IntegrationImportError, type IntegrationImportOptions, type IntegrationImportResult } from './fromMermaid';
import { arr, brief, cleanUrl, fillVariables, readSpec, rec, reachableNames, RefResolver, refWarnings, shortList, slug, specKind, str, type Json } from './spec';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** Segmentos de ruta que no nombran nada (`/api/v2/pedidos`): se saltan para agrupar por la ruta. */
const GENERIC_SEGMENT = /^(?:api|rest|v\d+(?:\.\d+)*)$/i;
const SCHEMA_PREFIXES = ['#/components/schemas/', '#/definitions/'] as const;
/** Pasos máximos que se dedican en total a listar los esquemas de todas las operaciones (cota de tiempo). */
const SCHEMA_BUDGET = 2_000_000;
const MAX_SCHEMAS_PER_GROUP = 15;
const MAX_OPERATIONS = 50_000;

/** ¿El texto es un documento OpenAPI 3.x o Swagger 2.0? Mira solo el campo raíz, sin recorrer el resto. */
export function looksLikeOpenApi(text: string): boolean {
  const kind = specKind(text);
  return kind === 'openapi' || kind === 'swagger';
}

interface Operation {
  label: string;
  deprecated: boolean;
  /** Partes de la operación donde buscar esquemas: parámetros (de la ruta y propios), cuerpo y respuestas. */
  parts: unknown[];
}

interface Group {
  name: string;
  description?: string;
  operations: Operation[];
}

/** Primer segmento con nombre de una ruta (`/api/v1/mascotas/{id}` → `mascotas`). */
function segmentOf(route: string): string {
  const segment = route.split('/').find((s) => s !== '' && !s.startsWith('{') && !GENERIC_SEGMENT.test(s));
  return segment ?? 'raíz';
}

function serversOf(root: Json, swagger: boolean): { urls: string[]; withCredentials: number } {
  const raw: string[] = [];
  if (swagger) {
    const host = str(root.host);
    if (host) {
      const base = str(root.basePath) ?? '';
      const schemes = arr(root.schemes).map(str).filter((s): s is string => !!s);
      for (const scheme of schemes.length > 0 ? schemes : ['https']) raw.push(`${scheme}://${host}${base}`);
    }
  } else {
    for (const server of arr(root.servers).map(rec)) {
      const url = str(server?.url);
      if (url) raw.push(fillVariables(url, server?.variables));
    }
  }
  const urls = raw.map(cleanUrl);
  return { urls, withCredentials: raw.filter((url, i) => url !== urls[i] && url.length <= 200).length };
}

/** `REST (HTTPS)` si el primer servidor dice el esquema; `REST` si no. */
function protocolOf(servers: string[]): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(servers[0] ?? '')?.[1]?.toUpperCase();
  return scheme ? `REST (${scheme})` : 'REST';
}

function securityOf(root: Json): string[] {
  const schemes = rec(rec(root.components)?.securitySchemes) ?? rec(root.securityDefinitions);
  return Object.entries(schemes ?? {})
    .flatMap(([name, value]) => {
      const scheme = rec(value);
      const type = str(scheme?.type);
      return type ? [`${type === 'http' ? (str(scheme?.scheme) ?? 'http') : type} (${name})`] : [];
    })
    .slice(0, 6);
}

/**
 * Importa un OpenAPI como documento de integración (ver la cabecera de este archivo para el mapeo). Lanza
 * `IntegrationImportError` con un motivo de una línea si el texto no es un OpenAPI utilizable.
 */
export function fromOpenApi(source: string, options: IntegrationImportOptions = {}): IntegrationImportResult {
  const { root, text } = readSpec(source, 'OpenAPI');
  const version = str(root.openapi);
  const swagger = str(root.swagger);
  if (!version && !swagger) {
    const other = str(root.asyncapi) ? ' Es un contrato AsyncAPI: impórtalo con el formato «asyncapi».' : '';
    throw new IntegrationImportError(`El documento no declara «openapi» (p. ej. "3.0.3"), así que no es un OpenAPI.${other}`);
  }
  if (version && !/^3\.\d+/.test(version)) throw new IntegrationImportError(`La versión «openapi: ${version}» no se admite: se importa OpenAPI 3.x.`);
  if (!version && !/^2\./.test(swagger ?? '')) throw new IntegrationImportError(`La versión «swagger: ${swagger}» no se admite: se importa OpenAPI 3.x (y Swagger 2.0).`);

  const warnings = new Warnings();
  if (swagger) warnings.add(`Es un documento Swagger 2.0 (OpenAPI 2): se importa igual, con los servidores deducidos de host, basePath y schemes; para usar sus ventajas conviene migrarlo a OpenAPI 3.`);
  const resolver = new RefResolver(root);

  // ───────────── operaciones, agrupadas ─────────────
  const declaredTags = new Map<string, string | undefined>();
  for (const tag of arr(root.tags).map(rec)) {
    const name = str(tag?.name);
    if (name && !declaredTags.has(name)) declaredTags.set(name, brief(str(tag?.description)));
  }
  const groups = new Map<string, Group>();
  const group = (name: string): Group => {
    const found = groups.get(name);
    if (found) return found;
    const created: Group = { name, description: declaredTags.get(name), operations: [] };
    groups.set(name, created);
    return created;
  };
  for (const name of declaredTags.keys()) groups.set(name, { name, description: declaredTags.get(name), operations: [] });

  const paths = rec(root.paths) ?? {};
  let total = 0;
  let skippedPaths = 0;
  for (const [route, rawItem] of Object.entries(paths)) {
    const item = rec(resolver.resolve(rawItem));
    if (!item) {
      skippedPaths += 1;
      continue;
    }
    for (const method of METHODS) {
      const op = rec(item[method]);
      if (!op) continue;
      total += 1;
      if (total > MAX_OPERATIONS) throw new IntegrationImportError(`El OpenAPI tiene más de ${MAX_OPERATIONS} operaciones: demasiado grande para importarlo.`);
      const tag = arr(op.tags).map(str).find((t): t is string => !!t) ?? segmentOf(route);
      group(tag).operations.push({
        label: `${method.toUpperCase()} ${route}`,
        deprecated: op.deprecated === true,
        parts: [item.parameters, op.parameters, op.requestBody, op.responses],
      });
    }
  }
  const used = [...groups.values()].filter((g) => g.operations.length > 0);
  if (used.length === 0) {
    const hooks = rec(root.webhooks) ? ' Solo declara webhooks, que no se importan.' : '';
    throw new IntegrationImportError(`El OpenAPI no declara ninguna operación en «paths», así que no hay nada que importar.${hooks}`);
  }
  if (skippedPaths > 0) warnings.add(`${skippedPaths} ruta(s) de «paths» no son un objeto o su «$ref» no se pudo resolver: se omiten.`);

  // ───────────── nodos ─────────────
  const info = rec(root.info);
  const title = str(info?.title);
  if (!title) warnings.add('El OpenAPI no declara «info.title»: el sistema toma el nombre del archivo.');
  const name = options.name?.trim() || title || options.fallbackName?.trim() || 'API';
  const apiVersion = str(info?.version);
  const { urls: servers, withCredentials } = serversOf(root, !!swagger);
  const security = securityOf(root);
  const taken = new Set<string>();
  const systemId = pickId(slug(title ?? name) || 'api', taken);
  const consumerId = pickId('cliente-de-la-api', taken);
  const contractId = pickId(`${systemId}-openapi`, new Set());
  const owner = str(rec(info?.contact)?.name);

  const nodes: IntegrationNode[] = [
    {
      id: systemId,
      kind: 'system',
      name: title ?? name,
      description: [brief(str(info?.summary) ?? str(info?.description), 300), apiVersion ? `Versión ${apiVersion}` : undefined, servers.length > 0 ? `Servidores: ${shortList(servers, 4)}` : undefined, security.length > 0 ? `Seguridad: ${security.join(', ')}` : undefined]
        .filter(Boolean)
        .join(' · '),
      technology: version ? `OpenAPI ${version}` : `Swagger ${swagger}`,
      ...(owner ? { owner } : {}),
      tags: ['openapi'],
    },
    { id: consumerId, kind: 'system', name: 'Cliente de la API', description: 'Quien llama a la API. OpenAPI no dice quién la usa: reemplázalo por los sistemas reales.', external: true, tags: ['implícito'] },
  ];
  const interactions: Interaction[] = [];
  const interactionIds = new Set<string>();
  const protocol = protocolOf(servers);
  const state = { visited: new Set<string>(), budget: SCHEMA_BUDGET };
  let truncated = 0;
  for (const g of used) {
    const apiId = pickId(slug(g.name) || 'api', taken);
    const deprecated = g.operations.filter((o) => o.deprecated).length;
    nodes.push({
      id: apiId,
      kind: 'api',
      name: g.name,
      description: [g.description, `${g.operations.length} operación(es)`, deprecated > 0 ? `${deprecated} obsoleta(s)` : undefined].filter(Boolean).join(' · '),
      technology: 'REST',
      parentId: systemId,
      ...(owner ? { owner } : {}),
      contractId,
    });
    state.visited = new Set();
    const schemas = reachableNames(resolver, g.operations.flatMap((o) => o.parts), SCHEMA_PREFIXES, state, MAX_SCHEMAS_PER_GROUP + 1);
    if (schemas.length > MAX_SCHEMAS_PER_GROUP) truncated += 1;
    const dataObjects = schemas.slice(0, MAX_SCHEMAS_PER_GROUP);
    interactions.push({
      id: pickId(`${consumerId}--${apiId}`, interactionIds),
      sourceId: consumerId,
      targetId: apiId,
      style: 'request-response',
      protocol,
      contractId,
      description: shortList(g.operations.map((o) => o.label), 6),
      ...(dataObjects.length > 0 ? { dataObjects } : {}),
    });
  }
  if (state.budget <= 0) warnings.add('El OpenAPI es tan grande que no se listaron todos los esquemas que usa cada API (siguen completos en el contrato).');
  if (truncated > 0) warnings.add(`${truncated} grupo(s) de operaciones usan más de ${MAX_SCHEMAS_PER_GROUP} esquemas: se listan los primeros ${MAX_SCHEMAS_PER_GROUP} en la interacción (el resto sigue en el contrato).`);

  // ───────────── avisos de lo que no se importa ─────────────
  warnings.add('OpenAPI no dice quién llama a la API: se añadió el sistema externo «Cliente de la API» con una interacción hacia cada grupo de operaciones.');
  const webhooks = Object.keys(rec(root.webhooks) ?? {}).length;
  if (webhooks > 0) warnings.add(`${webhooks} webhook(s) no se importan (la API que llama al cliente): siguen en el contrato.`);
  const callbacks = countCallbacks(paths);
  if (callbacks > 0) warnings.add(`${callbacks} callback(s) no se importan (la API que llama al cliente): siguen en el contrato.`);
  if (withCredentials > 0) warnings.add(`${withCredentials} URL de servidor con usuario y clave: se quitaron de las descripciones, pero el contrato conserva el texto original.`);
  for (const w of refWarnings(resolver.report())) warnings.add(w);

  const contract: Contract = {
    id: contractId,
    name: `${title ?? name} (${version ? `OpenAPI ${version}` : `Swagger ${swagger}`})`,
    format: 'openapi',
    ...(apiVersion ? { version: apiVersion } : {}),
    ...(brief(str(info?.description), 300) ? { description: brief(str(info?.description), 300) } : {}),
    content: text,
  };
  const result = validateIntegrationDocument({
    version: INTEGRATION_DOCUMENT_VERSION,
    workspace: { name },
    nodes,
    contracts: [contract],
    interactions,
    flows: [],
  });
  if (!result.ok) throw new IntegrationImportError(`No se pudo construir un documento válido a partir de OpenAPI:\n${formatIntegrationIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}

/** Cuenta los `callbacks` de las operaciones (OpenAPI 3): peticiones que la API hace a quien la usa. */
function countCallbacks(paths: Json): number {
  let count = 0;
  for (const raw of Object.values(paths)) {
    const item = rec(raw);
    if (!item) continue;
    for (const method of METHODS) count += Object.keys(rec(rec(item[method])?.callbacks) ?? {}).length;
  }
  return count;
}
