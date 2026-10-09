import type { IncomingMessage, ServerResponse } from 'node:http';
import { allow, bodyObject, type ReadBody } from '../httpBody';
import { HttpError } from '../httpError';
import type { Accounts } from './service';
import { isProjectRole, loginKey, PROJECT_ROLES, type AccountUser, type ProjectRole } from './store';

/**
 * Quién pertenece a un proyecto (`/api/projects/<p>/members`, con `--accounts`). El rol mínimo de cada operación lo decide
 * `requiredRole` y `scopeFor` (en `serveProjects.ts`) antes de llegar aquí; esto solo ejecuta.
 *
 *   GET    /api/projects/<p>/members            viewer o más → Member[] (administradores primero)
 *   PUT    /api/projects/<p>/members/<login>    admin del proyecto · { role } → Member (201 si es nuevo, 200 si cambió el rol)
 *   DELETE /api/projects/<p>/members/<login>    admin del proyecto, o la propia persona para irse → { removed: "<login>" }
 *
 * `Member` = `{ login, name?, avatarUrl?, role, pending, you? }`: `pending` es una invitación que todavía no ha entrado, y `you` marca a quien llama.
 * Compartir con un nombre de usuario sin cuenta crea una invitación que se reclama al entrar (con rol `guest` en la instancia si es solo por
 * invitación, `member` si está abierta). Un proyecto no se queda sin administrador: 409 `last-admin`; el tope de personas por proyecto, 409 `limit`.
 */

export interface MemberJson {
  login: string;
  name?: string;
  avatarUrl?: string;
  role: ProjectRole;
  /** Invitada por nombre de usuario y todavía sin haber entrado. */
  pending: boolean;
  /** Es la persona que llama. */
  you?: true;
}

export function memberJson(user: AccountUser, role: ProjectRole, youId?: string): MemberJson {
  return {
    login: user.login,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    role,
    pending: user.githubId === undefined,
    ...(youId !== undefined && user.id === youId ? { you: true as const } : {}),
  };
}

export interface MembersApiContext {
  /** Sin cuentas, todas las rutas responden 404: los miembros solo existen con `--accounts`. */
  accounts: Accounts | undefined;
  readBody: ReadBody;
  sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void;
}

/**
 * El manejador de `/api/projects/<p>/members…`. `rest` son los segmentos tras `members`; `youId` es el id de la cuenta de quien llama
 * (con un token o sin autenticación, `undefined`). El proyecto ya se comprobó que existe.
 */
export function createMembersApi(ctx: MembersApiContext): (req: IncomingMessage, res: ServerResponse, projectId: string, rest: string[], youId: string | undefined) => Promise<void> {
  return async (req, res, projectId, rest, youId) => {
    const { accounts, sendJson } = ctx;
    if (!accounts) throw new HttpError(404, 'Este servicio no tiene cuentas de GitHub: los miembros de un proyecto solo existen con --accounts.');
    const method = req.method ?? 'GET';
    const store = accounts.store;

    if (rest.length === 0) {
      if (method !== 'GET') return allow('GET');
      return sendJson(res, 200, (await store.membersOf(projectId)).map((m) => memberJson(m.user, m.role, youId)));
    }
    if (rest.length > 1) throw new HttpError(404, 'Ruta de miembros desconocida: use /members o /members/<usuario de GitHub>.');
    const login = rest[0];
    const shown = login.slice(0, 60);

    if (method === 'PUT') {
      const role = (await bodyObject(ctx.readBody, req)).role;
      if (!isProjectRole(role)) throw new HttpError(400, `Falta "role": use ${PROJECT_ROLES.join(', ')}.`, { code: 'invalid' });
      const { user, added } = await store.shareProject(projectId, login, role, accounts.signup === 'open' ? 'member' : 'guest');
      return sendJson(res, added ? 201 : 200, memberJson(user, role, youId), added ? { Location: `/api/projects/${projectId}/members/${encodeURIComponent(user.login)}` } : {});
    }
    if (method === 'DELETE') {
      // Se busca entre los miembros (no se valida el nombre): así también se puede quitar una cuenta apartada con `nombre~id`.
      const target = (await store.membersOf(projectId)).find((m) => loginKey(m.user.login) === loginKey(login));
      if (!target) throw new HttpError(404, `«${shown}» no pertenece a este proyecto.`, { code: 'not-found' });
      await store.removeMember(projectId, target.user.id);
      return sendJson(res, 200, { removed: target.user.login });
    }
    return allow('PUT, DELETE');
  };
}
