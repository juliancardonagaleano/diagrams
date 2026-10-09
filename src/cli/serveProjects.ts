import type { IncomingMessage, ServerResponse } from 'node:http';
import { bundleFileName, bundleToText, checkProject, createBundle, importBundle, isVersioned, ProjectError, parseBundle, parseVersionId, snapshotProject, unsupportedVersions, type ImportedProject, type ModuleRegistry, type ProjectStore } from '@iark/kernel';
import { accountHttpError } from './accounts/errors';
import { createMembersApi } from './accounts/members';
import type { Accounts } from './accounts/service';
import type { Quotas } from './accounts/usage';
import { AccountError, loginKey, projectRoleAllows, type ProjectRole } from './accounts/store';
import { allow, bodyObject, isJson } from './httpBody';
import { HttpError } from './httpError';
import type { Authenticator, Identity } from './serveAuth';
import type { ChangeEvent, EventPublisher, PublishOptions } from './serveEvents';
import { roleAllows, type TokenRole } from './tokens';
import { isWorkspaceId } from './workspace';

/**
 * API de proyectos de `iark serve` (con `--workspace`): los proyectos y diagramas del espacio de trabajo en carpeta. Todo es
 * JSON salvo el archivo único del proyecto.
 *
 *   GET    /api/projects                              lista (con diagramas, sin documentos)
 *   POST   /api/projects                              { name, description? } → crea
 *   GET    /api/projects/<p>                          resumen
 *   PATCH  /api/projects/<p>                          { name } → renombra
 *   DELETE /api/projects/<p>
 *   GET    /api/projects/<p>/diagrams/<d>             → { ...meta, text }
 *   PUT    /api/projects/<p>/diagrams/<d>             { text, ifUpdatedAt? } → guarda (el diagrama debe existir)
 *   POST   /api/projects/<p>/diagrams                 { module, name?, text } → crea
 *   PATCH  /api/projects/<p>/diagrams/<d>             { name } → renombra
 *   DELETE /api/projects/<p>/diagrams/<d>
 *   GET    /api/projects/<p>/diagrams/<d>/versions              historial: las versiones del diagrama, la más reciente primero (sin documentos)
 *   GET    /api/projects/<p>/diagrams/<d>/versions/<n>          → { ...meta, text }
 *   POST   /api/projects/<p>/diagrams/<d>/versions/<n>/restore  { ifUpdatedAt? } → guarda esa versión como versión NUEVA → { diagram, version, unchanged }
 *   PATCH  /api/projects/<p>/diagrams/<d>/versions/<n>          { label } → le pone nombre (desde entonces no se sustituye ni se descarta)
 *   DELETE /api/projects/<p>/diagrams/<d>/versions/<n>          borra una versión CON nombre (solo `admin` del proyecto)
 *   GET    /api/projects/<p>/bundle                   archivo único (iark.project/1), con Content-Disposition
 *   POST   /api/projects/import[?name=]               cuerpo: el archivo único → importa (nunca pisa un proyecto)
 *   GET    /api/projects/<p>/check                    comprobación del proyecto (checkProject)
 *   GET    /api/events[?project=<p>]                  cambios en tiempo real (SSE; ver `serveEvents.ts`). Esta API avisa de cada cambio que hace con éxito
 *   GET    /api/projects/<p>/members                  quién pertenece al proyecto (solo con `--accounts`; ver `accounts/members.ts`)
 *   PUT    /api/projects/<p>/members/<login>          { role } → comparte el proyecto o cambia el rol
 *   DELETE /api/projects/<p>/members/<login>          quita a alguien (o la persona se va ella misma)
 *
 * Seguridad: `iark serve` escucha en localhost, y una página ajena abierta en el navegador podría intentar leer o escribir
 * en el disco del usuario a través de él. Por eso, en estas rutas (y solo en ellas):
 *  - si el servidor atiende en loopback, la cabecera `Host` debe ser `localhost`, `127.0.0.1` o `[::1]` (contra el
 *    «DNS rebinding»: una página que hace que su dominio apunte a 127.0.0.1);
 *  - una petición con cabecera `Origin` solo se acepta si es del mismo sitio (su host es el de `Host`) o está en `--cors`
 *    (un `*` no basta: abrir la API de cálculo a cualquier sitio no es abrir el disco);
 *  - POST, PUT, PATCH y DELETE exigen `Content-Type: application/json`, que un formulario o un `fetch` `no-cors` no pueden enviar.
 *
 * Con autenticación (`--tokens`, ver `serveAuth.ts`) cada petición trae su token en `Authorization: Bearer …` y se aplican los
 * roles (ver `requiredRole`). Un token en una cabecera no es una credencial «ambiental» (el navegador no lo añade solo a las
 * peticiones de otra página), así que ya no hay CSRF ni «DNS rebinding» que atajar: las comprobaciones de `Host` y de `Origin`
 * dejan de aplicarse (el servidor, además, se expone con otros nombres y desde otros sitios). Se mantiene `Content-Type: application/json`.
 *
 * Con cuentas de GitHub (`--accounts`, ver `accounts/`) quien llama puede ser una **persona** con sesión, y entonces el rol no es el de un
 * token para toda la carpeta sino el que tiene en cada proyecto por pertenecer a él (`viewer`, `editor` o `admin`, ver `requiredRole`):
 *  - la lista solo trae los proyectos a los que pertenece, y cada proyecto trae su rol en `role`;
 *  - un proyecto al que no pertenece responde 404 (como si no existiera: no se revela qué proyectos hay); uno al que pertenece con poco rol, 403;
 *  - crear o importar un proyecto exige ser `member` de la instancia (un `guest` solo entra a lo que le comparten) y no pasar del tope de
 *    proyectos por persona, y deja a quien lo crea como `admin` del proyecto; borrarlo olvida a sus miembros;
 *  - las cuotas de uso (`accounts/usage.ts`) rechazan con `409` y `code: "limit"` crear o importar de más, crear un diagrama en un proyecto lleno y
 *    guardar lo que no cabe en el espacio de quien posee el proyecto; borrar, renombrar, nombrar y restaurar versiones nunca se rechazan;
 *  - un administrador de la instancia ve todos los proyectos y es `admin` de todos.
 * Los tokens de `--tokens` siguen funcionando con su rol para toda la carpeta (cuentas de servicio y CLI).
 */

