import { createHash, randomBytes } from 'node:crypto';
import { MemoryProjectStore, ProjectError, type ProjectErrorCode, type ProjectRole, type ProjectStore } from '@iark/kernel';

/**
 * Apoyo de las pruebas: un `fetch` simulado que se comporta como la API `/api/projects` de `iark serve --workspace` (rutas,
 * códigos y cuerpos de error), sobre un almacén en memoria, con interruptores para provocar lo que pasa en la vida real:
 * red caída, un token que el servidor no acepta, un rol que no puede escribir, un servidor sin proyectos o un origen que el
 * navegador rechaza por CORS. No lo usa la aplicación.
 *
 * Con `accounts: true` se comporta además como un servidor con inicio de sesión de GitHub (`iark serve --accounts`): `/api/auth/…`
 * (providers, exchange con PKCE, logout), sesiones de persona (`iark_s_…`), proyectos por pertenencia con su `role` (lo ajeno es 404) y
 * compartir (`/api/projects/<p>/members`). Sin `accounts`, esas rutas dan 404 como en un servidor anterior a las cuentas.
 */
export interface FakeServer {
  fetch: typeof fetch;
  store: ProjectStore;
  /** Las peticiones recibidas (método y ruta), en orden. */
  log: string[];
  /** Red caída: toda petición falla como un `fetch` sin respuesta. */
  down: boolean;
  /** El navegador rechaza por CORS: las peticiones `cors` fallan sin respuesta, pero las `no-cors` llegan (opacas). */
  corsBlocked: boolean;
  /** Si es una cadena, el servidor exige ese token (`Authorization: Bearer`) y responde 401 si falta o no coincide. */
  token: string | undefined;
  /** Rol del token (`viewer` no puede escribir: 403). Solo cuenta si hay `token`. */
  role: 'viewer' | 'editor' | 'admin';
  name: string;
  /** Un servidor que arrancó sin `--workspace`: todo lo de `/api/projects` es 404. */
  noProjects: boolean;
  /** Con cuentas (inicio de sesión de GitHub): ver arriba. */
  accounts: boolean;
  /** Las sesiones abiertas: token → persona. Borrar una entrada es que caducó o se cerró. */
  sessions: Map<string, FakePerson>;
  /** Quién tiene acceso a cada proyecto (por id) y con qué rol. */
  members: Map<string, FakeMember[]>;
  /** Cuántas personas admite un proyecto (el servidor responde 409 `limit` al pasarse). */
  maxMembers: number;
  /** Cuántos proyectos puede administrar una persona que no sea administradora de la instancia (403 `limit` al pasarse). */
  maxProjects: number;
  /** Abre una sesión de esa persona sin pasar por GitHub y devuelve su token. */
  openSession(person: FakePerson): string;
  /** Un código de inicio de sesión como el que devuelve el servidor tras GitHub: `POST /api/auth/exchange` lo cambia por una sesión si el `verifier` corresponde al `challenge`. */
  issueCode(person: FakePerson, challenge: string): string;
  /** Da acceso a una persona a un proyecto (como si ya se lo hubieran compartido). */
  share(projectId: string, person: FakePerson | string, role: ProjectRole): void;
  /** Lo que respondió cada llamada a `exchange`, en orden (para comprobar que no se reintenta un código). */
  exchanges: number;
}

/** Una persona con cuenta en el servidor simulado. */
export interface FakePerson {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  /** Rol en la instancia (por omisión, `member`: crea proyectos). */
  siteRole?: 'admin' | 'member' | 'guest';
}

export interface FakeMember {
  login: string;
  role: ProjectRole;
  /** Invitada y todavía no ha entrado. */
  pending: boolean;
}

