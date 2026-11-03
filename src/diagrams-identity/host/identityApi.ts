import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAdminApi } from '../../cli/accounts/admin';
import { createAuthApi } from '../../cli/accounts/routes';
import type { Accounts, PublicUser } from '../../cli/accounts/service';
import { createUsageApi, type Quotas } from '../../cli/accounts/usage';
import type { Authenticator } from '../../cli/serveAuth';

export interface IdentityApiOptions {
  accounts?: Accounts;
  auth?: Authenticator;
  /** Hay archivo de tokens (`--tokens`); informa a `/api/auth/providers`. */
  tokensEnabled?: boolean;
  trustProxy?: boolean;
  quotas?: Quotas;
  readBody: (req: IncomingMessage) => Promise<string>;
  send: (res: ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>) => void;
  sendJson: (res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>) => void;
  requireMethod: (req: IncomingMessage, allowed: 'GET' | 'POST') => void;
  onLogin?: (req: IncomingMessage, user: PublicUser) => void;
  onLoginFailed?: (req: IncomingMessage, failure: { reason: string; result: 'denied' | 'error'; login?: string }) => void;
}

/**
 * Host `diagrams-identity`: traduce HTTP a comandos/consultas de `accounts` y `access-tokens`.
 * El almacén y los hashes siguen en Core (`src/cli/accounts/*`, `src/cli/tokens.ts`) hasta moverlos.
 */
export function createIdentityApi(options: IdentityApiOptions) {
  const {
    accounts,
    auth,
    tokensEnabled = false,
    trustProxy = false,
    quotas,
    readBody,
    send,
    sendJson,
    requireMethod,
    onLogin,
    onLoginFailed,
  } = options;

  const adminApi = createAdminApi({ accounts, auth, quotas, readBody, sendJson });
  const usageApi = createUsageApi({ accounts, auth, quotas, sendJson });
  const authApi = createAuthApi({
    accounts,
    auth,
    tokens: tokensEnabled,
    trustProxy,
    readBody,
    send,
    sendJson,
    onLogin,
    onLoginFailed,
  });

  /** Atiende rutas de identidad. Devuelve `true` si la ruta era de este borde. */
  async function handle(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<boolean> {
    if (parts[0] === 'auth') {
      await authApi(req, res, url, parts.slice(1));
      return true;
    }
    if (parts[0] === 'admin') {
      await adminApi(req, res, url, parts.slice(1));
      return true;
    }
    if (parts[0] === 'usage') {
      await usageApi(req, res, url, parts.slice(1));
      return true;
    }
    if (parts.length === 1 && parts[0] === 'whoami') {
      requireMethod(req, 'GET');
      if (!auth) {
        sendJson(res, 200, { auth: false });
        return true;
      }
      const who = await auth.identify(req);
      if (who.kind === 'token') {
        sendJson(res, 200, { auth: true, name: who.name, role: who.role });
        return true;
      }
      sendJson(res, 200, { auth: true, name: who.user.name ?? who.user.login, role: who.siteRole, user: who.user });
      return true;
    }
    return false;
  }

  return { handle };
}
