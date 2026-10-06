import { challengeOf, newVerifier, type FakeGithub, type FakeProfile } from './fakeGithub';

/**
 * El inicio de sesión de GitHub recorrido a mano por HTTP, como lo haría un navegador (las redirecciones se siguen sin seguirlas):
 * `/api/auth/github/login` → la pantalla de autorización del GitHub de mentira → `/api/auth/github/callback` → `#iark_code` →
 * `POST /api/auth/exchange`. Devuelve cada paso para que las pruebas puedan romper el que quieran.
 */
export interface LoginResult {
  /** La sesión (`iark_s_…`), si el flujo llegó hasta el final. */
  token?: string;
  expiresAt?: string;
  user?: { id: string; login: string; name?: string; avatarUrl?: string; siteRole: string };
  /** El fragmento al que se devolvió a la persona (`iark_code=…` o `iark_error=…`), sin la almohadilla. */
  fragment: URLSearchParams;
  /** Adónde se devolvió (sin fragmento). */
  returnedTo?: string;
  /** La respuesta del `callback`, por si no fue una redirección. */
  callbackStatus: number;
  exchangeStatus?: number;
  verifier: string;
  challenge: string;
}

export interface LoginOptions {
  redirect?: string;
  verifier?: string;
  /** Sin la cookie de `state`, como una persona a la que le llegara el enlace de otra. */
  withoutCookie?: boolean;
}

export async function loginWithGithub(base: string, fake: FakeGithub, profile: FakeProfile, options: LoginOptions = {}): Promise<LoginResult> {
  const verifier = options.verifier ?? newVerifier();
  const challenge = challengeOf(verifier);
  fake.signInAs(profile);
  const query = new URLSearchParams({ challenge, ...(options.redirect ? { redirect: options.redirect } : {}) });
  const start = await fetch(`${base}/api/auth/github/login?${query}`, { redirect: 'manual' });
  if (start.status !== 302) throw new Error(`login respondió ${start.status}: ${await start.text()}`);
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location')!);
  const callback = await fetch(`${base}/api/auth/github/callback${callbackUrl.search}`, { redirect: 'manual', headers: options.withoutCookie ? {} : { Cookie: cookie } });
  const location = callback.headers.get('location');
  const result: LoginResult = { fragment: new URLSearchParams(), callbackStatus: callback.status, verifier, challenge };
  if (!location) return result;
  const back = new URL(location);
  result.fragment = new URLSearchParams(back.hash.slice(1));
  back.hash = '';
  result.returnedTo = back.toString();
  const code = result.fragment.get('iark_code');
  if (!code) return result;
  const exchange = await fetch(`${base}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }) });
  result.exchangeStatus = exchange.status;
  if (exchange.ok) Object.assign(result, await exchange.json());
  return result;
}
