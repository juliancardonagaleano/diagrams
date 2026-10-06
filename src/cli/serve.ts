import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  analyzeText,
  buildTraceGraph,
  commandInfos,
  diffDocuments,
  exportDocument,
  exportFormats,
  importText,
  moduleCapabilities,
  runCommand,
  traceMermaid,
  traceReach,
  traceReachReport,
  traceReport,
  traceSvg,
  viewChoices,
  type AnyModule,
  type ModuleRegistry,
  type ProjectStore,
  type TraceDirection,
  type TraceInput,
} from '@iark/kernel';
import { createAuthApi } from './accounts/routes';
import type { Accounts } from './accounts/service';
import { HttpError } from './httpError';
import { createAuthenticator, type FailureLimiterOptions } from './serveAuth';
import { createProjectsApi } from './serveProjects';
import { suiteManifest } from './suiteManifest';
import type { TokenStore } from './tokens';

/**
 * Servicio HTTP de la suite (`iark serve`): la misma API para todos los módulos, construida sobre las operaciones del
 * contrato de módulo (validar, vistas, exportar, importar, informes), más el manifiesto de federación y, si se indica,
 * el sitio estático (la app, el banco de trabajo y el shell). Sin dependencias: `node:http`.
 *
 *   GET  /.well-known/iark.json                 manifiesto de esta instancia (iark.manifest/1, con `api`)
 *   GET  /api/modules                           módulos y sus capacidades
 *   GET  /api/<módulo>/capabilities             formatos, informes y vistas de traza del módulo
 *   GET  /api/<módulo>/schema[?kind=generation] JSON Schema del documento (o de la salida de IA)
 *   POST /api/<módulo>/validate                 cuerpo: documento JSON → { valid, schemaIssues, issues }
 *   POST /api/<módulo>/views                    cuerpo: documento JSON → vistas y vistas de traza
 *   POST /api/<módulo>/export?format=svg&view=  cuerpo: documento JSON → el archivo exportado
 *   POST /api/<módulo>/import?importer=&name=   cuerpo: texto (Mermaid…) → { document, warnings, importer }
 *   POST /api/<módulo>/run/<comando>            cuerpo: { input?, args?, options? } → { output, warnings, kind }
 *   POST /api/<módulo>/diff                     cuerpo: { before, after } (dos documentos del módulo) → DocumentDiff: qué se añadió, quitó y modificó
 *   POST /api/trace                             cuerpo: { documents: [{ module, document }], from?, direction?, depth? } → { graph, from?, reached?, report, mermaid, svg }
 *
 * Con un espacio de trabajo (`--workspace <carpeta>`), además, los proyectos guardados en esa carpeta (ver `serveProjects.ts`;
 * sin él, estas rutas responden 404). Los que modifican exigen `Content-Type: application/json` y rechazan los orígenes ajenos:
 *   GET|POST /api/projects                              lista los proyectos · crea uno { name, description? }
 *   GET|PATCH|DELETE /api/projects/<p>                  resumen · renombra { name } · borra
 *   POST /api/projects/<p>/diagrams                     crea un diagrama { module, name?, text }
 *   GET|PUT|PATCH|DELETE /api/projects/<p>/diagrams/<d> documento · guarda { text, ifUpdatedAt? } · renombra { name } · borra
 *   GET  /api/projects/<p>/bundle                       el proyecto en un solo archivo (iark.project/1)
 *   POST /api/projects/import[?name=]                   cuerpo: ese archivo → crea un proyecto nuevo
 *   GET  /api/projects/<p>/check                        comprobación del proyecto: cada diagrama y las referencias entre ellos
 *
 * Con tokens (`--tokens <archivo>`, ver `serveAuth.ts`) esas rutas y `/api/whoami` exigen `Authorization: Bearer <token>` y aplican los
 * roles `viewer`, `editor` y `admin`; el resto de la API sigue siendo pública (no toca el disco):
 *   GET  /api/whoami                                    { auth: true, name, role } con tokens (401 sin uno válido) · { auth: false } sin ellos
 *
 * Con cuentas (`--accounts <archivo>` y una OAuth App de GitHub, ver `accounts/`) la sesión de una persona sirve igual que un token, pero su
 * rol sale de a qué proyectos pertenece, y `/api/auth` ofrece el inicio de sesión (ver `accounts/routes.ts`):
 *   GET  /api/auth/providers                            público: formas de entrar que ofrece la instancia
 *   GET  /api/auth/github/login · /callback             el flujo de GitHub (redirecciones)
 *   POST /api/auth/exchange · /logout                   cambia el código por una sesión · la cierra
 *   GET  /api/whoami                                    con una sesión: { auth: true, name, role: <rol en la instancia>, user }
 */
