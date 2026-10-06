import type { IncomingMessage, ServerResponse } from 'node:http';
import { allow, bodyObject, isJson, type ReadBody } from '../httpBody';
import { HttpError } from '../httpError';
import type { Authenticator, Identity } from '../serveAuth';
import { accountHttpError } from './errors';
import type { Accounts } from './service';
import { AccountError, isSiteRole, parseLogin, SITE_ROLES, type AccountUser, type SiteRole, type UserChange } from './store';

/**
 * Administración de las cuentas de la instancia (`/api/admin`, con `--accounts`). Solo para quien administra la instancia: una persona con
 * rol `admin` (por figurar en `--admins`, o porque otro administrador se lo dio) o un token de `--tokens` con rol `admin`; los demás, 403.
 *
 *   GET    /api/admin/users             → [{ id, login, name?, avatarUrl?, siteRole, disabled, pending, listed?, createdAt, lastLoginAt?, projects }]
 *   PUT    /api/admin/users/<login>     { siteRole?, disabled? } → la cuenta (201 si crea una invitación, 200 si cambia una que ya existe)
 *   DELETE /api/admin/users/<login>     cancela la invitación de quien todavía no ha entrado → { removed: "<login>" }
 *
 * `siteRole` es el rol que tiene ahora (`admin`, `member` o `guest`); `pending`, una invitación sin reclamar; `listed`, que figura en `--admins`
 * (su rol lo manda la lista y no se puede bajar desde aquí); `projects`, a cuántos proyectos pertenece. Con un nombre de usuario que no existe,
 * `PUT` crea una invitación (rol `member` por omisión) que reclamará quien entre con ese nombre. Desactivar una cuenta cierra sus sesiones.
 * Nadie puede cambiar su propio rol ni desactivarse a sí mismo (409 `self`), ni bajar de rol o desactivar a una persona de `--admins` (409 `listed-admin`).
 */

export interface AdminUserJson {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  siteRole: SiteRole;
  disabled: boolean;
  pending: boolean;
  listed?: true;
  createdAt: string;
  lastLoginAt?: string;
  projects: number;
}

export interface AdminApiContext {
  accounts: Accounts | undefined;
  auth: Authenticator | undefined;
  readBody: ReadBody;
  sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void;
}

function adminUserJson(accounts: Accounts, user: AccountUser, projects: number): AdminUserJson {
  return {
    id: user.id,
    login: user.login,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    siteRole: accounts.siteRoleOf(user),
    disabled: !!user.disabled,
    pending: user.githubId === undefined,
    ...(accounts.isListedAdmin(user) ? { listed: true as const } : {}),
    createdAt: user.createdAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    projects,
  };
}

/** ¿Administra la instancia? Un token con rol `admin` o una persona con rol `admin`. */
const isInstanceAdmin = (identity: Identity): boolean => (identity.kind === 'token' ? identity.role === 'admin' : identity.siteRole === 'admin');

export function createAdminApi(ctx: AdminApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  const { sendJson } = ctx;

  async function route(accounts: Accounts, identity: Identity, req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const method = req.method ?? 'GET';
    const store = accounts.store;
    if (parts[0] !== 'users' || parts.length > 2) throw new HttpError(404, 'Ruta de administración desconocida: use /api/admin/users o /api/admin/users/<usuario de GitHub>.');

    if (parts.length === 1) {
      if (method !== 'GET') return allow('GET');
      const counts = store.membershipCounts();
      const users = store.users().sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }));
      return sendJson(res, 200, users.map((u) => adminUserJson(accounts, u, counts.get(u.id) ?? 0)));
    }

    const login = parts[1];
    if (method === 'PUT') {
      const body = await bodyObject(ctx.readBody, req);
      const change: UserChange = {};
      if (body.siteRole !== undefined) {
        if (!isSiteRole(body.siteRole)) throw new HttpError(400, `"siteRole" debe ser ${SITE_ROLES.join(', ')}.`, { code: 'invalid' });
        change.siteRole = body.siteRole;
      }
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== 'boolean') throw new HttpError(400, '"disabled" debe ser verdadero o falso.', { code: 'invalid' });
        change.disabled = body.disabled;
      }
      const existing = store.findByLogin(parseLogin(login));
      if (existing) {
        const stored = existing.siteRole;
        const lowers = (change.siteRole !== undefined && change.siteRole !== 'admin') || change.disabled === true;
        if (accounts.isListedAdmin(existing) && lowers) {
          throw new HttpError(409, `«${existing.login}» figura en la lista de administradores de la instancia (--admins): su rol y su acceso los manda esa lista.`, { code: 'listed-admin' });
        }
        if (identity.kind === 'user' && identity.user.id === existing.id && (change.disabled === true || (change.siteRole !== undefined && change.siteRole !== stored))) {
          throw new HttpError(409, 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta: que lo haga otra persona administradora.', { code: 'self' });
        }
      }
      const { user, created } = store.upsertUser(login, change);
      const projects = store.membershipCounts().get(user.id) ?? 0;
      return sendJson(res, created ? 201 : 200, adminUserJson(accounts, user, projects), created ? { Location: `/api/admin/users/${encodeURIComponent(user.login)}` } : {});
    }
    if (method === 'DELETE') {
      const user = store.findByLogin(parseLogin(login));
      if (!user) throw new HttpError(404, `No existe la cuenta «${login.slice(0, 60)}».`, { code: 'not-found' });
      store.removePending(user.id);
      return sendJson(res, 200, { removed: user.login });
    }
    return allow('PUT, DELETE');
  }

  return async (req, res, _url, parts) => {
    const { accounts, auth } = ctx;
    if (!accounts || !auth) throw new HttpError(404, 'Este servicio no tiene cuentas de GitHub: la administración de cuentas solo existe con --accounts.');
    const identity = auth.identify(req);
    if (!isInstanceAdmin(identity)) throw new HttpError(403, 'Solo quien administra la instancia puede ver y cambiar las cuentas.', { code: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isJson(req)) throw new HttpError(415, 'Las operaciones que modifican cuentas exigen Content-Type: application/json.');
    try {
      await route(accounts, identity, req, res, parts);
    } catch (error) {
      throw error instanceof AccountError ? accountHttpError(error) : error;
    }
  };
}