export interface ProjectsApiContext {
  /** El almacén del espacio de trabajo; sin él, todas las rutas responden 404. */
  store: ProjectStore | undefined;
  registry: ModuleRegistry;
  /** Orígenes autorizados con `--cors` (se compara el texto exacto del `Origin`). */
  cors: string[];
  /** Con autenticación por token (`--tokens`): quien identifica a quien llama. Sin él, las rutas no piden credenciales y valen las comprobaciones de `Host` y `Origin`. */
  auth?: Authenticator;
  /** Con cuentas de GitHub: la pertenencia a proyectos de cada persona. */
  accounts?: Accounts;
  /** Con cuentas de GitHub: las cuotas de uso (proyectos por persona, diagramas por proyecto y bytes por persona; ver `accounts/usage.ts`). */
  quotas?: Quotas;
  /** Para avisar en tiempo real de lo que cambia (`GET /api/events`, ver `serveEvents.ts`); sin él, no se avisa de nada. */
  events?: EventPublisher;
  readBody(req: IncomingMessage): Promise<string>;
  send(res: ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>): void;
  sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void;
}

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `localhost:8787` → `localhost`; `[::1]:8787` → `[::1]`. */
export function hostName(host: string | undefined): string {
  return /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec((host ?? '').trim().toLowerCase())?.[1] ?? '';
}

/** ¿La conexión llegó por una dirección de loopback del servidor? (`127.x`, `::1` o su forma IPv4-mapeada). */
export const isLoopbackAddress = (address: string | undefined): boolean => !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));

/** ¿Puede este `Origin` usar la API de proyectos? Los de `--cors` por su texto exacto, y el propio sitio (mismo host y puerto que `Host`). */
export function projectOriginAllowed(origin: string, host: string | undefined, cors: string[]): boolean {
  if (cors.includes(origin)) return true;
  try {
    return !!host && new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false; // `Origin: null` (páginas sandbox, file://) y cualquier cosa que no sea una URL
  }
}

