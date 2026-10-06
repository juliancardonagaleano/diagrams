import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { normalizeBaseUrl, ProjectError, type AuthProviders, type RemoteSession } from '@iark/kernel';
import { browserAreas, chooseLocalBackend, forgetBackend, hostOf, loadBackend, saveBackend, type StorageAreas } from './backend';
import { currentPage, loadProviders, mixedContentWarning, testConnection, type ConnectionResult, type PageInfo } from './connection';
import { detectManagedServer, getLoginNotice, isSessionToken, setLoginNotice, startGithubLogin, subscribeLoginNotice, type ManagedServer } from './login';
import { safeAvatarUrl, SITE_ROLE_LABEL } from './people';
import type { ProjectSession } from './session';

export interface StoragePanelProps {
  session: ProjectSession;
  open: boolean;
  onToggle(open: boolean): void;
  /** Hay un proyecto elegido para copiar a un servidor: ofrece «Copiar … al servidor» además de conectar. */
  copyFor?: { name: string };
  /** Se guardó el servidor (sin activarlo) para copiar: el gestor hace la copia. */
  onCopy?(): void;
  /** La configuración cambió (el servidor conocido): el gestor recalcula a dónde se puede copiar. */
  onChange?(): void;
  notify?(message: string): void;
  /** Recarga la página tras cambiar de almacén (las pruebas lo sustituyen). */
  reload?(): void;
  fetch?: typeof fetch;
  areas?: StorageAreas;
  page?: PageInfo;
  /** Empieza el inicio de sesión de GitHub (las pruebas lo sustituyen: el de verdad cambia de página). */
  startLogin?: typeof startGithubLogin;
  /**
   * Busca si esta página la sirve una instancia gestionada, para proponer su dirección. Por omisión se pregunta a la carpeta de la página
   * (`detectManagedServer`); `false` no pregunta (las pruebas que cuentan las peticiones al servidor).
   */
  detect?: false | (() => Promise<ManagedServer | undefined>);
}

type Status = 'connecting' | 'connected' | 'offline' | 'rejected';
const STATUS_TEXT: Record<Status, string> = { connecting: 'Comprobando…', connected: 'Conectado', offline: 'Sin conexión', rejected: 'Token rechazado' };

/**
 * «Dónde se guardan»: este navegador o un servidor propio. Muestra el almacén activo y su estado y deja conectar a un
 * servidor (dirección y token, con «Probar conexión»), volver a este navegador o cambiar el token sin recargar.
 * Cambiar de almacén recarga la página: es lo más simple y seguro (nada de lo abierto queda apuntando al almacén anterior).
 *
 * Si el servidor ofrece iniciar sesión con GitHub (`/api/auth/providers`), ese es el camino principal: el botón sale a GitHub y vuelve (la
 * página se recarga: lo que esté sin guardar se guarda antes o se avisa de que se perdería) y el token pasa a un plegable «Usar un token».
 * Con una sesión de persona se ve quién eres y se puede cerrar la sesión; si caduca, el panel lo dice y deja volver a entrar.
 * Con un servidor que no ofrece GitHub (autoalojado con `--tokens`) todo es como siempre.
 */