const STATUS: Record<ProjectErrorCode, number> = { 'not-found': 404, exists: 409, conflict: 409, invalid: 400, unavailable: 500, unauthorized: 401, forbidden: 403 };

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function fakeServer(options: Partial<Pick<FakeServer, 'token' | 'role' | 'name' | 'noProjects' | 'accounts' | 'maxMembers' | 'maxProjects'>> & { store?: ProjectStore } = {}): FakeServer {
  const people = new Map<string, FakePerson>();
  const codes = new Map<string, { person: FakePerson; challenge: string }>();
  const server: FakeServer = {
    store: options.store ?? new MemoryProjectStore(),
    log: [],
    down: false,
    corsBlocked: false,
    token: options.token,
    role: options.role ?? 'editor',
    name: options.name ?? 'Ana',
    noProjects: options.noProjects ?? false,
    accounts: options.accounts ?? false,
    sessions: new Map(),
    members: new Map(),
    maxMembers: options.maxMembers ?? 50,
    maxProjects: options.maxProjects ?? Infinity,
    exchanges: 0,
    fetch: undefined as unknown as typeof fetch,
    openSession(person) {
      people.set(person.login.toLowerCase(), person);
      const token = `iark_s_${randomBytes(16).toString('hex')}`;
      server.sessions.set(token, person);
      return token;
    },
    issueCode(person, challenge) {
      people.set(person.login.toLowerCase(), person);
      const code = randomBytes(12).toString('hex');
      codes.set(code, { person, challenge });
      return code;
    },
    share(projectId, person, role) {
      const login = typeof person === 'string' ? person : person.login;
      if (typeof person !== 'string') people.set(login.toLowerCase(), person);
      const list = (server.members.get(projectId) ?? []).filter((m) => !sameLogin(m.login, login));
      server.members.set(projectId, [...list, { login, role, pending: false }]);
    },
  };
  const publicUser = (person: FakePerson): Record<string, unknown> => ({ id: person.id, login: person.login, ...(person.name ? { name: person.name } : {}), ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}), siteRole: person.siteRole ?? 'member' });
  const memberView = (member: FakeMember, caller: FakePerson): Record<string, unknown> => {
    const person = people.get(member.login.toLowerCase());
    return { login: member.login, ...(person?.name ? { name: person.name } : {}), ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}), role: member.role, pending: member.pending && !person, ...(sameLogin(member.login, caller.login) ? { you: true } : {}) };
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    server.log.push(`${method} ${url.pathname}`);
    if (server.down) throw new TypeError('Failed to fetch');
    if (init.mode === 'no-cors') return new Response(null, { status: 200 }); // llega, pero opaca: no se puede leer
    if (server.corsBlocked) throw new TypeError('Failed to fetch');

    const headers = new Headers(init.headers);
    const authorization = headers.get('Authorization');
    const bearer = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    const caller = server.accounts && bearer ? server.sessions.get(bearer) : undefined;
    // Con cuentas hace falta una sesión (o el token de `--tokens`, si lo hay); sin ellas, como siempre: abierto o con el token único.
    const authorized = caller !== undefined || (server.accounts && server.token === undefined ? false : server.token === undefined || authorization === `Bearer ${server.token}`);
    const path = url.pathname;
    const unauthorized = (): Response => json(401, { error: 'Falta un token válido.', code: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    const bodyOf = (): Record<string, unknown> => (typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});

    if (path.startsWith('/api/auth/')) {
      if (!server.accounts) return json(404, { error: 'Ruta de la API desconocida. Ver /api/modules.' });
      if (path === '/api/auth/providers' && method === 'GET') return json(200, { providers: [{ id: 'github', label: 'GitHub' }], tokens: server.token !== undefined, signup: 'invite' });
      if (path === '/api/auth/exchange' && method === 'POST') {
        server.exchanges += 1;
        const { code, verifier } = bodyOf() as { code?: string; verifier?: string };
        const found = typeof code === 'string' ? codes.get(code) : undefined;
        if (typeof code === 'string') codes.delete(code); // se gasta en el primer intento
        const proof = typeof verifier === 'string' ? createHash('sha256').update(verifier, 'utf8').digest('base64url') : undefined;
        if (!found || proof !== found.challenge) return json(400, { error: 'El código de inicio de sesión no es válido o caducó: vuelve a iniciar sesión.', code: 'invalid-grant' });
        const token = server.openSession(found.person);
        return json(200, { token, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), user: publicUser(found.person) });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        if (!authorized) return unauthorized();
        if (!caller || !bearer) return json(400, { error: 'Este token no es una sesión: no se puede cerrar así.', code: 'not-a-session' });
        server.sessions.delete(bearer);
        return json(200, { loggedOut: true });
      }
      return json(404, { error: 'Ruta de autenticación desconocida. Ver /api/auth/providers.' });
    }

    if (path === '/api/whoami') {
      if (server.noProjects) return json(404, { error: 'No existe esa ruta.' });
      if (caller) return json(200, { auth: true, name: caller.name ?? caller.login, role: caller.siteRole ?? 'member', user: publicUser(caller) });
      if (server.token === undefined && !server.accounts) return json(200, { auth: false });
      if (!authorized) return unauthorized();
      return json(200, { auth: true, name: server.name, role: server.role });
    }
    if (!path.startsWith('/api/projects')) return json(404, { error: 'No existe esa ruta.' });
    if (server.noProjects) return json(404, { error: 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>).' });
    if (!authorized) return unauthorized();
    if (!caller && method !== 'GET' && server.role === 'viewer' && server.token !== undefined) return json(403, { error: 'Este token es de solo lectura.', code: 'forbidden' });

    const parts = path.split('/').slice(3).map(decodeURIComponent); // tras /api/projects
    const body = bodyOf();
    const store = server.store;
    const forbidden = (error: string): Response => json(403, { error, code: 'forbidden' });

    // Una persona con sesión solo ve los proyectos a los que pertenece, con su rol en cada uno; lo ajeno es como si no existiera.
    const roleIn = (projectId: string): ProjectRole | undefined => (caller ? server.members.get(projectId)?.find((m) => sameLogin(m.login, caller.login))?.role : undefined);
    const withRole = <T extends { id: string }>(project: T): T & { role?: ProjectRole } => (caller ? { ...project, role: roleIn(project.id) } : project);
    const missing = (projectId: string): Response => json(404, { error: `No existe el proyecto «${projectId}».`, code: 'not-found' });
    const rank = { viewer: 1, editor: 2, admin: 3 } as const;
    const needs = (projectId: string, wanted: ProjectRole): Response | undefined => {
      if (!caller) return undefined;
      const role = roleIn(projectId);
      if (!role) return missing(projectId);
      return rank[role] >= rank[wanted] ? undefined : forbidden(`El rol «${role}» no permite esta operación (hace falta «${wanted}»).`);
    };

    try {
      if (parts.length === 0) {
        if (method === 'GET') {
          const all = await store.listProjects();
          return json(200, caller ? all.filter((p) => roleIn(p.id)).map(withRole) : all);
        }
        if (method === 'POST') {
          if (caller) {
            if (caller.siteRole === 'guest') return forbidden('Tu cuenta no puede crear proyectos en esta instancia.');
            const administered = [...server.members.values()].filter((list) => list.some((m) => sameLogin(m.login, caller.login) && m.role === 'admin')).length;
            if (caller.siteRole !== 'admin' && administered >= server.maxProjects) return json(403, { error: `Ya administras ${server.maxProjects} proyectos, el máximo por persona en esta instancia.`, code: 'limit' });
          }
          const created = await store.createProject({ name: String(body.name), description: body.description as string | undefined });
          if (caller) server.members.set(created.id, [{ login: caller.login, role: 'admin', pending: false }]);
          return json(201, withRole(created));
        }
      } else if (parts.length === 1) {
        if (method === 'GET') {
          const denied = needs(parts[0], 'viewer');
          if (denied) return denied;
          const project = await store.getProject(parts[0]);
          return project ? json(200, withRole(project)) : json(404, { error: `No existe el proyecto «${parts[0]}».`, code: 'not-found' });
        }
        if (method === 'PATCH') return needs(parts[0], 'editor') ?? json(200, withRole(await store.renameProject(parts[0], String(body.name))));
        if (method === 'DELETE') {
          const denied = needs(parts[0], 'admin');
          if (denied) return denied;
          await store.deleteProject(parts[0]);
          server.members.delete(parts[0]);
          return json(200, { ok: true });
        }
      } else if (parts[1] === 'members' && server.accounts && caller) {
        const list = server.members.get(parts[0]) ?? [];
        if (parts.length === 2 && method === 'GET') {
          return needs(parts[0], 'viewer') ?? json(200, list.map((m) => memberView(m, caller)));
        }
        if (parts.length === 3) {
          const login = parts[2];
          const existing = list.find((m) => sameLogin(m.login, login));
          const admins = list.filter((m) => m.role === 'admin');
          if (method === 'PUT') {
            const denied = needs(parts[0], 'admin');
            if (denied) return denied;
            if (!GITHUB_LOGIN.test(login)) return json(400, { error: `«${login.slice(0, 60)}» no es un nombre de usuario de GitHub válido.`, code: 'invalid' });
            const role = body.role;
            if (role !== 'viewer' && role !== 'editor' && role !== 'admin') return json(400, { error: 'El rol debe ser viewer, editor o admin.', code: 'invalid' });
            if (existing) {
              if (existing.role === 'admin' && role !== 'admin' && admins.length === 1) return json(409, { error: 'No se puede degradar al último administrador del proyecto.', code: 'last-admin' });
              existing.role = role;
              return json(200, memberView(existing, caller));
            }
            if (list.length >= server.maxMembers) return json(409, { error: `Un proyecto admite hasta ${server.maxMembers} personas.`, code: 'limit' });
            const added: FakeMember = { login, role, pending: true };
            server.members.set(parts[0], [...list, added]);
            return json(201, memberView(added, caller));
          }
          if (method === 'DELETE') {
            const self = sameLogin(login, caller.login);
            const denied = needs(parts[0], self ? 'viewer' : 'admin');
            if (denied) return denied;
            if (!existing) return json(404, { error: `«${login}» no tiene acceso a este proyecto.`, code: 'not-found' });
            if (existing.role === 'admin' && admins.length === 1) return json(409, { error: 'No se puede quitar al último administrador del proyecto.', code: 'last-admin' });
            server.members.set(parts[0], list.filter((m) => m !== existing));
            return json(200, { removed: existing.login });
          }
        }
      } else if (parts[1] === 'diagrams') {
        if (parts.length === 2 && method === 'POST') return needs(parts[0], 'editor') ?? json(201, await store.saveDiagram(parts[0], { module: body.module as string, name: body.name as string | undefined, text: String(body.text) }));
        if (parts.length === 3) {
          if (method === 'GET') {
            const denied = needs(parts[0], 'viewer');
            if (denied) return denied;
            const diagram = await store.getDiagram(parts[0], parts[2]);
            return diagram ? json(200, diagram) : json(404, { error: `No existe el diagrama «${parts[2]}».`, code: 'not-found' });
          }
          if (method === 'PUT') return needs(parts[0], 'editor') ?? json(200, await store.saveDiagram(parts[0], { id: parts[2], text: String(body.text), ifUpdatedAt: body.ifUpdatedAt as string | undefined }));
          if (method === 'PATCH') return needs(parts[0], 'editor') ?? json(200, await store.renameDiagram(parts[0], parts[2], String(body.name)));
          if (method === 'DELETE') {
            const denied = needs(parts[0], 'editor');
            if (denied) return denied;
            await store.deleteDiagram(parts[0], parts[2]);
            return json(200, { ok: true });
          }
        }
      }
      return json(404, { error: 'No existe esa ruta.' });
    } catch (error) {
      if (error instanceof ProjectError) return json(STATUS[error.code], { error: error.message, code: error.code });
      throw error;
    }
  }) as typeof fetch;
  return server;
}