/** Sin autenticación: `Host`, `Origin` y `Content-Type`. Con ella (`authenticated`), solo `Content-Type`: ver el comentario de arriba. */
export function guard(req: IncomingMessage, cors: string[], authenticated: boolean): void {
  if (!authenticated && isLoopbackAddress(req.socket.localAddress) && !LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
    throw new HttpError(403, 'Host no permitido: este servicio solo atiende en localhost, 127.0.0.1 o [::1] (protección contra «DNS rebinding»).');
  }
  const origin = req.headers.origin;
  if (!authenticated && origin !== undefined && !projectOriginAllowed(origin, req.headers.host, cors)) {
    throw new HttpError(403, `Origen no autorizado «${origin.slice(0, 100)}»: para llamar a esta API desde otro sitio, arranque el servicio con --cors ${origin.slice(0, 100)}.`);
  }
  if (MUTATING.has(req.method ?? '') && !isJson(req)) {
    throw new HttpError(415, 'Las operaciones que modifican proyectos exigen Content-Type: application/json.');
  }
}

/**
 * El rol mínimo que exige una operación. `parts` son los segmentos de la ruta sin `projects` (como en `createProjectsApi`).
 *
 *   viewer  leer: cualquier GET (lista, resumen, diagrama, archivo único, comprobación, historial de versiones y cada versión)
 *   editor  además: crear, guardar, renombrar y borrar diagramas; crear y renombrar proyectos; importar; restaurar y nombrar versiones
 *   admin   además: borrar proyectos, gestionar quién pertenece a ellos (`PUT` y `DELETE` en `members`) y borrar versiones con nombre
 *
 * Lo que no es una lectura exige editor, también un método o una ruta que no existen (un viewer no escribe ni «probando»): la
 * respuesta a un rol insuficiente no depende de si la ruta existe. Se decide **antes** de leer el cuerpo y de tocar el disco.
 */
export function requiredRole(method: string, parts: string[]): TokenRole {
  if (method === 'GET' || method === 'HEAD') return 'viewer';
  if (method === 'DELETE' && parts.length === 1) return 'admin'; // borrar un proyecto (incluso uno que se llame `import`)
  if (parts[1] === 'members') return 'admin'; // compartir y dejar de compartir (irse uno mismo es la excepción: ver `scopeFor`)
  // Borrar una versión con nombre es perder historial protegido: lo decide quien administra el proyecto, no cualquiera que pueda editar.
  if (method === 'DELETE' && parts[1] === 'diagrams' && parts[3] === 'versions') return 'admin';
  return 'editor';
}

const STATUS: Record<ProjectError['code'], number> = { 'not-found': 404, exists: 409, conflict: 409, invalid: 400, unavailable: 500, unauthorized: 401, forbidden: 403, unsupported: 501 };

/** Los errores del almacén se responden con el código HTTP que les corresponde y su `code`; el resto se deja como está. */
function toHttpError(error: unknown): unknown {
  if (error instanceof AccountError) return accountHttpError(error);
  if (!(error instanceof ProjectError)) return error;
  if (error.code === 'unavailable') {
    process.stderr.write(`error del espacio de trabajo: ${error.message}\n`); // la ruta del disco no se le cuenta a quien llama
    return new HttpError(500, 'El espacio de trabajo no está disponible (permisos, disco o carpeta).', { code: error.code });
  }
  // Un tope que no cabe (demasiadas versiones con nombre) tiene su propio `code`, como `limit` al compartir: no es un contenido inválido.
  if (error.info.serverCode === 'limit') return new HttpError(409, error.message, { code: 'limit' });
  return new HttpError(STATUS[error.code], error.message, { code: error.code });
}

function id(value: string, what: string): string {
  if (!isWorkspaceId(value)) throw new HttpError(400, `Identificador de ${what} inválido «${String(value).slice(0, 60)}».`);
  return value;
}

/** El número de versión de una ruta (`7`), o 400: un entero positivo y corto, nada de `07`, `-1`, `1e3` ni rutas. */
function versionId(value: string | undefined): number {
  const parsed = parseVersionId(value);
  if (parsed === undefined) throw new HttpError(400, `Identificador de versión inválido «${String(value).slice(0, 40)}» (es un número entero positivo).`, { code: 'invalid' });
  return parsed;
}

