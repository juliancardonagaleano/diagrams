import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un GitHub de mentira para probar el inicio de sesión sin red ni cuentas reales: solo lo que usa `GithubOAuth` (la pantalla de
 * autorización, el cambio del código por un token, `GET /user` y la revocación del token). Cada prueba arranca el suyo.
 *
 *  - `GET /login/oauth/authorize`: «la persona acepta» al instante: redirige a `redirect_uri?code=…&state=…` con un código de la persona
 *    que se puso con `signInAs` (o a `?error=access_denied` si se pidió `deny()`). Así sirve igual a un navegador de verdad (Playwright)
 *    que a una prueba que sigue las redirecciones a mano.
 *  - `POST /login/oauth/access_token`: cambia un código (de un solo uso) por un token, si el `client_id` y el `client_secret` son los suyos.
 *  - `GET /user`: el perfil del dueño del token. `DELETE /applications/<id>/token`: revoca el token (y se anota en `revoked`).
 */
export interface FakeProfile {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
  type?: string;
}

export interface FakeGithub {
  /** `http://127.0.0.1:<puerto>`: sirve de `--github-url` y de `--github-api-url`. */
  url: string;
  clientId: string;
  clientSecret: string;
  /** La próxima persona que «acepta» en la pantalla de autorización (se queda hasta que se cambie). */
  signInAs(profile: FakeProfile): void;
  /** La próxima persona que llegue a la pantalla de autorización no acepta. */
  deny(): void;
  /** Un código ya emitido para esa persona (como si hubiera aceptado), sin pasar por el navegador. */
  issueCode(profile: FakeProfile): string;
  /** Tokens que el servicio revocó (para comprobar que no se queda con acceso). */
  revoked: string[];
  /** Cuántas veces se llamó a cada ruta (`POST /login/oauth/access_token`…). */
  calls: Record<string, number>;
  /** Hace que la ruta de ese nombre (`token` o `user`) responda con ese estado HTTP la próxima vez (`500`, por ejemplo). */
  failNext(route: 'token' | 'user', status: number): void;
  stop(): Promise<void>;
}

export const FAKE_CLIENT_ID = 'Iv1.fakeclientid';
export const FAKE_CLIENT_SECRET = 'fake-client-secret-0123456789abcdef';

export async function startFakeGithub(): Promise<FakeGithub> {
  const codes = new Map<string, FakeProfile>();
  const tokens = new Map<string, FakeProfile>();
  const revoked: string[] = [];
  const calls: Record<string, number> = {};
  const failures = new Map<string, number>();
  let persona: FakeProfile | undefined;
  let denying = false;

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const issue = (profile: FakeProfile): string => {
    const code = randomBytes(10).toString('hex');
    codes.set(code, profile);
    return code;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const key = `${req.method} ${url.pathname.replace(/\/applications\/[^/]+/, '/applications/:id')}`;
      calls[key] = (calls[key] ?? 0) + 1;

      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        if (url.searchParams.get('client_id') !== FAKE_CLIENT_ID) return json(res, 404, { message: 'client_id desconocido' });
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        const state = url.searchParams.get('state');
        if (state) back.searchParams.set('state', state);
        if (denying || !persona) back.searchParams.set('error', 'access_denied');
        else back.searchParams.set('code', issue(persona));
        res.writeHead(302, { Location: back.toString() });
        return void res.end();
      }

      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const failing = failures.get('token');
        if (failing) {
          failures.delete('token');
          return json(res, failing, { error: 'server_error' });
        }
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, string>;
        if (body.client_id !== FAKE_CLIENT_ID || body.client_secret !== FAKE_CLIENT_SECRET) return json(res, 200, { error: 'incorrect_client_credentials' });
        const profile = codes.get(body.code);
        codes.delete(body.code);
        if (!profile) return json(res, 200, { error: 'bad_verification_code' });
        const token = `gho_${randomBytes(12).toString('hex')}`;
        tokens.set(token, profile);
        return json(res, 200, { access_token: token, token_type: 'bearer', scope: '' });
      }

      if (req.method === 'GET' && url.pathname === '/user') {
        const failing = failures.get('user');
        if (failing) {
          failures.delete('user');
          return json(res, failing, { message: 'error' });
        }
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
        const profile = token ? tokens.get(token) : undefined;
        if (!profile) return json(res, 401, { message: 'Bad credentials' });
        return json(res, 200, { type: 'User', avatar_url: `https://avatars.example.test/u/${profile.id}`, ...profile });
      }

      if (req.method === 'DELETE' && /^\/applications\/[^/]+\/token$/.test(url.pathname)) {
        const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
        if (req.headers.authorization !== expected) return json(res, 401, { message: 'Bad credentials' });
        const { access_token: token } = JSON.parse((await readBody(req)) || '{}') as { access_token?: string };
        if (token) {
          tokens.delete(token);
          revoked.push(token);
        }
        res.writeHead(204);
        return void res.end();
      }
      json(res, 404, { message: 'Not Found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    signInAs(profile) {
      persona = profile;
      denying = false;
    },
    deny() {
      denying = true;
    },
    issueCode: issue,
    revoked,
    calls,
    failNext(route, status) {
      failures.set(route, status);
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** El `challenge` que corresponde a un `verifier` (PKCE S256): el sha256 en base64url. */
export const challengeOf = (verifier: string): string => createHash('sha256').update(verifier, 'utf8').digest('base64url');

/** Un `verifier` válido (43 caracteres base64url). */
export const newVerifier = (): string => randomBytes(32).toString('base64url');
