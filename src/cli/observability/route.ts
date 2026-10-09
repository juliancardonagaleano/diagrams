import { COMPUTE_ACTIONS } from '../compute';
import { isWorkspaceId } from '../workspace';

/**
 * Convierte la ruta de una petición en una **plantilla** de un conjunto cerrado y pequeño (`/api/projects/:project/diagrams/:diagram`):
 * es lo que llevan el registro de accesos y las métricas en lugar de la ruta real. Así los identificadores de proyecto, de diagrama y de
 * persona no se escriben en el registro de accesos, la cardinalidad de las métricas no depende de lo que escriba quien llama (un
 * escáner que pide mil rutas distintas da una sola plantilla) y nada de lo que llega por la URL puede colarse en un registro.
 *
 * Replica el reparto de `serve.ts` (primero `/api/projects`, `/api/auth` y `/api/admin`; luego `whoami`, `modules`, `trace`; el resto
 * es `/api/<módulo>/<acción>`), con las mismas reglas de segmentos (vacíos fuera, decodificados). Una forma que el servidor no conoce
 * recibe una plantilla con `*` (`/api/projects/*`, `/api/*`) en vez de la ruta real. Los parámetros que sí se devuelven (`params`, para la
 * auditoría) solo salen si son identificadores válidos: nunca texto libre.
 */

export interface RouteParams {
  project?: string;
  diagram?: string;
  /** Un nombre de usuario de GitHub (o de una cuenta apartada, `nombre~id`) en las rutas de miembros y de cuentas. */
  login?: string;
}

export interface RouteInfo {
  /** La plantilla: un conjunto cerrado de unas decenas de valores. */
  template: string;
  params: RouteParams;
  /** Exige credencial cuando hay autenticación: proyectos, administración, `whoami` y el cierre de sesión. */
  protected: boolean;
  /** Es una operación de cálculo (validar, exportar, importar, comparar, informes y trazas). */
  compute: boolean;
  /** `/healthz`, `/readyz` o `/metrics`: las comprueban máquinas cada pocos segundos. */
  operational: boolean;
}

/** Un nombre de usuario de GitHub, o el de una cuenta apartada (`ana~583231`). Acotado: no es texto libre. */
const LOGIN = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,38})(?:~[A-Za-z0-9_-]{1,40})?$/;
const loginOf = (value: string | undefined): string | undefined => (value !== undefined && LOGIN.test(value) ? value : undefined);
const idOf = (value: string | undefined): string | undefined => (isWorkspaceId(value) ? value : undefined);

const OPERATIONAL = new Set(['/healthz', '/readyz', '/metrics']);

const route = (template: string, extra: Partial<Omit<RouteInfo, 'template'>> = {}): RouteInfo => ({ template, params: {}, protected: false, compute: false, operational: false, ...extra });

/** Los segmentos de una ruta, decodificados como en `serve.ts`; uno mal codificado se queda como está (la petición dará 400 y la plantilla no lo usa). */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function projectsRoute(method: string, parts: string[]): RouteInfo {
  const [, second, third, fourth] = parts;
  const base = { protected: true } as const;
  if (parts.length === 1) return route('/api/projects', base);
  if (parts.length === 2 && second === 'import' && method === 'POST') return route('/api/projects/import', base);
  const project = idOf(second);
  if (parts.length === 2) return route('/api/projects/:project', { ...base, params: { project } });
  if (parts.length === 3 && (third === 'diagrams' || third === 'bundle' || third === 'check' || third === 'members')) return route(`/api/projects/:project/${third}`, { ...base, params: { project } });
  if (parts.length === 4 && third === 'diagrams') return route('/api/projects/:project/diagrams/:diagram', { ...base, params: { project, diagram: idOf(fourth) } });
  if (parts.length === 4 && third === 'members') return route('/api/projects/:project/members/:login', { ...base, params: { project, login: loginOf(fourth) } });
  return route('/api/projects/*', base);
}

function authRoute(parts: string[]): RouteInfo {
  const [, second, third] = parts;
  if (parts.length === 2 && (second === 'providers' || second === 'exchange')) return route(`/api/auth/${second}`);
  if (parts.length === 2 && second === 'logout') return route('/api/auth/logout', { protected: true });
  if (parts.length === 3 && second === 'github' && (third === 'login' || third === 'callback')) return route(`/api/auth/github/${third}`);
  return route('/api/auth/*');
}

function adminRoute(parts: string[]): RouteInfo {
  const [, second, third] = parts;
  if (second === 'users' && parts.length === 2) return route('/api/admin/users', { protected: true });
  if (second === 'users' && parts.length === 3) return route('/api/admin/users/:login', { protected: true, params: { login: loginOf(third) } });
  return route('/api/admin/*', { protected: true });
}

/** `/api/<módulo>/<acción>[/<comando>]`: como en `serve.ts`, los segmentos de más se ignoran. */
function moduleRoute(parts: string[]): RouteInfo {
  const [, action, command] = parts;
  if (parts.length < 2) return route('/api/*');
  if (COMPUTE_ACTIONS.has(action)) {
    if (action === 'run' && command !== undefined) return route('/api/:module/run/:command', { compute: true });
    return route(`/api/:module/${action}`, { compute: true });
  }
  if (action === 'capabilities' || action === 'schema') return route(`/api/:module/${action}`);
  return route('/api/:module/*');
}

export function classifyRoute(method: string, pathname: string): RouteInfo {
  if (OPERATIONAL.has(pathname)) return route(pathname, { operational: true });
  if (pathname === '/.well-known/iark.json') return route(pathname);
  if (pathname !== '/api' && !pathname.startsWith('/api/')) {
    if (pathname === '/') return route('/');
    return route(pathname.startsWith('/assets/') ? '/assets/*' : '/*');
  }
  const parts = segmentsOf(pathname.slice('/api'.length));
  if (parts.length === 0) return route('/api');
  switch (parts[0]) {
    case 'projects':
      return projectsRoute(method, parts);
    case 'auth':
      return authRoute(parts);
    case 'admin':
      return adminRoute(parts);
    case 'whoami':
      if (parts.length === 1) return route('/api/whoami', { protected: true });
      break;
    case 'modules':
      if (parts.length === 1) return route('/api/modules');
      break;
    case 'trace':
      if (parts.length === 1) return route('/api/trace', { compute: true });
      break;
  }
  return moduleRoute(parts);
}