function text(body: Record<string, unknown>, field: string, options: { required?: boolean } = {}): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (options.required) throw new HttpError(400, `Falta "${field}".`);
    return undefined;
  }
  if (typeof value !== 'string') throw new HttpError(400, `"${field}" debe ser un texto.`);
  return value;
}

/**
 * A qué proyectos llega quien llama y qué hacer cuando crea o borra uno. Solo existe cuando hay autenticación: sin ella (o con un
 * token, que vale para toda la carpeta) `route` no filtra nada y las respuestas no cambian.
 */
interface Scope {
  /** La cuenta de quien llama. */
  userId: string;
  /** Ve todos los proyectos (administrador de la instancia); si no, solo aquellos en los que `roleIn` da un rol. */
  all: boolean;
  /** Su rol en ese proyecto (para filtrar y para ponerlo en la respuesta), o `undefined` si no pertenece. */
  roleIn(projectId: string): ProjectRole | undefined;
  /** Un proyecto recién creado o importado: quien lo creó pasa a ser su `admin`. */
  created(projectId: string): void;
  /** Un proyecto borrado: se olvida a sus miembros. */
  deleted(projectId: string): void;
}

const forbidden = (message: string, extra: Record<string, unknown> = {}): HttpError => new HttpError(403, message, { code: 'forbidden', ...extra });

/**
 * Lo que puede hacer una persona con sesión en esta petición, decidido **antes** de leer el cuerpo y de tocar el disco: crear exige
 * ser `member` de la instancia y no pasar del tope; cualquier ruta de un proyecto exige pertenecer a él con el rol que pide la operación
 * (si no pertenece, 404, igual que si el proyecto no existiera).
 */
function scopeFor(identity: Extract<Identity, { kind: 'user' }>, accounts: Accounts, quotas: Quotas | undefined, method: string, parts: string[]): Scope {
  const { user, siteRole } = identity;
  const siteAdmin = siteRole === 'admin';
  const roles = siteAdmin ? new Map<string, ProjectRole>() : accounts.store.rolesOf(user.id);
  // Dejar un proyecto es de quien se va: basta con pertenecer a él (los demás cambios de miembros exigen administrarlo).
  const leaving = method === 'DELETE' && parts.length === 3 && parts[1] === 'members' && loginKey(parts[2]) === loginKey(user.login);
  const needed = leaving ? 'viewer' : requiredRole(method, parts);
  const creating = method === 'POST' && (parts.length === 0 || (parts.length === 1 && parts[0] === 'import'));
  if (creating) {
    if (siteRole === 'guest') throw forbidden('Tu cuenta es de invitado: puedes entrar a los proyectos que te compartan, pero no crear proyectos.');
    quotas?.assertCanCreateProject(user.id); // 409 `limit`: el tope de proyectos de esta persona (los administradores de la instancia no lo tienen, salvo que se les fije uno)
  } else if (parts.length > 0) {
    const projectId = parts[0];
    if (!siteAdmin) {
      const role = isWorkspaceId(projectId) ? roles.get(projectId) : undefined;
      if (!role) throw new HttpError(404, `No existe el proyecto «${String(projectId).slice(0, 60)}».`, { code: 'not-found' });
      if (!projectRoleAllows(role, needed)) throw forbidden(`Tu rol en este proyecto es «${role}» y esta operación exige «${needed}».`);
    }
  }
  return {
    userId: user.id,
    all: siteAdmin,
    roleIn: (projectId) => (siteAdmin ? 'admin' : roles.get(projectId)),
    created: (projectId) => {
      accounts.store.registerProject(projectId, user.id);
      roles.set(projectId, 'admin');
    },
    deleted: (projectId) => {
      accounts.store.dropProject(projectId);
      roles.delete(projectId);
    },
  };
}

/**
 * El manejador de las rutas `/api/projects…`. `parts` son los segmentos de la ruta ya decodificados, sin `projects`.
 * Sin espacio de trabajo responde 404 a todo.
 */