export interface ServeOptions {
  registry: ModuleRegistry;
  version: string;
  /** Carpeta del sitio compilado (`dist/app`) para servirlo junto a la API. */
  staticDir?: string;
  /** Orígenes autorizados a llamar a la API desde un navegador (`*` o una lista). Por defecto, ninguno (mismo origen). */
  cors?: string[];
  /** Tamaño máximo del cuerpo de una petición (bytes). Por defecto 5 MB. */
  maxBodyBytes?: number;
  /** Espacio de trabajo con los proyectos (`FolderProjectStore`). Sin él, `/api/projects` responde 404. */
  projects?: ProjectStore;
  /** Los tokens de acceso (`--tokens`). Con ellos, `/api/projects…` y `/api/whoami` exigen un token y respetan su rol; sin ellos, no hay autenticación. */
  tokens?: TokenStore;
  /** Las cuentas de GitHub (`--accounts`): con ellas, las sesiones de las personas valen como credencial y `/api/auth` ofrece el inicio de sesión. */
  accounts?: Accounts;
  /** Hay un proxy de confianza delante (`--trust-proxy`): el freno de intentos fallidos distingue a quien llama por `X-Forwarded-For` y no por la dirección del proxy. */
  trustProxy?: boolean;
  /** Ajustes del freno de intentos fallidos (los de por omisión, salvo en las pruebas). */
  authLimits?: Partial<FailureLimiterOptions>;
}

const API = '/api';
const MANIFEST_PATH = '/.well-known/iark.json';

/** Las rutas que exigen token cuando lo hay: la API de proyectos, `/api/whoami` y `/api/auth` (se leen los segmentos igual que `api()`, ya decodificados). */
function isAuthRoute(pathname: string): boolean {
  if (pathname !== API && !pathname.startsWith(`${API}/`)) return false;
  const parts = pathname.slice(API.length).split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment; // la petición se rechazará con 400 más adelante
    }
  });
  return parts[0] === 'projects' || parts[0] === 'auth' || (parts[0] === 'whoami' && parts.length === 1);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Un segmento de ruta decodificado; una codificación rota (`%zz`) es un error de la petición, no del servicio. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'La ruta está mal codificada.');
  }
}

/** Un `TypeError`/`RangeError`/`ReferenceError` es un fallo del programa; el resto, un problema de la petición. */
const isBug = (error: unknown): boolean => error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError;

