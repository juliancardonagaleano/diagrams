import { createHash, randomBytes } from 'node:crypto';
import { isVersioned, MemoryProjectStore, parseVersionId, ProjectError, type ProjectErrorCode, type ProjectRole, type ProjectStore, type SiteRole } from '@iark/kernel';

/**
 * Apoyo de las pruebas: un `fetch` simulado que se comporta como la API `/api/projects` de `iark serve --workspace` (rutas,
 * códigos y cuerpos de error), sobre un almacén en memoria, con interruptores para provocar lo que pasa en la vida real:
 * red caída, un token que el servidor no acepta, un rol que no puede escribir, un servidor sin proyectos o un origen que el
 * navegador rechaza por CORS. No lo usa la aplicación.
 *
 * Con `accounts: true` se comporta además como un servidor con inicio de sesión de GitHub (`iark serve --accounts`): `/api/auth/…`
 * (providers, exchange con PKCE, logout), sesiones de persona (`iark_s_…`), proyectos por pertenencia con su `role` (lo ajeno es 404) y
 * compartir (`/api/projects/<p>/members`) y la administración de la instancia (`/api/admin/users`: cuentas, invitaciones, roles y desactivar, con los
 * mismos 403, 409 `self` y `listed-admin` y 404 que el servidor de verdad). Sin `accounts`, esas rutas dan 404 como en un servidor anterior a las cuentas.
 *
 * El historial de versiones (`/api/projects/<p>/diagrams/<d>/versions…`) lo sirve el propio almacén si guarda versiones (por omisión, el de
 * memoria sí) con los mismos roles que el servidor (`viewer` lee, `editor` restaura y nombra, `admin` borra las nombradas) y deja en cada versión
 * quién guardó (`@usuario` o el nombre del token). Con un almacén que no las guarda, esas rutas dan 404 sin `code`, como un servidor anterior al historial.
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
  /** Las cuentas de la instancia, por orden de creación: las personas que entraron (con `openSession` o `issueCode`) y las invitaciones. */
  directory: FakeAccount[];
  /** Cuántas invitaciones sin reclamar admite la instancia (el servidor responde 409 `limit` al pasarse). */
  maxPending: number;
  /** Añade una cuenta ya existente (que entró, o una invitación con `pending: true`) sin pasar por GitHub. */
  addAccount(account: Partial<FakeAccount> & { login: string }): FakeAccount;
  /** Los cambios en tiempo real: ver `FakeEvents`. */
  events: FakeEvents;
  /** Responde con ese estado y cuerpo a las próximas `times` peticiones que coincidan (`MÉTODO /ruta`), sin llegar a la lógica del servidor. */
  inject(match: RegExp, status: number, body: unknown, times?: number, headers?: Record<string, string>): void;
}

/**
 * El canal de cambios en tiempo real (`GET /api/events`) del servidor simulado. Por omisión **no lo ofrece** (404, como un servidor anterior): las pruebas que lo
 * quieren ponen `supported = true` antes de crear la sesión, y mandan los avisos a mano con `emit` (el servidor simulado no los deduce de las escrituras: así
 * cada prueba decide qué llega, cuándo y en qué orden, incluida la carrera en que el aviso llega antes que la respuesta del guardado).
 */
export interface FakeEvents {
  supported: boolean;
  /** Canales abiertos ahora mismo. */
  readonly open: number;
  /** Cuántas veces se intentó abrir el canal (con o sin éxito). */
  attempts: number;
  /** Los milisegundos entre latidos que anuncia `ready`; el cliente da por muerta la conexión tras tres latidos sin noticias. Por omisión, una hora (las pruebas no mandan latidos a mano). */
  heartbeatMs: number;
  /** Qué se envía al abrir: el mensaje `ready` (por omisión sí; sin él, el cliente no sabe que está en directo). */
  sendReady: boolean;
  /** Manda un aviso de cambio (`event: change`) a los canales abiertos. */
  emit(event: { type: string; project: string; diagram?: string; updatedAt?: string; by?: string }): void;
  /** Manda un latido (comentario). */
  heartbeat(): void;
  /** Cierra los canales como un corte de red (el lector falla). */
  drop(): void;
  /** El servidor cierra los canales con un `bye`. */
  bye(reason: 'unauthorized' | 'shutdown'): void;
  /** Escribe texto crudo en los canales (para probar mensajes raros). */
  write(text: string): void;
}