export function StoragePanel({ session, open, onToggle, copyFor, onCopy, onChange, notify, reload, fetch: fetchImpl, areas: areasProp, page: pageProp, startLogin, detect }: StoragePanelProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const areas = useMemo(() => areasProp ?? browserAreas(), [areasProp]);
  const page = useMemo(() => pageProp ?? currentPage(), [pageProp]);
  const [version, setVersion] = useState(0);
  const config = useMemo(() => loadBackend(areas), [areas, version]); // eslint-disable-line react-hooks/exhaustive-deps -- `version` fuerza releer lo guardado
  const known = config.kind === 'remote' ? config : config.server;
  const remote = session.backend.kind === 'remote';
  const active = session.backend.kind === 'remote' ? session.backend : undefined;

  const loginNotice = useSyncExternalStore(subscribeLoginNotice, getLoginNotice);
  const [url, setUrl] = useState(known?.url ?? (loginNotice?.kind === 'error' ? loginNotice.url : undefined) ?? '');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(known?.label ?? '');
  const [remember, setRemember] = useState(known?.remembered ?? false);
  /** «Mantener la sesión en este equipo» del inicio de sesión de GitHub: marcada por omisión (las sesiones caducan y se pueden cerrar). */
  const [keepSession, setKeepSession] = useState(known?.token ? (known.remembered ?? true) : true);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [test, setTest] = useState<ConnectionResult | undefined>();
  const [working, setWorking] = useState<'test' | 'connect' | 'copy' | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [loss, setLoss] = useState<'connect' | 'local' | 'login' | 'logout' | undefined>();
  const [logoutIssue, setLogoutIssue] = useState<string | undefined>();
  const [who, setWho] = useState<RemoteSession | undefined>();
  /** Qué formas de entrar ofrece cada dirección que se ha consultado (`null`: no se pudo saber). */
  const [offers, setOffers] = useState<Record<string, AuthProviders | null>>({});
  const [managed, setManaged] = useState<ManagedServer | undefined>();
  /** La última persona con sesión que se vio en este servidor: si la sesión caduca, `who` se pierde pero el panel sigue sabiendo que era una sesión. */
  const lastUser = useRef<RemoteSession['user']>(undefined);
  const alive = useRef(true);
  const probed = useRef(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const typedUrl = useMemo(() => {
    try {
      return normalizeBaseUrl(url);
    } catch {
      return undefined;
    }
  }, [url]);
  const inputToken = token.trim() || undefined;
  /** El token que se usa para probar: el escrito o, si es el mismo servidor, el que ya había guardado. */
  const tokenToUse = inputToken ?? (known && typedUrl === known.url ? known.token : undefined);
  const offer = typedUrl ? offers[typedUrl] : undefined;
  const github = offer?.providers.some((p) => p.id === 'github') === true;
  const offersRef = useRef(offers);
  offersRef.current = offers;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Pregunta qué formas de entrar ofrece esa dirección (sin esperar a «Probar conexión»: es lo que decide qué se muestra). */
  const askProviders = async (address: string): Promise<void> => {
    const found = await loadProviders(address, { fetch: fetchImpl, page });
    if (alive.current) setOffers((previous) => ({ ...previous, [address]: found ?? null }));
  };

  // Al escribir la dirección (con una pausa, para no preguntar en cada letra) se consulta qué ofrece ese servidor.
  useEffect(() => {
    if (!open || !typedUrl || typedUrl in offersRef.current) return;
    const timer = setTimeout(() => void askProviders(typedUrl), 350);
    return () => clearTimeout(timer);
    // `askProviders` solo usa valores que no cambian entre renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typedUrl]);

  // Si esta página la sirve una instancia gestionada, se propone su dirección (una vez, al abrir el panel, y solo si no hay ya un servidor conocido).
  useEffect(() => {
    if (!open || remote || known || detect === false || probed.current) return;
    probed.current = true;
    void (detect ?? (() => detectManagedServer({ fetch: fetchImpl })))().then((found) => {
      if (!found || !alive.current) return;
      setManaged(found);
      setOffers((previous) => ({ ...previous, [found.url]: found.providers }));
      setUrl((typed) => (typed.trim() ? typed : found.url)); // lo que la persona ya escribió manda
    });
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Quién es el token ante el servidor activo (se vuelve a preguntar cuando el servidor vuelve a estar disponible).
  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    session
      .whoami()
      .then((found) => {
        if (cancelled) return;
        if (found?.user) lastUser.current = found.user;
        setWho(found);
      })
      .catch(() => !cancelled && setWho(undefined));
    return () => {
      cancelled = true;
    };
  }, [session, remote, state.available]);

  const rejected = state.errorCode === 'unauthorized' || state.syncErrorCode === 'unauthorized' || state.saveErrorCode === 'unauthorized';
  // Una sesión que el servidor ya no reconoce (caducó o se cerró en otro sitio) no es «un token rechazado»: se dice como es y se ofrece volver a entrar.
  const expired = remote && rejected && (session.credential === 'session' || lastUser.current !== undefined || isSessionToken(known?.token));
  const forbidden = !rejected && state.saveErrorCode === 'forbidden';
  const user = remote && !rejected ? who?.user : undefined;
  const status: Status = !state.ready ? 'connecting' : rejected ? 'rejected' : !state.available || state.syncError || state.saveErrorCode === 'unavailable' ? 'offline' : 'connected';

  // Al abrir el formulario el foco va a la dirección o, si el servidor rechazó el token, directamente al token.
  useEffect(() => {
    if (!open) return;
    (rejected && remote ? tokenInput : urlInput).current?.focus();
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // En una pantalla pequeña el panel se desplaza por dentro: el resultado de probar la conexión no debe quedar fuera de la vista.
  useEffect(() => {
    if (test || problem || message || loss) results.current?.scrollIntoView?.({ block: 'nearest' });
  }, [test, problem, message, loss]);

  const changed = (): void => {
    setVersion((v) => v + 1);
    onChange?.();
  };

  const check = async (): Promise<ConnectionResult> => {
    // Al probar se vuelve a preguntar qué ofrece el servidor (puede haber cambiado desde que se escribió la dirección).
    const [result] = await Promise.all([testConnection({ url, token: tokenToUse }, { fetch: fetchImpl, page }), typedUrl ? askProviders(typedUrl) : undefined]);
    setTest(result);
    return result;
  };

  const busy = working !== undefined;
  const run = async (kind: NonNullable<typeof working>, work: () => Promise<void>): Promise<void> => {
    setWorking(kind);
    setProblem(undefined);
    setMessage(undefined);
    setLoss(undefined);
    try {
      await work();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setWorking(undefined);
    }
  };

  const doReload = (): void => (reload ?? (() => window.location.reload()))();

  /** Guarda lo pendiente antes de cambiar de almacén; si no pudo guardarse, pide confirmar porque la recarga lo perdería. */
  const settle = async (action: 'connect' | 'local' | 'login' | 'logout', confirmed: boolean): Promise<boolean> => {
    await session.flush();
    if (session.dirty && !confirmed) {
      setLoss(action);
      return false;
    }
    return true;
  };

  const connect = (confirmed = false): Promise<void> =>
    run('connect', async () => {
      const result = await check();
      if (!result.ok) return;
      if (remote && active && result.url === active.url) {
        // Mismo servidor: solo cambia el token (o el nombre). Sin recargar, para no perder lo que está pendiente de guardar.
        const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: true }, areas);
        await session.useToken(tokenToUse);
        setWho(await session.whoami().catch(() => undefined)); // otro token, otra persona (u otro rol)
        setToken('');
        changed();
        const text = saved.saved ? 'Token actualizado: se retoma el guardado.' : `Token actualizado solo hasta que recargues la página. ${saved.problem ?? ''}`;
        setMessage(text);
        notify?.(text);
        return;
      }
      if (!(await settle('connect', confirmed))) return;
      const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: true }, areas);
      if (!saved.saved) {
        setProblem(saved.problem);
        return;
      }
      doReload();
    });

  const back = (confirmed = false): Promise<void> =>
    run('connect', async () => {
      if (!(await settle('local', confirmed))) return;
      if (!chooseLocalBackend(areas)) {
        setProblem('El navegador no deja guardar la configuración (¿datos del sitio bloqueados?): al recargar seguiría el servidor.');
        return;
      }
      doReload();
    });

  const copy = (): Promise<void> =>
    run('copy', async () => {
      const result = await check();
      if (!result.ok) return;
      // Se recuerda el servidor sin activarlo: la copia se hace con su propio cliente y este navegador sigue siendo el almacén activo.
      const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: false }, areas);
      if (!saved.saved) {
        setProblem(saved.problem);
        return;
      }
      changed();
      onCopy?.();
    });

  /**
   * «Iniciar sesión con GitHub»: la página sale hacia GitHub y vuelve recargada, así que lo pendiente de guardar se guarda antes (con una sesión
   * caducada no se puede: entonces se pide confirmar, porque se perdería) y no se activa nada hasta volver con la sesión.
   */
  const login = (confirmed = false): Promise<void> =>
    run('connect', async () => {
      if (!typedUrl) throw new ProjectError('invalid', 'Escribe la dirección del servidor.');
      if (!(await settle('login', confirmed))) return;
      setLoginNotice(undefined);
      await (startLogin ?? startGithubLogin)({ server: typedUrl, remember: keepSession, label });
    });

  /**
   * «Cerrar sesión»: guarda lo pendiente, la cierra en el servidor (deja de valer aunque la hubieran copiado), olvida el token de este navegador y
   * vuelve a «Este navegador» conservando la dirección del servidor. Si el servidor no responde, no la da por cerrada sin que la persona lo decida.
   */
  const signOut = (confirmed = false, forced = false): Promise<void> =>
    run('connect', async () => {
      setLogoutIssue(undefined);
      if (!active) return;
      if (!(await settle('logout', confirmed))) return;
      try {
        await session.logout();
      } catch (error) {
        // 401: la sesión ya no valía (caducó o se cerró en otro sitio): no hay nada que cerrar en el servidor.
        if (!(error instanceof ProjectError && error.code === 'unauthorized') && !forced) {
          setLogoutIssue((error as Error).message);
          return;
        }
      }
      // token vacío: quita el de esta dirección (de la pestaña y del equipo) y `active: false` deja los proyectos en este navegador
      const saved = saveBackend({ url: active.url, token: '', ...(active.label ? { label: active.label } : {}) }, { active: false }, areas);
      if (!saved.saved) {
        setProblem(saved.problem);
        return;
      }
      doReload();
    });

  const forget = (): void => {
    forgetBackend(areas);
    setUrl('');
    setToken('');
    setLabel('');
    setRemember(false);
    setTest(undefined);
    changed();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // Con GitHub ofrecido y sin token escrito, Intro en la dirección inicia sesión: es el camino principal y lo otro está plegado.
    if (showLogin && !inputToken && !tokenOpen) void login();
    else void connect();
  };

  const host = active?.host;
  const identity = who?.name ? ` (${who.name}${who.role ? `, ${who.role}` : ''})` : who && !who.auth ? ' (sin autenticación)' : '';
  const summary = remote ? `Servidor: ${host}${active?.label ? ` «${active.label}»` : ''}${identity}` : 'Este navegador';
  const warning = mixedContentWarning(typedUrl ?? url, page);
  const sameActive = remote && active !== undefined && typedUrl === active.url;
  const needsUrl = !url.trim();
  /** El botón de GitHub se ofrece cuando el servidor lo ofrece y todavía no se ha entrado en él con una sesión. */
  const showLogin = github && !(sameActive && user);
  const projectRole = state.projects.find((p) => p.id === state.projectId)?.role;
  const avatar = safeAvatarUrl(user?.avatarUrl);

 // El token y su casilla: los de siempre. Con GitHub ofrecido van dentro del plegable «Usar un token»; si no, a la vista como antes.
  const tokenField = (
    <label className="pj-grow">
      Token de acceso
      <input
        ref={tokenInput}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        placeholder={known?.token && (typedUrl === known.url || !url.trim()) ? 'Ya hay uno guardado; en blanco lo conserva' : 'Opcional si el servidor es abierto'}
        onChange={(e) => {
          setToken(e.target.value);
          setTest(undefined);
        }}
      />
    </label>
  );
  const rememberFields = (
    <>
      <label className="pj-check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-describedby="pj-remember-note" />
        Recordar en este equipo
      </label>
      <small id="pj-remember-note" className="pj-hint">
        Sin marcar, el token solo vive en esta pestaña y se olvida al cerrarla. Marcada, se guarda en este navegador hasta que lo borres: cualquier script que se ejecute en este sitio podría leerlo; márcala solo en un equipo tuyo.
      </small>
    </>
  );

  return (
    <section className="pj-storage" aria-label="Dónde se guardan" data-testid="storage-panel" data-backend={remote ? 'remote' : 'local'}>
      <div className="pj-storage-head">
        <span className="pj-storage-where">
          <strong>Dónde se guardan:</strong> <span data-testid="storage-summary">{summary}</span>
          {remote && (
            <span className="pj-status" data-status={status} data-testid="storage-status" role="status">
              {status === 'rejected' && expired ? 'Sesión caducada' : STATUS_TEXT[status]}
            </span>
          )}
        </span>
        <button type="button" onClick={() => onToggle(!open)} aria-expanded={open} aria-controls="pj-storage-body">
          {open ? 'Ocultar' : remote ? 'Cambiar…' : 'Conectar a un servidor…'}
        </button>
      </div>

      {open && (
        <div className="pj-storage-body" id="pj-storage-body">
          {loginNotice?.kind === 'error' && (
            <p className="pj-error" role="alert" data-testid="storage-login-notice" data-reason={loginNotice.reason}>
              {loginNotice.message}{' '}
              <button type="button" onClick={() => setLoginNotice(undefined)}>
                Descartar aviso
              </button>
            </p>
          )}
          {remote && rejected && expired && (
            <p className="pj-error" role="alert" data-testid="storage-expired">
              Tu sesión caducó (o se cerró desde otro sitio). {github ? 'Pulsa «Iniciar sesión con GitHub» para seguir guardando en este servidor.' : 'Vuelve a iniciar sesión para seguir guardando en este servidor.'}
              {session.dirty && ' Lo que escribiste desde entonces no se ha guardado: al iniciar sesión la página se recarga y se perdería (copia el texto del documento antes si lo necesitas).'}
            </p>
          )}
          {remote && rejected && !expired && (
            <p className="pj-error" role="alert" data-testid="storage-rejected">
              El servidor no aceptó el token. Escribe el correcto y pulsa «Usar este token»: lo pendiente de guardar no se pierde.
            </p>
          )}
          {remote && forbidden && session.credential === 'session' && (
            <p className="pj-error" role="alert" data-testid="storage-forbidden">
              No tienes permiso para guardar en este proyecto{projectRole ? ` (tu rol es «${projectRole === 'viewer' ? 'lector' : projectRole}»)` : ''}. Pide a quien administra el proyecto que te dé el rol de editor.
            </p>
          )}
          {remote && forbidden && session.credential !== 'session' && (
            <p className="pj-error" role="alert" data-testid="storage-forbidden">
              El servidor reconoce el token, pero su rol no permite guardar aquí{who?.role ? ` (es «${who.role}»)` : ''}. Escribe un token con rol editor y pulsa «Usar este token»: lo pendiente de guardar no se pierde.
            </p>
          )}

          {user && (
            <div className="pj-account" data-testid="storage-account">
              {avatar && <img className="pj-avatar" src={avatar} alt="" width={36} height={36} referrerPolicy="no-referrer" />}
              <div className="pj-account-who">
                <span>
                  <strong data-testid="storage-account-login">@{user.login}</strong>
                  {user.name && user.name !== user.login ? ` · ${user.name}` : ''}
                </span>
                <small>Rol en la instancia: {SITE_ROLE_LABEL[user.siteRole]}</small>
              </div>
              <button type="button" onClick={() => void signOut()} disabled={busy} data-testid="storage-logout">
                Cerrar sesión
              </button>
            </div>
          )}
          {logoutIssue && (
            <p className="pj-warn" role="alert" data-testid="storage-logout-issue">
              No se pudo cerrar la sesión en el servidor ({logoutIssue}). Si sigues, se olvida aquí pero seguirá abierta en el servidor hasta que caduque.{' '}
              <button type="button" className="pj-danger" onClick={() => void signOut(true, true)} disabled={busy}>
                Cerrar aquí de todos modos
              </button>
              <button type="button" onClick={() => setLogoutIssue(undefined)}>
                Cancelar
              </button>
            </p>
          )}

          <form className="pj-connect" onSubmit={submit} aria-label="Conectar a un servidor">
            {copyFor && !remote && (
              <p className="pj-hint">
                Para copiar «{copyFor.name}» hace falta un servidor. Estos proyectos siguen en este navegador: la copia no cambia dónde se guardan.
              </p>
            )}
            <div className="pj-row">
              <label className="pj-grow">
                Dirección del servidor
                <input
                  ref={urlInput}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://iark.ejemplo.org"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setTest(undefined);
                  }}
                />
              </label>
              {!github && tokenField}
              <label className="pj-grow">
                Nombre (opcional)
                <input type="text" autoComplete="off" maxLength={60} placeholder="Oficina" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
            </div>
            {managed && typedUrl === managed.url && (
              <small className="pj-hint" data-testid="storage-managed">
                Esta página la sirve la instancia {hostOf(managed.url)}: su dirección ya está escrita.
              </small>
            )}
            {!github && rememberFields}
            {showLogin && (
              <div className="pj-login" data-testid="storage-login">
                <button type="button" className="pj-primary pj-github" onClick={() => void login()} disabled={busy || needsUrl}>
                  Iniciar sesión con GitHub
                </button>
                <label className="pj-check">
                  <input type="checkbox" checked={keepSession} onChange={(e) => setKeepSession(e.target.checked)} aria-describedby="pj-keep-note" />
                  Mantener la sesión en este equipo
                </label>
                <small id="pj-keep-note" className="pj-hint">
                  La sesión se guarda en este navegador (no tu contraseña ni nada de GitHub) y caduca sola; puedes cerrarla cuando quieras. Sin marcar, solo vale en esta pestaña y se olvida al cerrarla. Marcada, cualquier script que se ejecute en este sitio podría leerla: márcala solo en un equipo tuyo.
                </small>
                {offer?.signup === 'invite' && (
                  <small className="pj-hint" data-testid="storage-invite-only">
                    Este servidor es solo por invitación: entra quien lo administra y las personas a las que invite con su usuario de GitHub.
                  </small>
                )}
              </div>
            )}
            {github && (
              <details className="pj-token" open={tokenOpen || (rejected && !expired && remote)} onToggle={(e) => setTokenOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Usar un token</summary>
                <div className="pj-token-body">
                  <div className="pj-row">{tokenField}</div>
                  {rememberFields}
                </div>
              </details>
            )}
            <small className="pj-hint">
              El servidor tiene que aceptar a esta página: <code>--cors {page.origin}</code> (no hace falta si lo abriste desde ese mismo servidor).
            </small>
            {warning && (
              <p className="pj-warn" role="note" data-testid="storage-mixed">
                {warning}
              </p>
            )}

            <div className="pj-actions pj-connect-actions">
              <button type="button" onClick={() => void run('test', async () => void (await check()))} disabled={busy || needsUrl}>
                {working === 'test' ? 'Probando…' : 'Probar conexión'}
              </button>
              {copyFor && !remote && (
                <button type="button" className="pj-primary" onClick={() => void copy()} disabled={busy || needsUrl}>
                  Copiar «{copyFor.name}» al servidor
                </button>
              )}
              <button type="submit" className={(copyFor && !remote) || showLogin ? undefined : 'pj-primary'} disabled={busy || needsUrl}>
                {sameActive ? 'Usar este token' : copyFor && !remote ? 'Conectar y usar este servidor' : showLogin ? 'Conectar con un token' : 'Conectar'}
              </button>
              {remote && (
                <button type="button" onClick={() => void back()} disabled={busy}>
                  Volver a este navegador
                </button>
              )}
              {!remote && known && (
                <button type="button" onClick={forget} disabled={busy}>
                  Olvidar este servidor
                </button>
              )}
            </div>
          </form>

          <div className="pj-results" ref={results}>
            {test?.ok && (
              <p className="pj-ok" role="status" data-testid="storage-test">
                Conexión correcta con {test.url}.{' '}
                {test.user
                  ? `Eres «${test.name ?? test.user.login}» (@${test.user.login}, rol en la instancia: ${SITE_ROLE_LABEL[test.user.siteRole]}).`
                  : test.auth
                    ? `Eres «${test.name ?? 'sin nombre'}»${test.role ? ` (rol ${test.role})` : ''}.`
                    : 'El servidor no pide autenticación.'}{' '}
                Tiene {test.projects === 1 ? '1 proyecto' : `${test.projects} proyectos`}.
              </p>
            )}
            {test && !test.ok && (
              <p className="pj-error" role="alert" data-testid="storage-test" data-problem={test.problem}>
                {test.problem === 'unauthorized' && github && !tokenToUse ? 'Este servidor pide iniciar sesión: pulsa «Iniciar sesión con GitHub» (o escribe un token, si tienes uno).' : test.message}
                {test.detail && test.detail !== test.message && !(test.problem === 'unauthorized' && github && !tokenToUse) && <small> Respuesta: {test.detail}</small>}
              </p>
            )}
            {message && (
              <p className="pj-ok" role="status" data-testid="storage-message">
                {message}
              </p>
            )}
            {problem && (
              <p className="pj-error" role="alert" data-testid="storage-problem">
                {problem}
              </p>
            )}
            {loss && (
              <p className="pj-warn" role="alert" data-testid="storage-loss">
                Hay cambios sin guardar que no pudieron enviarse al almacén actual; si sigues, se perderán.{' '}
                <button type="button" className="pj-danger" onClick={() => void (loss === 'connect' ? connect(true) : loss === 'login' ? login(true) : loss === 'logout' ? signOut(true) : back(true))} disabled={busy}>
                  Seguir y descartarlos
                </button>
                <button type="button" onClick={() => setLoss(undefined)}>
                  Cancelar
                </button>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
