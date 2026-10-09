import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { commandInfos, moduleCapabilities, type AnyModule, type ModuleRegistry, type ProjectStore } from '@iark/kernel';
import { createAdminApi } from './accounts/admin';
import { createAuthApi } from './accounts/routes';
import type { Accounts } from './accounts/service';
import { createUsageApi, QUOTA_KINDS, Quotas } from './accounts/usage';
import { COMPUTE_ACTIONS, inlineExecutor, unwrapOutcome, type ComputeExecutor, type ComputeJob } from './compute';
import { HttpError } from './httpError';
import { directoryWritable, fileReadable, Readiness, type Check } from './observability/health';
import { Observability } from './observability';
import type { MetricFamily } from './observability/metrics';
import { createMetricsEndpoint } from './observability/metricsEndpoint';
import { createAuthenticator, type Authenticator, type FailureLimiterOptions } from './serveAuth';
import { createEventsApi, EventHub, type EventHubOptions } from './serveEvents';
import { createProjectsApi } from './serveProjects';
import { applySecurityHeaders } from './securityHeaders';
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
 *   POST /api/trace                             cuerpo: { documents: [{ module, document }], from?, direction?, depth?, types?, orphans?, matrix?, coverage? } → { graph, types?, from?, reached?, orphans?, matrix?, coverage?, report, mermaid, svg }
 *   GET  /healthz                               vivo: 200 { status: "ok" } sin autenticación ni detalles (lo consulta el HEALTHCHECK de la imagen)
 *   GET  /readyz                                listo: 200 o 503 con el estado (ok/fail) de cada comprobación: carpeta de trabajo, tokens, cuentas, cálculo
 *   GET  /metrics                               métricas de Prometheus; solo con `--metrics` (ver `observability/`): con token o solo desde loopback
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
 *   GET  /api/events[?project=<p>]                      cambios de los proyectos en tiempo real (Server-Sent Events, solo avisos; ver `serveEvents.ts`)
 *
 * Con tokens (`--tokens <archivo>`, ver `serveAuth.ts`) esas rutas y `/api/whoami` exigen `Authorization: Bearer <token>` y aplican los
 * roles `viewer`, `editor` y `admin`:
 *   GET  /api/whoami                                    { auth: true, name, role } con tokens (401 sin uno válido) · { auth: false } sin ellos
 *
 * Las rutas de cálculo (validate, views, export, import, diff, run y `/api/trace`) no tocan el disco, pero cuestan CPU: con tokens o
 * cuentas exigen también una credencial válida de cualquier rol (401 sin ella), salvo con `publicCompute` (`--public-compute`). Siguen
 * públicas `/api/modules`, `capabilities`, `schema` y el manifiesto, que la federación descubre sin credencial. Sin autenticación
 * configurada, todo queda abierto como siempre. El cálculo no corre en el hilo que atiende las conexiones sino en un `ComputeExecutor`
 * (`iark serve` pasa un `ComputePool`, con tiempo límite y cola acotada: 503 si se agotan; ver `computePool.ts`). `run` nunca abre
 * archivos del servidor: las opciones marcadas `local` de un comando se rechazan (ver `CommandOption.local`).
 *
 * Con cuentas (`--accounts <archivo>` y una OAuth App de GitHub, ver `accounts/`) la sesión de una persona sirve igual que un token, pero su
 * rol sale de a qué proyectos pertenece, y `/api/auth` ofrece el inicio de sesión (ver `accounts/routes.ts`):
 *   GET  /api/auth/providers                            público: formas de entrar que ofrece la instancia
 *   GET  /api/auth/github/login · /callback             el flujo de GitHub (redirecciones)
 *   POST /api/auth/exchange · /logout                   cambia el código por una sesión · la cierra
 *   GET  /api/whoami                                    con una sesión: { auth: true, name, role: <rol en la instancia>, user }
 *   GET|PUT|DELETE /api/projects/<p>/members[/<login>]  quién pertenece a un proyecto y con qué rol (ver `accounts/members.ts`)
 *   GET|PUT|DELETE /api/admin/users[/<login>]           las cuentas de la instancia, solo para quien la administra (ver `accounts/admin.ts`)
 *   GET  /api/usage                                     el uso y la cuota de la persona que llama, con el desglose por proyecto (ver `accounts/usage.ts`)
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
  /**
   * Dónde se ejecutan las operaciones de cálculo (`ComputePool`, con tiempo límite y cola acotada). Por omisión, en el propio hilo
   * y sin límites, como antes: es lo que usan las pruebas; `iark serve` siempre pasa un pool (salvo con `--workers 0`). Es de quien lo
   * crea: el servidor no lo cierra al pararse.
   */
  compute?: ComputeExecutor;
  /** Deja las rutas de cálculo abiertas aunque haya tokens o cuentas (`--public-compute`). Sin autenticación configurada no hace nada. */
  publicCompute?: boolean;
  /** Orígenes que pueden incrustar las cargas embebidas (`?embed=1`) por iframe (`--frame-ancestors`). Por omisión `*`; ver `securityHeaders.ts`. */
  frameAncestors?: string[];
  /**
   * Registro de accesos, auditoría y métricas (ver `observability/`). Sin él, el servidor solo pone `X-Request-Id` y atiende `/healthz` y
   * `/readyz`. Es de quien lo crea (`iark serve` lo cierra al parar); un `Observability` sirve a un solo servidor.
   */
  observability?: Observability;
  /** El token Bearer de `GET /metrics` (`--metrics-token`). Sin él, las métricas (si están activadas) solo se sirven a conexiones de loopback. */
  metricsToken?: string;
  /** Cuánto tiempo (ms) se reutiliza lo medido de un proyecto para las cuotas. Por omisión 30000; 0 = siempre se mide (pruebas). */
  usageTtlMs?: number;
  /**
   * Cambios de los proyectos en tiempo real (`GET /api/events`, ver `serveEvents.ts`), activos con `projects`. `false` los desactiva (`--max-streams 0`):
   * la ruta responde 404 y los clientes sondean como antes. Los números son los topes y el latido; los de por omisión sirven en producción.
   */
  events?: false | Pick<EventHubOptions, 'maxPerPerson' | 'maxTotal' | 'heartbeatMs' | 'maxBufferedBytes'>;
  /** Cuánto tiempo (ms) se reutiliza el resultado de `/readyz`. Por omisión 5000; 0 = siempre se comprueba (pruebas). */
  readyCacheMs?: number;
}