export function createSuiteServer(options: ServeOptions): Server {
  const maxBody = options.maxBodyBytes ?? 5 * 1024 * 1024;
  const staticRoot = options.staticDir ? resolve(options.staticDir) : undefined;
  const cors = options.cors ?? [];
  const auth = options.tokens || options.accounts ? createAuthenticator({ tokens: options.tokens, accounts: options.accounts, trustProxy: options.trustProxy, limits: options.authLimits }) : undefined;

  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void =>
    send(res, status, `${JSON.stringify(value, null, 2)}\n`, { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  function applyCors(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const origin = req.headers.origin;
    if (!origin || cors.length === 0) return;
    if (cors.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (cors.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else return;
    if (auth && isAuthRoute(pathname)) {
      // Con tokens, un `*` también vale para la API de proyectos y todos los métodos: la credencial es una cabecera que el navegador
      // no añade por su cuenta (no se envían cookies: no se anuncia `Allow-Credentials`), así que un sitio ajeno no puede usar
      // la API sin un token que alguien le haya dado, y sin token recibe 401. Se anuncia `Authorization` (sin él el preflight falla)
      // y se exponen las cabeceras que el cliente necesita leer (`Retry-After` del 429, el nombre del archivo del proyecto).
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition, Location');
    } else {
      // Sin tokens, PUT, PATCH y DELETE (la API de proyectos) solo para los orígenes que se autorizaron por su nombre: un `*` no abre el disco.
      res.setHeader('Access-Control-Allow-Methods', options.projects && cors.includes(origin) ? 'GET, POST, PUT, PATCH, DELETE, OPTIONS' : 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBody) {
          chunks.length = 0;
          reject(new HttpError(413, `El cuerpo de la petición supera el máximo de ${maxBody} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const projectsApi = createProjectsApi({ store: options.projects, registry: options.registry, cors, auth, accounts: options.accounts, readBody, send, sendJson });
  const authApi = createAuthApi({ accounts: options.accounts, auth, tokens: !!options.tokens, trustProxy: options.trustProxy ?? false, readBody, send, sendJson });

  const requireMethod = (req: IncomingMessage, allowed: 'GET' | 'POST'): void => {
    if (req.method !== allowed) throw new HttpError(405, `Este endpoint solo admite ${allowed}.`, { allow: allowed });
  };

  function moduleOf(id: string): AnyModule {
    const module = options.registry.get(id);
    if (!module) throw new HttpError(404, `No existe el módulo «${id}». Módulos: ${options.registry.ids().join(', ')}.`);
    return module;
  }

  /** El cuerpo como documento del módulo: 422 con las incidencias si no lo es. */
  function documentOf(module: AnyModule, body: string): unknown {
    const analysis = analyzeText(module, body);
    if (analysis.status === 'ok') return analysis.document;
    if (analysis.status === 'empty') throw new HttpError(400, 'Falta el documento en el cuerpo de la petición.');
    if (analysis.status === 'syntax') throw new HttpError(400, `El cuerpo no es JSON válido: ${analysis.error}`);
    throw new HttpError(422, 'El documento no cumple el esquema del módulo.', { issues: analysis.issues });
  }

  /** Compara dos versiones de un documento del módulo: cada una, validada con su esquema (422 si no lo cumple, diciendo cuál). */
  function compare(module: AnyModule, raw: string): unknown {
    let body: { before?: unknown; after?: unknown } | null;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'El cuerpo debe ser JSON: { "before": {…}, "after": {…} } (las dos versiones del documento del módulo).');
    }
    const side = (name: 'before' | 'after'): unknown => {
      const value = body && typeof body === 'object' ? body[name] : undefined;
      if (value === undefined || value === null) throw new HttpError(400, `Falta "${name}": la ${name === 'before' ? 'versión anterior' : 'versión nueva'} del documento.`);
      try {
        return documentOf(module, typeof value === 'string' ? value : JSON.stringify(value));
      } catch (error) {
        if (error instanceof HttpError) throw new HttpError(error.status, `«${name}»: ${error.message}`, error.extra);
        throw error;
      }
    };
    return diffDocuments(side('before'), side('after'), module.diff);
  }

  /** Trazabilidad entre módulos: reúne los documentos aportados y sigue sus referencias URN. */
  async function trace(raw: string): Promise<unknown> {
    let body: { documents?: unknown; from?: unknown; direction?: unknown; depth?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'El cuerpo debe ser JSON: { "documents": [{ "module": "…", "document": {…} }], "from"?: "urn:iark:…" }.');
    }
    if (!Array.isArray(body.documents) || body.documents.length === 0) throw new HttpError(400, 'Falta "documents": la lista de documentos { module, document } a reunir.');
    const inputs: TraceInput[] = body.documents.map((entry: { module?: unknown; document?: unknown; source?: unknown }, index: number) => {
      if (!entry || typeof entry.module !== 'string') throw new HttpError(400, `documents[${index}] necesita "module".`);
      const module = moduleOf(entry.module);
      const document = documentOf(module, typeof entry.document === 'string' ? entry.document : JSON.stringify(entry.document ?? null));
      return { module, document, source: typeof entry.source === 'string' ? entry.source : undefined };
    });
    const direction = (body.direction ?? 'both') as TraceDirection;
    if (!['refs', 'referrers', 'both'].includes(direction)) throw new HttpError(400, 'direction debe ser refs, referrers o both.');
    try {
      const graph = buildTraceGraph(inputs);
      const reached = typeof body.from === 'string' ? traceReach(graph, body.from, { direction, depth: typeof body.depth === 'number' ? body.depth : undefined }) : undefined;
      return {
        graph,
        ...(reached ? { from: reached[0].node.urn, reached } : {}),
        report: reached ? traceReachReport(reached, direction) : traceReport(graph),
        mermaid: traceMermaid(graph, reached ? new Set(reached.map((r) => r.node.urn)) : undefined),
        svg: await traceSvg(graph, { reached }),
      };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.slice(API.length).split('/').filter(Boolean).map(decodeSegment);
    if (parts[0] === 'projects') return projectsApi(req, res, url, parts.slice(1));
    if (parts[0] === 'auth') return authApi(req, res, url, parts.slice(1));
    if (parts.length === 1 && parts[0] === 'whoami') {
      requireMethod(req, 'GET');
      if (!auth) return sendJson(res, 200, { auth: false });
      const who = auth.identify(req);
      if (who.kind === 'token') return sendJson(res, 200, { auth: true, name: who.name, role: who.role });
      return sendJson(res, 200, { auth: true, name: who.user.name ?? who.user.login, role: who.siteRole, user: who.user });
    }
    if (parts.length === 1 && parts[0] === 'modules') {
      requireMethod(req, 'GET');
      return sendJson(res, 200, options.registry.list().map(moduleCapabilities));
    }
    if (parts.length === 1 && parts[0] === 'trace') {
      requireMethod(req, 'POST');
      return sendJson(res, 200, await trace(await readBody(req)));
    }
    const [id, action, command] = parts;
    if (!id || !action) throw new HttpError(404, 'Ruta de la API desconocida. Ver /api/modules.');
    const module = moduleOf(id);

    switch (action) {
      case 'capabilities':
        requireMethod(req, 'GET');
        return sendJson(res, 200, moduleCapabilities(module));
      case 'schema': {
        requireMethod(req, 'GET');
        const kind = url.searchParams.get('kind') ?? 'document';
        if (kind === 'document') return sendJson(res, 200, module.jsonSchema());
        if (kind === 'generation' && module.ai) return sendJson(res, 200, module.ai.generationJsonSchema());
        throw new HttpError(400, `kind debe ser «document»${module.ai ? ' o «generation»' : ''}.`);
      }
      case 'validate': {
        requireMethod(req, 'POST');
        const analysis = analyzeText(module, await readBody(req));
        if (analysis.status === 'empty') throw new HttpError(400, 'Falta el documento en el cuerpo de la petición.');
        return sendJson(res, 200, {
          module: module.id,
          valid: analysis.status === 'ok',
          schemaIssues: analysis.status === 'syntax' ? [{ path: '(raíz)', message: analysis.error }] : analysis.status === 'schema' ? analysis.issues : [],
          issues: analysis.status === 'ok' ? analysis.issues : [],
        });
      }
      case 'views': {
        requireMethod(req, 'POST');
        return sendJson(res, 200, viewChoices(module, documentOf(module, await readBody(req))));
      }
      case 'export': {
        requireMethod(req, 'POST');
        const format = url.searchParams.get('format') ?? 'json';
        const document = documentOf(module, await readBody(req));
        const file = await exportDocument(module, document, format, { viewId: url.searchParams.get('view') ?? undefined }).catch((error) => {
          throw isBug(error) ? error : new HttpError(400, (error as Error).message, { formats: exportFormats(module).map((f) => f.id) });
        });
        return send(res, 200, file.data, {
          'Content-Type': `${file.mime}; charset=utf-8`,
          ...(file.format === 'svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
        });
      }
      case 'import': {
        requireMethod(req, 'POST');
        const text = await readBody(req);
        if (!text.trim()) throw new HttpError(400, 'Falta el texto a importar en el cuerpo de la petición.');
        const name = url.searchParams.get('name') ?? undefined;
        const result = await importText(module, text, url.searchParams.get('importer') ?? undefined, { name }).catch((error) => {
          throw isBug(error) ? error : new HttpError(400, (error as Error).message);
        });
        return sendJson(res, 200, result);
      }
      case 'diff': {
        requireMethod(req, 'POST');
        return sendJson(res, 200, compare(module, await readBody(req)));
      }
      case 'run': {
        requireMethod(req, 'POST');
        if (!command) throw new HttpError(404, `Indica el comando: /api/${id}/run/<comando>. Comandos: ${commandInfos(module).map((c) => c.name).join(', ') || '(ninguno)'}.`);
        const raw = await readBody(req);
        let envelope: { input?: unknown; args?: unknown; options?: unknown } = {};
        if (raw.trim()) {
          try {
            envelope = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'El cuerpo debe ser JSON: { "input": …, "args": […], "options": {…} }.');
          }
        }
        const input = envelope.input === undefined ? undefined : typeof envelope.input === 'string' ? envelope.input : JSON.stringify(envelope.input);
        const args = Array.isArray(envelope.args) ? envelope.args.map(String) : undefined;
        const opts = envelope.options && typeof envelope.options === 'object' ? (envelope.options as Record<string, string | boolean>) : undefined;
        const result = await runCommand(module, command, { input, args, options: opts }).catch((error) => {
          throw isBug(error) ? error : new HttpError(400, (error as Error).message);
        });
        return sendJson(res, 200, { module: module.id, ...result });
      }
      default:
        throw new HttpError(404, `Acción desconocida «${action}». Use capabilities, schema, validate, views, export, import, diff o run.`);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!staticRoot) throw new HttpError(404, 'Este servicio no sirve el sitio estático (use --static <carpeta>).');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Solo GET.', { allow: 'GET, HEAD' });
    let pathname = decodeSegment(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(staticRoot, pathname));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) throw new HttpError(403, 'Ruta no permitida.');
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'No encontrado.');
    const body = await readFile(file);
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // Los archivos con hash (assets/) son inmutables; lo demás se revalida.
    send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': type, 'Cache-Control': pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  }

  return createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      applyCors(req, res, url.pathname);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (url.pathname === MANIFEST_PATH) {
        requireMethod(req, 'GET');
        // Con sitio estático la instancia ofrece los editores embebibles; sin él, solo la API.
        return sendJson(res, 200, suiteManifest(options.registry, { version: options.version, api: '../api', site: !!staticRoot, projects: !!options.projects, projectsAuth: auth ? 'bearer' : 'none' }));
      }
      if (url.pathname === API || url.pathname.startsWith(`${API}/`)) return api(req, res, url);
      return serveStatic(req, res, url);
    };
    handle().catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) {
        const headers: Record<string, string> = { ...error.headers };
        if (error.status === 405) headers.Allow = String(error.extra.allow);
        if (error.status === 413) {
          // no se sigue leyendo el cuerpo: se responde y se cierra la conexión
          headers.Connection = 'close';
          res.once('finish', () => req.destroy());
        }
        return sendJson(res, error.status, { error: error.message, ...error.extra }, headers);
      }
      process.stderr.write(`error interno: ${(error as Error).stack ?? String(error)}\n`);
      sendJson(res, 500, { error: 'Error interno del servicio.' });
    });
  });
}