export function createProjectsApi(ctx: ProjectsApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  const { store, sendJson } = ctx;
  const members = createMembersApi({ accounts: ctx.accounts, readBody: ctx.readBody, sendJson });

  /** Avisa en tiempo real de un cambio ya hecho (y ya respondido): solo identificadores y marcas, nunca el documento. `by`: quién lo hizo (ver `actor`). */
  const announce = (actor: string | undefined, event: Omit<ChangeEvent, 'by'>, options?: PublishOptions): void => ctx.events?.publish({ ...event, ...(actor ? { by: actor } : {}) }, options);

  /** Con sesión de persona, cada proyecto trae el rol de quien llama. Con un token o sin autenticación, la respuesta no cambia. */
  const withRole = <T extends { id: string }>(scope: Scope | undefined, project: T): T | (T & { role: ProjectRole }) => {
    const role = scope?.roleIn(project.id);
    return role ? { ...project, role } : project;
  };

  /** Registra al creador como administrador; si no se puede guardar, el proyecto recién creado se borra (no queda uno que nadie pueda abrir). */
  async function register(scope: Scope | undefined, projectId: string, projects: ProjectStore): Promise<void> {
    if (!scope) return;
    try {
      scope.created(projectId);
    } catch (error) {
      await projects.deleteProject(projectId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Guarda con las cuotas: comprueba que cabe y escribe sin que otro guardado de la misma persona se cuele en medio. Sin cuotas (o sin cuentas),
   * solo escribe. Restaurar una versión no pasa por aquí a propósito (ver `accounts/usage.ts`).
   */
  async function withQuota<T>(projectId: string, input: { diagramId?: string; text: string }, scope: Scope | undefined, write: () => Promise<T>): Promise<T> {
    const quotas = ctx.quotas;
    if (!quotas) return write();
    return quotas.exclusive(quotas.keyFor(projectId), async () => {
      await quotas.assertCanSave(projectId, { ...input, actorId: scope?.userId });
      return write();
    });
  }

  /**
   * El historial de versiones de un diagrama (`/diagrams/<d>/versions…`). Quién guarda lo decide la identidad de la petición (`actor`), nunca el
   * cuerpo: un cliente no puede atribuir un guardado a otra persona.
   */
  async function versionsRoute(req: IncomingMessage, res: ServerResponse, projects: ProjectStore, rest: string[], actor: string | undefined): Promise<void> {
    const method = req.method ?? 'GET';
    const [projectId, , diagramId, , rawVersion, action] = rest;
    if (!isVersioned(projects)) throw unsupportedVersions();
    const p = id(projectId, 'proyecto');
    const d = id(diagramId, 'diagrama');
    if (rest.length === 4) {
      if (method !== 'GET') return allow('GET');
      return sendJson(res, 200, await projects.listVersions(p, d));
    }
    const n = versionId(rawVersion);
    if (rest.length === 5) {
      if (method === 'GET') {
        const version = await projects.getVersion(p, d, n);
        if (!version) throw new ProjectError('not-found', `No existe la versión ${n} del diagrama «${d}» (¿se descartó al rotar el historial?).`);
        return sendJson(res, 200, version);
      }
      if (method === 'PATCH') return sendJson(res, 200, await projects.labelVersion(p, d, n, text(await bodyObject(ctx.readBody, req), 'label', { required: true })!));
      if (method === 'DELETE') {
        await projects.deleteVersion(p, d, n);
        return sendJson(res, 200, { deleted: n });
      }
      return allow('GET, PATCH, DELETE');
    }
    if (rest.length === 6 && action === 'restore') {
      if (method !== 'POST') return allow('POST');
      const body = await bodyObject(ctx.readBody, req);
      const restored = await projects.restoreVersion(p, d, n, { ifUpdatedAt: text(body, 'ifUpdatedAt'), by: actor });
      sendJson(res, 200, restored);
      if (!restored.unchanged) announce(actor, { type: 'diagram.restored', project: p, diagram: d, updatedAt: restored.diagram.updatedAt });
      return;
    }
    throw new HttpError(404, 'Ruta de proyectos desconocida. Ver la lista de rutas de /api/projects en docs/proyectos.md.');
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], projects: ProjectStore, scope: Scope | undefined, actor: string | undefined): Promise<void> {
    const method = req.method ?? 'GET';
    const [first, second, third] = parts;

    if (parts.length === 0) {
      if (method === 'GET') {
        const all = await projects.listProjects();
        return sendJson(res, 200, scope && !scope.all ? all.filter((p) => scope.roleIn(p.id)).map((p) => withRole(scope, p)) : scope ? all.map((p) => withRole(scope, p)) : all);
      }
      if (method === 'POST') {
        const body = await bodyObject(ctx.readBody, req);
        const created = await projects.createProject({ name: text(body, 'name', { required: true })!, description: text(body, 'description') });
        await register(scope, created.id, projects);
        sendJson(res, 201, scope ? withRole(scope, created) : created, { Location: `/api/projects/${created.id}` });
        return announce(actor, { type: 'project.created', project: created.id, updatedAt: created.updatedAt });
      }
      return allow('GET, POST');
    }
    // `import` no es un proyecto: es la ruta para traer uno desde su archivo único
    if (first === 'import' && parts.length === 1 && method === 'POST') {
      const bundle = parseBundle(await ctx.readBody(req));
      const importIt = async (): Promise<ImportedProject> => {
        if (scope) await ctx.quotas?.assertCanImport(scope.userId, bundle);
        return importBundle(projects, bundle, { name: url.searchParams.get('name') ?? undefined });
      };
      const imported = await (scope && ctx.quotas ? ctx.quotas.exclusive(scope.userId, importIt) : importIt());
      await register(scope, imported.project.id, projects);
      sendJson(res, 201, scope ? { ...imported, project: withRole(scope, imported.project) } : imported, { Location: `/api/projects/${imported.project.id}` });
      return announce(actor, { type: 'project.created', project: imported.project.id, updatedAt: imported.project.updatedAt });
    }

    const projectId = id(first, 'proyecto');
    if (parts.length === 1) {
      if (method === 'GET') {
        const found = await projects.getProject(projectId);
        if (!found) throw new ProjectError('not-found', `No existe el proyecto «${projectId}».`);
        return sendJson(res, 200, withRole(scope, found));
      }
      if (method === 'PATCH') {
        const renamed = await projects.renameProject(projectId, text(await bodyObject(ctx.readBody, req), 'name', { required: true })!);
        sendJson(res, 200, withRole(scope, renamed));
        return announce(actor, { type: 'project.changed', project: projectId, updatedAt: renamed.updatedAt });
      }
      if (method === 'DELETE') {
        // Quienes pertenecían al proyecto se olvidan al borrarlo (`scope.deleted`): se anotan antes para que el aviso les llegue.
        const belonged = ctx.accounts ? ctx.accounts.store.membersOf(projectId).map((m) => m.user.id) : [];
        await projects.deleteProject(projectId);
        scope?.deleted(projectId);
        sendJson(res, 200, { deleted: projectId });
        return announce(actor, { type: 'project.deleted', project: projectId }, { alsoUsers: belonged });
      }
      return allow('GET, PATCH, DELETE');
    }

    if (second === 'members') {
      if (!(await projects.getProject(projectId))) throw new ProjectError('not-found', `No existe el proyecto «${projectId}».`);
      // A quien se le quita el acceso se le avisa aunque ya no pertenezca (así su pantalla deja de mostrar el proyecto sin esperar al sondeo).
      const removing = ctx.accounts && req.method === 'DELETE' && parts[2] !== undefined ? ctx.accounts.store.membersOf(projectId).find((m) => loginKey(m.user.login) === loginKey(parts[2])) : undefined;
      await members(req, res, projectId, parts.slice(2), scope?.userId);
      if (req.method === 'PUT' || req.method === 'DELETE') announce(actor, { type: 'project.changed', project: projectId }, { alsoUsers: removing ? [removing.user.id] : [] });
      return;
    }
    if (second === 'bundle' && parts.length === 2) {
      if (method !== 'GET') return allow('GET');
      const snapshot = await snapshotProject(projects, projectId);
      const file = bundleToText(createBundle(snapshot, { generator: 'DIAgrams' }));
      return ctx.send(res, 200, file, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${bundleFileName(snapshot.name)}"` });
    }
    if (second === 'check' && parts.length === 2) {
      if (method !== 'GET') return allow('GET');
      return sendJson(res, 200, checkProject(await snapshotProject(projects, projectId), ctx.registry));
    }
    if (second === 'diagrams' && parts.length === 2) {
      if (method !== 'POST') return allow('POST');
      const body = await bodyObject(ctx.readBody, req);
      const input = { module: text(body, 'module', { required: true }), name: text(body, 'name'), text: text(body, 'text', { required: true })!, by: actor };
      const created = await withQuota(projectId, { text: input.text }, scope, () => projects.saveDiagram(projectId, input));
      sendJson(res, 201, created, { Location: `/api/projects/${projectId}/diagrams/${created.id}` });
      return announce(actor, { type: 'diagram.created', project: projectId, diagram: created.id, updatedAt: created.updatedAt });
    }
    if (second === 'diagrams' && parts.length === 3) {
      const diagramId = id(third, 'diagrama');
      if (method === 'GET') {
        const diagram = await projects.getDiagram(projectId, diagramId);
        if (!diagram) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${projectId}».`);
        return sendJson(res, 200, diagram);
      }
      if (method === 'PUT') {
        const body = await bodyObject(ctx.readBody, req);
        const input = { id: diagramId, text: text(body, 'text', { required: true })!, ifUpdatedAt: text(body, 'ifUpdatedAt'), by: actor };
        const saved = await withQuota(projectId, { diagramId, text: input.text }, scope, () => projects.saveDiagram(projectId, input));
        sendJson(res, 200, saved);
        return announce(actor, { type: 'diagram.saved', project: projectId, diagram: diagramId, updatedAt: saved.updatedAt });
      }
      if (method === 'PATCH') {
        const renamed = await projects.renameDiagram(projectId, diagramId, text(await bodyObject(ctx.readBody, req), 'name', { required: true })!);
        sendJson(res, 200, renamed);
        return announce(actor, { type: 'diagram.renamed', project: projectId, diagram: diagramId, updatedAt: renamed.updatedAt });
      }
      if (method === 'DELETE') {
        await projects.deleteDiagram(projectId, diagramId);
        sendJson(res, 200, { deleted: diagramId });
        return announce(actor, { type: 'diagram.deleted', project: projectId, diagram: diagramId });
      }
      return allow('GET, PUT, PATCH, DELETE');
    }
    if (second === 'diagrams' && parts[3] === 'versions' && parts.length >= 4 && parts.length <= 6) return versionsRoute(req, res, projects, parts, actor);
    throw new HttpError(404, 'Ruta de proyectos desconocida. Ver la lista de rutas de /api/projects en docs/proyectos.md.');
  }

  return async (req, res, url, parts) => {
    if (!store) throw new HttpError(404, 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)');
    const identity = ctx.auth?.identify(req);
    const method = req.method ?? 'GET';
    let scope: Scope | undefined;
    if (identity?.kind === 'token') {
      const needed = requiredRole(method, parts);
      if (!roleAllows(identity.role, needed)) throw new HttpError(403, `El rol «${identity.role}» no permite esta operación (hace falta «${needed}»).`, { code: 'forbidden' });
    } else if (identity?.kind === 'user') {
      if (!ctx.accounts) throw new HttpError(401, 'Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>».', { code: 'unauthorized' });
      scope = scopeFor(identity, ctx.accounts, ctx.quotas, method, parts);
    }
    guard(req, ctx.cors, !!ctx.auth);
    // Quién guarda, para el historial: el nombre del token o `@usuario` de la sesión. Sin autenticación no se sabe y no se anota nada.
    const actor = identity?.kind === 'token' ? identity.name : identity?.kind === 'user' ? `@${identity.user.login}` : undefined;
    try {
      await route(req, res, url, parts, store, scope, actor);
      // Cualquier cambio deja caduca la medida de ese proyecto (las cuotas la miden de nuevo la próxima vez que la necesiten).
      if (method !== 'GET' && method !== 'HEAD' && parts[0] !== undefined && parts[0] !== 'import') ctx.quotas?.invalidate(parts[0]);
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