const API = '/api';
const MANIFEST_PATH = '/.well-known/iark.json';

/** Los segmentos de una ruta de la API, ya decodificados como en `api()`, o `undefined` si no es de la API. */
function apiParts(pathname: string): string[] | undefined {
  if (pathname !== API && !pathname.startsWith(`${API}/`)) return undefined;
  return pathname.slice(API.length).split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment; // la petición se rechazará con 400 más adelante
    }
  });
}

/** Las rutas que exigen token cuando lo hay: la API de proyectos, `/api/whoami`, `/api/usage`, `/api/auth` y `/api/admin`. */
function isAuthRoute(pathname: string): boolean {
  const parts = apiParts(pathname);
  return !!parts && (parts[0] === 'projects' || parts[0] === 'events' || parts[0] === 'auth' || parts[0] === 'admin' || ((parts[0] === 'whoami' || parts[0] === 'usage') && parts.length === 1));
}

/** Las rutas de cálculo: `POST /api/trace` y `/api/<módulo>/<validate|views|export|import|diff|run…>`. Con autenticación exigen credencial (salvo `--public-compute`). */
function isComputeRoute(pathname: string): boolean {
  const parts = apiParts(pathname);
  return !!parts && ((parts.length === 1 && parts[0] === 'trace') || (parts.length >= 2 && COMPUTE_ACTIONS.has(parts[1])));
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

export function createSuiteServer(options: ServeOptions): Server {
  const maxBody = options.maxBodyBytes ?? 5 * 1024 * 1024;
  const staticRoot = options.staticDir ? resolve(options.staticDir) : undefined;
  const cors = options.cors ?? [];
  const ownObservability = !options.observability;
  const obs = options.observability ?? new Observability({ version: options.version });
  const rawAuth = options.tokens || options.accounts ? createAuthenticator({ tokens: options.tokens, accounts: options.accounts, trustProxy: options.trustProxy, limits: options.authLimits }) : undefined;
  /** Quién identifica a quien llama; anota en el contexto de la petición quién es (o por qué no pudo ser nadie) para el registro de accesos y la auditoría. */
  const auth: Authenticator | undefined = rawAuth && {
    async identify(req) {
      const context = obs.contextOf(req);
      try {
        const identity = await rawAuth.identify(req);
        context?.identified(identity);
        return identity;
      } catch (error) {
        context?.authFailed(error, req.headers.authorization !== undefined);
        throw error;
      }
    },
  };
  /** Con autenticación y sin `publicCompute`, las rutas de cálculo piden una credencial válida (de cualquier rol). */
  const computeAuth = options.publicCompute ? undefined : auth;
  const executor = options.compute ?? inlineExecutor(options.registry);
  /** Las cuotas de uso: solo con cuentas y espacio de trabajo (ver `accounts/usage.ts`). */
  const quotas = options.accounts && options.projects ? new Quotas({ accounts: options.accounts, store: options.projects, ttlMs: options.usageTtlMs }) : undefined;

  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void => {
    obs.contextOf(res)?.sent(typeof body === 'string' ? Buffer.byteLength(body) : body.length, headers);
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void =>
    send(res, status, `${JSON.stringify(value, null, 2)}\n`, { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  /** JSON en una sola línea (a diferencia del resto de la API): `/healthz` y `/readyz` las leen máquinas, no personas, y cabe en pocos bytes. */
  const sendCompact = (res: ServerResponse, status: number, value: unknown): void =>
    send(res, status, `${JSON.stringify(value)}\n`, { 'Content-Type': 'application/json; charset=utf-8' });

  // Salud (`/healthz`, `/readyz`) y métricas (`/metrics`): ver `observability/`. Las comprobaciones de `/readyz` son las que tiene este servidor.
  const checks: Record<string, Check> = {};
  const workspaceRoot = (options.projects as { root?: unknown } | undefined)?.root;
  if (typeof workspaceRoot === 'string') checks.workspace = () => directoryWritable(workspaceRoot);
  if (options.tokens) {
    const tokens = options.tokens;
    checks.tokens = () => tokens.lookup(undefined).status !== 'unavailable';
  }
  if (options.accounts) {
    const store = options.accounts.store;
    // El archivo (JSON o base SQLite) se puede leer, el almacén responde a una lectura de verdad y la carpeta admite escribir (el JSON se
    // reemplaza por renombrado; SQLite crea su diario `-wal` y `-shm` al lado). Con Postgres no hay archivo: basta con que la base responda.
    checks.accounts = async () => (store.kind === 'postgres' ? store.readable() : (await fileReadable(store.path)) && (await store.readable()) && (await directoryWritable(dirname(store.path))));
  }
  if (executor.healthy) checks.compute = () => executor.healthy!();
  const readiness = new Readiness(checks, { cacheMs: options.readyCacheMs, warn: obs.warn });
  const metricsEndpoint = obs.metrics ? createMetricsEndpoint({ metrics: obs.metrics, token: options.metricsToken, trustProxy: options.trustProxy }) : undefined;
  obs.metrics?.addCollector(async (): Promise<MetricFamily[]> => {
    const families: MetricFamily[] = [];
    const compute = executor.stats?.();
    if (compute) {
      families.push(
        { name: 'iark_compute_workers', help: 'Hilos de cálculo creados ahora mismo.', type: 'gauge', samples: [{ value: compute.workers }] },
        { name: 'iark_compute_workers_max', help: 'Hilos de cálculo como máximo a la vez.', type: 'gauge', samples: [{ value: compute.size }] },
        { name: 'iark_compute_active', help: 'Operaciones de cálculo en curso.', type: 'gauge', samples: [{ value: compute.active }] },
        { name: 'iark_compute_queued', help: 'Operaciones de cálculo esperando un hilo libre.', type: 'gauge', samples: [{ value: compute.queued }] },
        { name: 'iark_compute_completed_total', help: 'Operaciones de cálculo terminadas.', type: 'counter', samples: [{ value: compute.completed }] },
        { name: 'iark_compute_timeouts_total', help: 'Operaciones de cálculo canceladas por pasar del tiempo límite.', type: 'counter', samples: [{ value: compute.timeouts }] },
        { name: 'iark_compute_rejected_total', help: 'Operaciones de cálculo rechazadas por tener la cola llena.', type: 'counter', samples: [{ value: compute.rejected }] },
        { name: 'iark_compute_worker_crashes_total', help: 'Hilos de cálculo que se cayeron.', type: 'counter', samples: [{ value: compute.crashes }] },
      );
    }
    if (options.accounts) {
      let stats: Awaited<ReturnType<typeof options.accounts.store.stats>> | undefined;
      try {
        stats = await options.accounts.store.stats();
      } catch {
        stats = undefined; // la base de cuentas no responde: /readyz lo dice; las demás métricas deben seguir saliendo
      }
      if (stats) {
        families.push(
          { name: 'iark_accounts', help: 'Cuentas de la instancia, por estado (solo recuentos).', type: 'gauge', samples: [{ labels: { state: 'active' }, value: stats.active }, { labels: { state: 'disabled' }, value: stats.disabled }, { labels: { state: 'pending' }, value: stats.pending }] },
          { name: 'iark_sessions_active', help: 'Sesiones de GitHub vigentes (solo el recuento).', type: 'gauge', samples: [{ value: stats.sessions }] },
        );
      }
    }
    if (quotas) {
      // Sin etiquetas por persona (cardinalidad acotada y nada de datos personales): solo el tipo de tope.
      const limits = quotas.defaults;
      families.push(
        { name: 'iark_quota_rejections_total', help: 'Operaciones rechazadas por superar una cuota, por tipo de tope (bytes, projects, diagrams).', type: 'counter', samples: QUOTA_KINDS.map((kind) => ({ labels: { kind }, value: quotas.rejected[kind] })) },
        { name: 'iark_quota_limit', help: 'Topes de la instancia por omisión, por tipo (bytes, projects, diagrams); 0 es sin tope.', type: 'gauge', samples: [{ labels: { kind: 'bytes' }, value: limits.bytes }, { labels: { kind: 'projects' }, value: limits.projects }, { labels: { kind: 'diagrams' }, value: limits.diagramsPerProject }] },
      );
    }
    if (options.tokens) {
      const available = options.tokens.lookup(undefined).status !== 'unavailable';
      families.push(
        { name: 'iark_tokens', help: 'Tokens de acceso del archivo de tokens (solo el recuento).', type: 'gauge', samples: [{ value: available ? options.tokens.size : 0 }] },
        { name: 'iark_tokens_file_ok', help: '1 si el archivo de tokens se puede leer y es válido; 0 si el servicio está denegando todo por no poder usarlo.', type: 'gauge', samples: [{ value: available ? 1 : 0 }] },
      );
    }
    return families;
  });

  function applyCors(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const origin = req.headers.origin;
    if (!origin || cors.length === 0) return;
    if (cors.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (cors.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else return;
    if (auth && (isAuthRoute(pathname) || (computeAuth && isComputeRoute(pathname)))) {
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

  /** Lo mismo, avisando al contexto de la petición del cuerpo leído (solo guarda el de miembros y cuentas, para la auditoría; ver `RequestContext.readBody`). */
  const observedBody = async (req: IncomingMessage): Promise<string> => {
    const text = await readBody(req);
    obs.contextOf(req)?.readBody(text);
    return text;
  };

  // Cambios en tiempo real: solo con espacio de trabajo y si no se desactivaron. Los canales abiertos no cuentan como peticiones en curso (ver `RequestContext.streaming`).
  const hub = options.projects && options.events !== false ? new EventHub({ accounts: options.accounts, ...options.events }) : undefined;
  obs.metrics?.addCollector((): MetricFamily[] =>
    hub
      ? [
          { name: 'iark_event_streams', help: 'Canales de eventos en directo abiertos ahora mismo (solo el recuento).', type: 'gauge', samples: [{ value: hub.stats.open }] },
          { name: 'iark_events_published_total', help: 'Cambios de proyectos publicados en el canal de eventos.', type: 'counter', samples: [{ value: hub.stats.published }] },
          { name: 'iark_events_delivered_total', help: 'Mensajes de cambio enviados a algún canal (un cambio llega a cada canal de quien pertenece al proyecto).', type: 'counter', samples: [{ value: hub.stats.delivered }] },
          { name: 'iark_event_streams_rejected_total', help: 'Canales de eventos rechazados por superar el tope por persona o el global.', type: 'counter', samples: [{ value: hub.stats.rejected }] },
          { name: 'iark_event_streams_dropped_total', help: 'Canales de eventos cortados por no leer lo que se les enviaba.', type: 'counter', samples: [{ value: hub.stats.dropped }] },
        ]
      : [],
  );
  const projectsApi = createProjectsApi({ store: options.projects, registry: options.registry, cors, auth, accounts: options.accounts, quotas, events: hub, readBody: observedBody, send, sendJson });
  const eventsApi = createEventsApi({ hub, store: options.projects, cors, auth, recheck: rawAuth, accounts: options.accounts, trustProxy: options.trustProxy ?? false, streaming: (req, summary) => obs.contextOf(req)?.streaming(summary) });
  const adminApi = createAdminApi({ accounts: options.accounts, auth, quotas, readBody: observedBody, sendJson });
  const usageApi = createUsageApi({ accounts: options.accounts, auth, quotas, sendJson });
  const authApi = createAuthApi({
    accounts: options.accounts,
    auth,
    tokens: !!options.tokens,
    trustProxy: options.trustProxy ?? false,
    readBody: observedBody,
    send,
    sendJson,
    onLogin: (req, user) => obs.contextOf(req)?.loggedIn(user),
    onLoginFailed: (req, failure) => obs.contextOf(req)?.loginFailed(failure),
  });

  const requireMethod = (req: IncomingMessage, allowed: 'GET' | 'POST'): void => {
    if (req.method !== allowed) throw new HttpError(405, `Este endpoint solo admite ${allowed}.`, { allow: allowed });
  };

  function moduleOf(id: string): AnyModule {
    const module = options.registry.get(id);
    if (!module) throw new HttpError(404, `No existe el módulo «${id}». Módulos: ${options.registry.ids().join(', ')}.`);
    return module;
  }

  /**
   * Las rutas de cálculo piden credencial (de cualquier rol) cuando hay autenticación y no se abrieron con `publicCompute`. Se decide
   * antes de leer el cuerpo y antes de saber si el módulo existe: quien no entra no cuesta ni memoria ni CPU, y no averigua nada.
   */
  const requireComputeAccess = async (req: IncomingMessage): Promise<void> => void (await computeAuth?.identify(req));

  /**
   * Entrega el trabajo al ejecutor (el pool de hilos de `iark serve`) y responde con su resultado: la misma semántica de errores que
   * si se calculara aquí (400/404/422 con mensaje limpio, 500 para un fallo del programa) más el 503 del pool (tiempo límite, cola llena).
   * Si el cliente cuelga con la operación aún en cola, se descarta.
   */
  async function runCompute(res: ServerResponse, job: ComputeJob): Promise<void> {
    const abandoned = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abandoned.abort();
    });
    const outcome = await executor.run(job, { signal: abandoned.signal });
    if (abandoned.signal.aborted) return;
    const done = unwrapOutcome(outcome);
    send(res, 200, done.body, { 'Content-Type': done.contentType, ...done.headers });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.slice(API.length).split('/').filter(Boolean).map(decodeSegment);
    if (parts[0] === 'projects') return projectsApi(req, res, url, parts.slice(1));
    if (parts[0] === 'events') return eventsApi(req, res, url, parts.slice(1));
    if (parts[0] === 'auth') return authApi(req, res, url, parts.slice(1));
    if (parts[0] === 'admin') return adminApi(req, res, url, parts.slice(1));
    if (parts[0] === 'usage') return usageApi(req, res, url, parts.slice(1));
    if (parts.length === 1 && parts[0] === 'whoami') {
      requireMethod(req, 'GET');
      if (!auth) return sendJson(res, 200, { auth: false });
      const who = await auth.identify(req);
      if (who.kind === 'token') return sendJson(res, 200, { auth: true, name: who.name, role: who.role });
      return sendJson(res, 200, { auth: true, name: who.user.name ?? who.user.login, role: who.siteRole, user: who.user });
    }
    if (parts.length === 1 && parts[0] === 'modules') {
      requireMethod(req, 'GET');
      return sendJson(res, 200, options.registry.list().map(moduleCapabilities));
    }
    if (parts.length === 1 && parts[0] === 'trace') {
      await requireComputeAccess(req);
      requireMethod(req, 'POST');
      return runCompute(res, { op: 'trace', body: await readBody(req) });
    }
    const [id, action, command] = parts;
    if (!id || !action) throw new HttpError(404, 'Ruta de la API desconocida. Ver /api/modules.');
    if (COMPUTE_ACTIONS.has(action)) await requireComputeAccess(req);
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
      case 'validate':
      case 'views':
      case 'diff':
        requireMethod(req, 'POST');
        return runCompute(res, { op: action, module: module.id, body: await readBody(req) });
      case 'export':
        requireMethod(req, 'POST');
        return runCompute(res, { op: 'export', module: module.id, body: await readBody(req), format: url.searchParams.get('format') ?? 'json', view: url.searchParams.get('view') ?? undefined });
      case 'import':
        requireMethod(req, 'POST');
        return runCompute(res, { op: 'import', module: module.id, body: await readBody(req), importer: url.searchParams.get('importer') ?? undefined, name: url.searchParams.get('name') ?? undefined });
      case 'run':
        requireMethod(req, 'POST');
        if (!command) throw new HttpError(404, `Indica el comando: /api/${id}/run/<comando>. Comandos: ${commandInfos(module).map((c) => c.name).join(', ') || '(ninguno)'}.`);
        return runCompute(res, { op: 'run', module: module.id, command, body: await readBody(req) });
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

  /** `/healthz`, `/readyz` y `/metrics` solo se leen. */
  const requireRead = (req: IncomingMessage): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Este endpoint solo admite GET.', { allow: 'GET, HEAD' });
  };

  const server = createServer((req, res) => {
    const context = obs.begin(req, res, { trustProxy: options.trustProxy });
    applySecurityHeaders(req, res, { trustProxy: options.trustProxy, frameAncestors: options.frameAncestors });
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Los puntos de control de las máquinas (balanceador, Docker, Prometheus) van antes del CORS y de la autenticación de personas.
      if (url.pathname === '/healthz') {
        requireRead(req);
        return sendCompact(res, 200, { status: 'ok' });
      }
      if (url.pathname === '/readyz') {
        requireRead(req);
        const report = await readiness.status();
        return sendCompact(res, report.ok ? 200 : 503, { status: report.ok ? 'ok' : 'fail', checks: report.checks });
      }
      if (url.pathname === '/metrics' && metricsEndpoint) return metricsEndpoint(req, res, send);
      applyCors(req, res, url.pathname);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (url.pathname === MANIFEST_PATH) {
        requireMethod(req, 'GET');
        // Con sitio estático la instancia ofrece los editores embebibles; sin él, solo la API.
        return sendJson(res, 200, suiteManifest(options.registry, { version: options.version, api: '../api', site: !!staticRoot, projects: !!options.projects, projectsAuth: auth ? 'bearer' : 'none', events: !!hub }));
      }
      if (url.pathname === API || url.pathname.startsWith(`${API}/`)) return api(req, res, url);
      return serveStatic(req, res, url);
    };
    handle().catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      // El cliente colgó antes de recibir respuesta: no hay a quién responder ni es un fallo del servicio (queda como 499 en el registro de accesos).
      if (res.socket?.destroyed) return;
      if (error instanceof HttpError) {
        context.failed(error.extra.code);
        const headers: Record<string, string> = { ...error.headers };
        if (error.status === 405) headers.Allow = String(error.extra.allow);
        if (error.status === 413) {
          // no se sigue leyendo el cuerpo: se responde y se cierra la conexión
          headers.Connection = 'close';
          res.once('finish', () => req.destroy());
        }
        return sendJson(res, error.status, { error: error.message, ...error.extra }, headers);
      }
      context.failed('internal');
      process.stderr.write(`error interno: ${(error as Error).stack ?? String(error)}\n  petición: ${context.id}\n`);
      sendJson(res, 500, { error: 'Error interno del servicio.' });
    });
  });
  // Los canales de eventos no terminan solos y `server.close()` espera a que terminen todas las conexiones: al parar se cierran con un aviso (`bye`).
  if (hub) {
    const close = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      hub.closeAll();
      return close(callback);
    }) as Server['close'];
  }
  // Un `Observability` que creó este servidor (no se le pasó uno) se cierra con él.
  if (ownObservability) server.once('close', () => void obs.close());
  return server;
}
