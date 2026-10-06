import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { GithubOAuth } from '../../src/cli/accounts/github';
import { Accounts, type AccountsOptions } from '../../src/cli/accounts/service';
import { AccountStore } from '../../src/cli/accounts/store';
import { createDefaultRegistry } from '../../src/cli/registry';
import { createSuiteServer, type ServeOptions } from '../../src/cli/serve';
import { createToken, TokenStore } from '../../src/cli/tokens';
import { FolderProjectStore } from '../../src/cli/workspace';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGithub, type FakeGithub, type FakeProfile } from './fakeGithub';
import { loginWithGithub } from './githubLogin';

/**
 * Una nube de mentira para las pruebas de `iark serve --accounts`: el servidor de verdad (`createSuiteServer`) con un espacio de trabajo en una
 * carpeta temporal, cuentas y un GitHub de mentira. `cleanupCloud` (en un `afterEach`) apaga y borra todo lo que se arrancó.
 */

export const JSON_TYPE = { 'Content-Type': 'application/json' };
export const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');

/** Lo que han arrancado las pruebas del archivo en curso, para apagarlo y borrarlo al terminar cada una. */
export const tracked = { folders: [] as string[], servers: [] as Server[], fakes: [] as FakeGithub[] };
const { folders, servers, fakes } = tracked;
export async function cleanupCloud(): Promise<void> {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
  for (const fake of fakes.splice(0)) await fake.stop();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const ANA: FakeProfile = { id: 583231, login: 'ana', name: 'Ana Pérez' };
export const BETO: FakeProfile = { id: 202, login: 'beto' };
export const CARLA: FakeProfile = { id: 303, login: 'carla' };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface Cloud {
  base: string;
  root: string;
  file: string;
  fake: FakeGithub;
  accounts: Accounts;
  /** Con `tokens: true`: un token admin y el archivo de tokens (se le pueden crear más con `createToken`: el servidor lo relee cuando cambia). */
  tokens?: { admin: string; file: string };
}

export interface CloudOptions extends Partial<Omit<AccountsOptions, 'store' | 'github' | 'publicUrl'>> {
  tokens?: boolean;
  cors?: string[];
  serve?: Partial<ServeOptions>;
}

export async function startCloud(options: CloudOptions = {}): Promise<Cloud> {
  const fake = await startFakeGithub();
  fakes.push(fake);
  const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-api-'));
  folders.push(dir);
  const root = join(dir, 'espacio');
  mkdirSync(root);
  const file = join(dir, 'cuentas.json');
  const port = await freePort();
  const { tokens: withTokens, cors, serve, ...rest } = options;
  const accounts = new Accounts({
    store: AccountStore.open(file),
    github: new GithubOAuth({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, baseUrl: fake.url, apiUrl: fake.url }),
    publicUrl: `http://127.0.0.1:${port}`,
    signup: 'invite',
    admins: [String(ANA.id)],
    allowedOrigins: cors,
    ...rest,
  });
  let tokenStore: TokenStore | undefined;
  let adminToken: string | undefined;
  let tokenFile: string | undefined;
  if (withTokens) {
    tokenFile = join(dir, 'tokens.json');
    adminToken = createToken(tokenFile, { name: 'servicio', role: 'admin' }).token;
    tokenStore = TokenStore.open(tokenFile);
  }
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root), accounts, tokens: tokenStore, cors, ...serve });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${port}`, root, file, fake, accounts, ...(adminToken && tokenFile ? { tokens: { admin: adminToken, file: tokenFile } } : {}) };
}

/** Una persona entra y devuelve su token de sesión. */
export async function signIn(cloud: Cloud, profile: FakeProfile): Promise<string> {
  const result = await loginWithGithub(cloud.base, cloud.fake, profile);
  if (!result.token) throw new Error(`no entró (${profile.login}): ${result.fragment}`);
  return result.token;
}

export function call(base: string, token?: string) {
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? JSON_TYPE : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    get: (path: string, headers?: Record<string, string>) => send('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => send('POST', path, body ?? {}, headers),
    put: (path: string, body?: unknown) => send('PUT', path, body ?? {}),
    patch: (path: string, body?: unknown) => send('PATCH', path, body ?? {}),
    del: (path: string) => send('DELETE', path),
  };
}