/** Una cuenta de la instancia en el servidor simulado (lo que `GET /api/admin/users` cuenta de ella, menos el número de proyectos, que se deduce de `members`). */
export interface FakeAccount {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  siteRole: SiteRole;
  disabled: boolean;
  /** Invitación sin reclamar: esa persona aún no ha entrado. */
  pending: boolean;
  /** Figura en `--admins`: su rol y su acceso los manda esa lista. */
  listed?: boolean;
  createdAt: string;
  lastLoginAt?: string;
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

const STATUS: Record<ProjectErrorCode, number> = { 'not-found': 404, exists: 409, conflict: 409, invalid: 400, unavailable: 500, unauthorized: 401, forbidden: 403, unsupported: 501 };

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** El nombre de usuario que acepta la administración de cuentas del servidor (`src/cli/accounts/store.ts`). */
const INSTANCE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_])){0,38}$/;
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function fakeServer(options: Partial<Pick<FakeServer, 'token' | 'role' | 'name' | 'noProjects' | 'accounts' | 'maxMembers' | 'maxProjects' | 'maxPending'>> & { store?: ProjectStore } = {}): FakeServer {
  const people = new Map<string, FakePerson>();
  const codes = new Map<string, { person: FakePerson; challenge: string }>();
  const injected: Array<{ match: RegExp; status: number; body: unknown; times: number; headers?: Record<string, string> }> = [];
  let accountSeq = 0;
  const channels = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const push = (text: string): void => {
    for (const channel of channels) channel.enqueue(encoder.encode(text));
  };
  const events: FakeEvents = {
    supported: false,
    get open() {
      return channels.size;
    },
    attempts: 0,
    heartbeatMs: 3_600_000,
    sendReady: true,
    emit: (event) => push(`event: change\ndata: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`),
    heartbeat: () => push(': hb\n\n'),
    drop: () => {
      for (const channel of [...channels]) {
        channels.delete(channel);
        channel.error(new TypeError('network error'));
      }
    },
    bye: (reason) => {
      push(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
      for (const channel of [...channels]) {
        channels.delete(channel);
        channel.close();
      }
    },
    write: push,
  };
  const server: FakeServer = {
    events,
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
    maxPending: options.maxPending ?? 500,
    exchanges: 0,
    directory: [],
    fetch: undefined as unknown as typeof fetch,
    addAccount(account) {
      const existing = server.directory.find((a) => sameLogin(a.login, account.login));
      if (existing) return Object.assign(existing, account);
      const created: FakeAccount = { id: `u_fake${++accountSeq}`, siteRole: 'member', disabled: false, pending: false, createdAt: new Date().toISOString(), ...account };
      if (!created.pending && !created.lastLoginAt) created.lastLoginAt = created.createdAt;
      server.directory.push(created);
      return created;
    },
    inject(match, status, body, times = 1, headers) {
      injected.push({ match, status, body, times, headers });
    },
    openSession(person) {
      signIn(person);
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
  /** Una persona entra: su cuenta existe (o reclama la invitación hecha a su nombre, con el rol de la invitación) y queda como la última vez que entró. */
  const signIn = (person: FakePerson): void => {
    const found = server.directory.find((a) => sameLogin(a.login, person.login));
    const account = found ?? server.addAccount({ login: person.login, siteRole: person.siteRole ?? 'member' });
    if (!found || found.pending || found.id.startsWith('u_fake')) account.id = person.id;
    account.login = person.login;
    account.pending = false;
    account.lastLoginAt = new Date().toISOString();
    if (person.name) account.name = person.name;
    if (person.avatarUrl) account.avatarUrl = person.avatarUrl;
  };
  /** El rol de la instancia que tiene ahora una persona: el de su cuenta (un administrador pudo cambiarlo) y, si no tiene, el que traía. */
  const siteRoleOf = (person: FakePerson): SiteRole => server.directory.find((a) => sameLogin(a.login, person.login))?.siteRole ?? person.siteRole ?? 'member';
  const publicUser = (person: FakePerson): Record<string, unknown> => ({ id: person.id, login: person.login, ...(person.name ? { name: person.name } : {}), ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}), siteRole: siteRoleOf(person) });
  const memberView = (member: FakeMember, caller: FakePerson): Record<string, unknown> => {
    const person = people.get(member.login.toLowerCase());
    return { login: member.login, ...(person?.name ? { name: person.name } : {}), ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}), role: member.role, pending: member.pending && !person, ...(sameLogin(member.login, caller.login) ? { you: true } : {}) };
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const adminJson = (account: FakeAccount): Record<string, unknown> => ({
    id: account.id,
    login: account.login,
    ...(account.name ? { name: account.name } : {}),
    ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    siteRole: account.siteRole,
    disabled: account.disabled,
    pending: account.pending,
    ...(account.listed ? { listed: true } : {}),
    createdAt: account.createdAt,
    ...(account.lastLoginAt ? { lastLoginAt: account.lastLoginAt } : {}),
    projects: [...server.members.values()].filter((list) => list.some((m) => sameLogin(m.login, account.login))).length,
  });
  const SITE_ROLES: readonly string[] = ['admin', 'member', 'guest'];

  /** `/api/admin/users` con las mismas reglas que el servidor de verdad (`src/cli/accounts/admin.ts`). */
  const adminUsers = (method: string, parts: string[], body: Record<string, unknown>, caller: FakePerson | undefined): Response => {
    if (parts[0] !== 'users' || parts.length > 2) return json(404, { error: 'Ruta de administración desconocida: use /api/admin/users o /api/admin/users/<usuario de GitHub>.' });
    if (parts.length === 1) {
      if (method !== 'GET') return json(405, { error: 'Método no permitido: use GET.' });
      return json(200, [...server.directory].sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' })).map(adminJson));
    }
    const login = parts[1];
    const existing = server.directory.find((a) => sameLogin(a.login, login));
    if (method === 'PUT') {
      if (body.siteRole !== undefined && (typeof body.siteRole !== 'string' || !SITE_ROLES.includes(body.siteRole))) return json(400, { error: `"siteRole" debe ser ${SITE_ROLES.join(', ')}.`, code: 'invalid' });
      if (body.disabled !== undefined && typeof body.disabled !== 'boolean') return json(400, { error: '"disabled" debe ser verdadero o falso.', code: 'invalid' });
      if (!INSTANCE_LOGIN.test(login)) return json(400, { error: `«${login.slice(0, 60)}» no es un nombre de usuario de GitHub (letras, números y guiones, hasta 39 caracteres).`, code: 'invalid' });
      const siteRole = body.siteRole as SiteRole | undefined;
      if (existing) {
        const lowers = (siteRole !== undefined && siteRole !== 'admin') || body.disabled === true;
        if (existing.listed && lowers) return json(409, { error: `«${existing.login}» figura en la lista de administradores de la instancia (--admins): su rol y su acceso los manda esa lista.`, code: 'listed-admin' });
        if (caller && sameLogin(existing.login, caller.login) && (body.disabled === true || (siteRole !== undefined && siteRole !== existing.siteRole))) {
          return json(409, { error: 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta: que lo haga otra persona administradora.', code: 'self' });
        }
      } else if (server.directory.filter((a) => a.pending).length >= server.maxPending) {
        return json(409, { error: `Hay ${server.maxPending} invitaciones sin aceptar: hace falta que alguien entre o que un administrador las cancele.`, code: 'limit' });
      }
      const account = existing ?? server.addAccount({ login, pending: true, siteRole: 'member' });
      if (siteRole !== undefined) account.siteRole = siteRole;
      if (typeof body.disabled === 'boolean') {
        account.disabled = body.disabled;
        // desactivar una cuenta cierra sus sesiones
        if (body.disabled) for (const [token, person] of [...server.sessions]) if (sameLogin(person.login, account.login)) server.sessions.delete(token);
      }
      return json(existing ? 200 : 201, adminJson(account), existing ? {} : { Location: `/api/admin/users/${encodeURIComponent(account.login)}` });
    }
    if (method === 'DELETE') {
      if (!existing) return json(404, { error: `No existe la cuenta «${login.slice(0, 60)}».`, code: 'not-found' });
      if (!existing.pending) return json(409, { error: 'Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.', code: 'conflict' });
      server.directory.splice(server.directory.indexOf(existing), 1);
      for (const [projectId, list] of server.members) server.members.set(projectId, list.filter((m) => !sameLogin(m.login, existing.login)));
      return json(200, { removed: existing.login });
    }
    return json(405, { error: 'Método no permitido: use PUT, DELETE.' });
  };

  server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    server.log.push(`${method} ${url.pathname}`);
    if (server.down) throw new TypeError('Failed to fetch');
    const forced = injected.find((entry) => entry.match.test(`${method} ${url.pathname}`));
    if (forced) {
      forced.times -= 1;
      if (forced.times <= 0) injected.splice(injected.indexOf(forced), 1);
      return json(forced.status, forced.body, forced.headers);
    }
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

    if (path === '/api/events') {
      events.attempts += 1;
      if (!events.supported || server.noProjects) return json(404, { error: 'Ruta de la API desconocida. Ver /api/modules.' });
      if (!authorized) return unauthorized();
      let channel: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          channel = controller;
          channels.add(controller);
          if (events.sendReady) controller.enqueue(encoder.encode(`retry: 5000\nevent: ready\ndata: {"heartbeatMs":${events.heartbeatMs}}\n\n`));
        },
        cancel() {
          if (channel) channels.delete(channel);
        },
      });
      // Un `fetch` abortado falla en la lectura, como el de verdad.
      init.signal?.addEventListener('abort', () => {
        if (!channel || !channels.delete(channel)) return;
        try {
          channel.error(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        } catch {
          /* ya cerrado */
        }
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    }
    if (path === '/api/whoami') {
      if (server.noProjects) return json(404, { error: 'No existe esa ruta.' });
      if (caller) return json(200, { auth: true, name: caller.name ?? caller.login, role: siteRoleOf(caller), user: publicUser(caller) });
      if (server.token === undefined && !server.accounts) return json(200, { auth: false });
      if (!authorized) return unauthorized();
      return json(200, { auth: true, name: server.name, role: server.role });
    }
    if (path.startsWith('/api/admin/')) {
      if (!server.accounts) return json(404, { error: 'Este servicio no tiene cuentas de GitHub: la administración de cuentas solo existe con --accounts.' });
      if (!authorized) return unauthorized();
      // Quien administra la instancia: una persona con rol `admin` o el token de `--tokens` con rol `admin`.
      if (!(caller ? siteRoleOf(caller) === 'admin' : server.role === 'admin')) return json(403, { error: 'Solo quien administra la instancia puede ver y cambiar las cuentas.', code: 'forbidden' });
      return adminUsers(method, path.split('/').slice(3).map(decodeURIComponent), bodyOf(), caller);
    }
    if (!path.startsWith('/api/projects')) return json(404, { error: 'No existe esa ruta.' });
    if (server.noProjects) return json(404, { error: 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>).' });
    if (!authorized) return unauthorized();
    if (!caller && method !== 'GET' && server.role === 'viewer' && server.token !== undefined) return json(403, { error: 'Este token es de solo lectura.', code: 'forbidden' });

    const parts = path.split('/').slice(3).map(decodeURIComponent); // tras /api/projects
    const body = bodyOf();
    const store = server.store;
    const forbidden = (error: string): Response => json(403, { error, code: 'forbidden' });
    // Quién guarda, para el historial: la persona con sesión o el nombre del token (sin credenciales no se sabe).
    const actor = caller ? `@${caller.login}` : server.token !== undefined ? server.name : undefined;

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
            if (siteRoleOf(caller) === 'guest') return forbidden('Tu cuenta no puede crear proyectos en esta instancia.');
            const administered = [...server.members.values()].filter((list) => list.some((m) => sameLogin(m.login, caller.login) && m.role === 'admin')).length;
            if (siteRoleOf(caller) !== 'admin' && administered >= server.maxProjects) return json(403, { error: `Ya administras ${server.maxProjects} proyectos, el máximo por persona en esta instancia.`, code: 'limit' });
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
        if (parts[3] === 'versions' && parts.length >= 4 && parts.length <= 6) {
          if (!isVersioned(store)) return json(404, { error: 'No existe esa ruta.' }); // un servidor anterior al historial
          const [projectId, , diagramId, , rawVersion, action] = parts;
          const wanted: ProjectRole = method === 'GET' ? 'viewer' : method === 'DELETE' ? 'admin' : 'editor';
          const denied = needs(projectId, wanted);
          if (denied) return denied;
          // Con un token, el rol es el del token: borrar una versión con nombre exige `admin`.
          if (!caller && server.token !== undefined && method === 'DELETE' && server.role !== 'admin') return forbidden(`El rol «${server.role}» no permite esta operación (hace falta «admin»).`);
          if (parts.length === 4) return method === 'GET' ? json(200, await store.listVersions(projectId, diagramId)) : json(405, { error: 'Método no permitido: use GET.' });
          const id = parseVersionId(rawVersion);
          if (id === undefined) return json(400, { error: `Identificador de versión inválido «${String(rawVersion).slice(0, 40)}».`, code: 'invalid' });
          if (parts.length === 5) {
            if (method === 'GET') {
              const version = await store.getVersion(projectId, diagramId, id);
              return version ? json(200, version) : json(404, { error: `No existe la versión ${id}.`, code: 'not-found' });
            }
            if (method === 'PATCH') return json(200, await store.labelVersion(projectId, diagramId, id, body.label as string));
            if (method === 'DELETE') {
              await store.deleteVersion(projectId, diagramId, id);
              return json(200, { deleted: id });
            }
          }
          if (parts.length === 6 && action === 'restore' && method === 'POST') return json(200, await store.restoreVersion(projectId, diagramId, id, { ifUpdatedAt: body.ifUpdatedAt as string | undefined, by: actor }));
          return json(404, { error: 'Ruta de proyectos desconocida.' });
        }
        if (parts.length === 2 && method === 'POST') return needs(parts[0], 'editor') ?? json(201, await store.saveDiagram(parts[0], { module: body.module as string, name: body.name as string | undefined, text: String(body.text), by: actor }));
        if (parts.length === 3) {
          if (method === 'GET') {
            const denied = needs(parts[0], 'viewer');
            if (denied) return denied;
            const diagram = await store.getDiagram(parts[0], parts[2]);
            return diagram ? json(200, diagram) : json(404, { error: `No existe el diagrama «${parts[2]}».`, code: 'not-found' });
          }
          if (method === 'PUT') return needs(parts[0], 'editor') ?? json(200, await store.saveDiagram(parts[0], { id: parts[2], text: String(body.text), ifUpdatedAt: body.ifUpdatedAt as string | undefined, by: actor }));
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
      if (error instanceof ProjectError && error.info.serverCode === 'limit') return json(409, { error: error.message, code: 'limit' }); // el tope de versiones con nombre
      if (error instanceof ProjectError) return json(STATUS[error.code], { error: error.message, code: error.code });
      throw error;
    }
  }) as typeof fetch;
  return server;
}
