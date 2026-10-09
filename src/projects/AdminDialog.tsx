import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ProjectError, type AdminAccount, type PublicUser, type SiteRole } from '@iark/kernel';
import { INSTANCE_LOGIN, safeAvatarUrl, SITE_ROLE_HELP, SITE_ROLE_TITLE, SITE_ROLES } from './people';
import { accountLevel, draftOf, formatBytes, percentOf, quotaChangeOf, type QuotaDraft, type QuotaMode } from './quota';
import type { ProjectSession } from './session';

export interface AdminDialogProps {
  session: ProjectSession;
  /** Quién administra (la persona con sesión): su propia cuenta se muestra pero no se puede bajar de rol ni desactivar. */
  me: PublicUser;
  onClose(): void;
  notify?(message: string): void;
}

type Filter = 'all' | SiteRole | 'pending' | 'disabled';
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Todas las cuentas' },
  { id: 'admin', label: 'Administradores' },
  { id: 'member', label: 'Miembros' },
  { id: 'guest', label: 'Invitados' },
  { id: 'pending', label: 'Invitaciones pendientes' },
  { id: 'disabled', label: 'Desactivadas' },
];

type SortKey = 'role' | 'login' | 'lastLogin' | 'projects' | 'usage';
const SORTS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'role', label: 'Rol (administradores primero)' },
  { id: 'login', label: 'Usuario (A–Z)' },
  { id: 'lastLogin', label: 'Último acceso (el más reciente primero)' },
  { id: 'projects', label: 'Proyectos (los que más, primero)' },
  { id: 'usage', label: 'Espacio (los que más usan, primero)' },
];

/** Qué hacer con el foco cuando termina lo que se estaba haciendo y la pantalla se vuelve a pintar. */
type FocusTarget = 'invite' | { id: string; target: 'role' | 'toggle' | 'quota' };

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byLogin = (a: AdminAccount, b: AdminAccount): number => a.login.localeCompare(b.login, 'es', { sensitivity: 'base' });
const roleRank = (account: AdminAccount): number => SITE_ROLES.indexOf(account.siteRole);
const lastSeen = (account: AdminAccount): number => (account.lastLoginAt ? Date.parse(account.lastLoginAt) || 0 : 0);

const COMPARE: Record<SortKey, (a: AdminAccount, b: AdminAccount) => number> = {
  role: (a, b) => roleRank(a) - roleRank(b),
  login: () => 0,
  lastLogin: (a, b) => lastSeen(b) - lastSeen(a),
  projects: (a, b) => b.projects - a.projects,
  usage: (a, b) => (b.usage?.bytes ?? 0) - (a.usage?.bytes ?? 0),
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** La foto de la cuenta (solo si es https) o, si no hay o no carga (sin red, bloqueada por la política de contenido del sitio), su inicial. */
function Avatar({ account }: { account: AdminAccount }) {
  const [broken, setBroken] = useState(false);
  const src = safeAvatarUrl(account.avatarUrl);
  return src && !broken ? (
    <img className="pj-avatar" src={src} alt="" width={32} height={32} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className="pj-avatar pj-avatar-empty" aria-hidden="true">
      {account.login.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Cuándo entró por última vez, en una frase corta; con la fecha completa aparte (para el `title`). */
function lastAccess(account: AdminAccount): { text: string; full?: string } {
  if (!account.lastLoginAt) return { text: account.pending ? 'Aún no ha entrado' : '—' };
  const time = Date.parse(account.lastLoginAt);
  if (Number.isNaN(time)) return { text: '—' };
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  const full = new Date(time).toLocaleString('es');
  if (seconds < 60) return { text: 'hace un momento', full };
  if (seconds < 3600) return { text: `hace ${Math.round(seconds / 60)} min`, full };
  if (seconds < 86400) return { text: `hace ${Math.round(seconds / 3600)} h`, full };
  if (seconds < 30 * 86400) return { text: `hace ${plural(Math.round(seconds / 86400), 'día', 'días')}`, full };
  return { text: new Date(time).toLocaleDateString('es'), full };
}

const QUOTA_NAMES = { bytes: 'espacio', projects: 'proyectos', diagramsPerProject: 'diagramas por proyecto' } as const;

/** Un tope en una frase: `sin tope`, `256 MB`, `25`. */
const limitText = (key: keyof typeof QUOTA_NAMES, value: number): string => (value === 0 ? 'sin tope' : key === 'bytes' ? formatBytes(value) : String(value));

/** La cuota personal de una cuenta en una frase: solo lo que tiene fijado ella, no lo que le viene de la instancia. */
function describeQuota(account: AdminAccount): string {
  const own = account.quota ?? {};
  const parts = (Object.keys(QUOTA_NAMES) as Array<keyof typeof QUOTA_NAMES>).flatMap((key) => (own[key] === undefined ? [] : [`${QUOTA_NAMES[key]} ${limitText(key, own[key])}`]));
  return parts.length > 0 ? parts.join(', ') : 'los de la instancia';
}

const LEVEL_TEXT = { near: 'Cerca del tope', full: 'Tope alcanzado' } as const;

/**
 * Qué le pasa a la persona según el error del servidor. El mensaje del servidor es claro y viene en español: se conserva (es lo que de verdad dijo
 * el servicio) y, cuando hay algo que hacer, se añade qué.
 */
function explain(error: unknown): string {
  if (!(error instanceof ProjectError)) return error instanceof Error ? error.message : String(error);
  if (error.code === 'forbidden') return `${error.message} Puede que tu rol en la instancia haya cambiado: cierra este cuadro y revisa «Dónde se guardan».`;
  if (error.code === 'unauthorized') return 'Tu sesión caducó (o se cerró desde otro sitio): cierra este cuadro e inicia sesión de nuevo en «Dónde se guardan».';
  if (error.info.serverCode === 'listed-admin') return `${error.message} Para cambiarlo hay que editar la lista --admins (IARK_ADMINS) del servicio.`;
  return error.message;
}

/**
 * «Administración de la instancia»: las cuentas de un servicio con inicio de sesión de GitHub (`/api/admin/users`). Solo lo abre quien administra
 * la instancia (el servidor lo vuelve a comprobar en cada petición: si el rol cambia mientras está abierto, la pantalla se cierra a los datos).
 *
 * Decisiones de diseño:
 * - El rol no se cambia al mover el `<select>`: un `<select>` cerrado dispara `change` con cada flecha del teclado y daría el rol de administrador
 *   a quien se pasara de largo. El cambio queda como borrador en la fila, con «Guardar rol» (y un aviso si es de administrador) y «Descartar».
 * - Desactivar una cuenta y cancelar una invitación piden confirmación en la propia fila (con el foco en «No»); reactivar y cambiar el rol no:
 *   se deshacen con otro clic.
 * - Los errores del servidor se muestran con su mensaje y la pantalla vuelve a leer la lista: lo que se ve es lo que dice el servidor, y lo escrito en el
 *   formulario de invitar no se borra.
 * - La propia cuenta y las de `--admins` se muestran, pero sin controles que el servidor rechazaría (409 `self` y `listed-admin`): dicen por qué.
 */
export function AdminDialog({ session, me, onClose, notify }: AdminDialogProps) {
  const host = session.backend.kind === 'remote' ? session.backend.host : undefined;
  const [accounts, setAccounts] = useState<AdminAccount[] | undefined>();
  /** La lista no se pudo leer y no hay nada que mostrar: no es administrador (ya o todavía), la sesión caducó o no se llega al servidor. */
  const [blocked, setBlocked] = useState<{ code: 'forbidden' | 'unauthorized' | 'other'; message: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('role');
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<SiteRole>('member');
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<{ id: string; kind: 'disable' | 'cancel' } | undefined>();
  /** Roles elegidos que todavía no se han guardado, por id de cuenta. */
  const [drafts, setDrafts] = useState<Record<string, SiteRole>>({});
  /** La cuenta cuya cuota se está editando, con el borrador de sus tres topes (el espacio, en MB) y, si lo escrito no vale, por qué. */
  const [quotaEdit, setQuotaEdit] = useState<{ id: string; draft: QuotaDraft; error?: string } | undefined>();
  const dialog = useRef<HTMLDivElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<FocusTarget | undefined>(undefined);
  const loaded = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // El cuadro se abre con el foco dentro (en el propio cuadro: aún no hay nada más que pulsar) y, al cerrarse, devuelve el foco a quien lo abrió.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    return () => {
      alive.current = false;
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await session.listAccounts();
      if (!alive.current) return;
      loaded.current = true;
      setAccounts(list);
      setBlocked(undefined);
      // un borrador que ya es el rol de la cuenta (o de una cuenta que ya no está) y una confirmación de una cuenta que ya no está, se descartan
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id, draft]) => list.some((a) => a.id === id && a.siteRole !== draft))));
      setConfirming((current) => (current && list.some((a) => a.id === current.id) ? current : undefined));
      setQuotaEdit((current) => (current && list.some((a) => a.id === current.id) ? current : undefined));
    } catch (e) {
      if (!alive.current) return;
      const message = explain(e);
      if (e instanceof ProjectError && (e.code === 'forbidden' || e.code === 'unauthorized')) setBlocked({ code: e.code, message });
      else if (!loaded.current) setBlocked({ code: 'other', message });
      else setError((previous) => previous ?? message); // con la lista ya en pantalla, el fallo que causó esta lectura es el que importa
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cuando termina lo que se estaba haciendo, el foco vuelve a la fila (o al formulario) donde estaba la persona, no a la nada.
  useEffect(() => {
    const want = focusAfter.current;
    if (!want || busy) return;
    focusAfter.current = undefined;
    if (want === 'invite') {
      inviteInput.current?.focus();
      return;
    }
    const row = [...(dialog.current?.querySelectorAll<HTMLElement>('[data-account]') ?? [])].find((el) => el.getAttribute('data-account') === want.id);
    (row?.querySelector<HTMLElement>(`[data-focus="${want.target}"]:not(:disabled)`) ?? searchInput.current)?.focus();
  });

  /** Una operación sobre una cuenta: sin errores ni avisos anteriores; si falla, el mensaje del servidor y la lista como la tiene el servidor. */
  const act = async (work: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(`${failure} ${explain(e)}`);
      await load();
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const said = (text: string): void => {
    setNote(text);
    notify?.(text);
  };

  const invite = (event: FormEvent): void => {
    event.preventDefault();
    const name = login.trim().replace(/^@/, '');
    const refuse = (text: string): void => {
      setInviteError(text);
      inviteInput.current?.focus();
    };
    if (!INSTANCE_LOGIN.test(name)) return refuse('Escribe un nombre de usuario de GitHub válido: letras, números y guiones (sin espacios), hasta 39 caracteres.');
    // Un nombre que ya existe no se invita: el servidor, ante un nombre que conoce, no invita sino que cambia su rol. Esa cuenta se cambia en la lista.
    const same = accounts?.find((a) => a.login.toLowerCase() === name.toLowerCase());
    if (same) {
      return refuse(
        same.pending
          ? `@${same.login} ya tiene una invitación pendiente (${SITE_ROLE_TITLE[same.siteRole].toLowerCase()}). Cambia su rol en la lista o cancela la invitación.`
          : `@${same.login} ya tiene cuenta en la instancia (${SITE_ROLE_TITLE[same.siteRole].toLowerCase()}). Cambia su rol en la lista.`,
      );
    }
    void (async () => {
      setBusy(true);
      setError(undefined);
      setNote(undefined);
      setInviteError(undefined);
      try {
        const { account, created } = await session.setAccount(name, { siteRole: role });
        setLogin('');
        setQuery('');
        setFilter('all'); // que la cuenta nueva se vea en la lista
        said(
          created
            ? `Se invitó a @${account.login} como ${SITE_ROLE_TITLE[account.siteRole].toLowerCase()}: tendrá acceso en cuanto entre con esa cuenta de GitHub.`
            : `@${account.login} ya tenía cuenta: ahora su rol es ${SITE_ROLE_TITLE[account.siteRole].toLowerCase()}.`,
        );
        await load();
      } catch (e) {
        if (alive.current) setInviteError(`No se pudo invitar a @${name}. ${explain(e)}`);
        await load();
      } finally {
        focusAfter.current = 'invite';
        if (alive.current) setBusy(false);
      }
    })();
  };

  const saveRole = (account: AdminAccount): void => {
    const next = drafts[account.id];
    if (!next || next === account.siteRole) return;
    focusAfter.current = { id: account.id, target: 'role' };
    void act(async () => {
      const result = await session.setAccount(account.login, { siteRole: next });
      said(`@${result.account.login} ahora es ${SITE_ROLE_TITLE[result.account.siteRole].toLowerCase()}.`);
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== account.id)));
      await load();
    }, `No se pudo cambiar el rol de @${account.login}.`);
  };

  const discardRole = (account: AdminAccount): void => {
    setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== account.id)));
    focusAfter.current = { id: account.id, target: 'role' };
  };

  const setDisabled = (account: AdminAccount, disabled: boolean): void => {
    focusAfter.current = { id: account.id, target: 'toggle' };
    setConfirming(undefined);
    void act(
      async () => {
        await session.setAccount(account.login, { disabled });
        said(disabled ? `@${account.login} quedó desactivada: se cerraron sus sesiones y no podrá volver a entrar.` : `@${account.login} se reactivó: puede volver a entrar.`);
        await load();
      },
      disabled ? `No se pudo desactivar a @${account.login}.` : `No se pudo reactivar a @${account.login}.`,
    );
  };

  const cancelInvitation = (account: AdminAccount): void => {
    focusAfter.current = { id: account.id, target: 'toggle' }; // si la fila ya no está, el foco va a la búsqueda
    setConfirming(undefined);
    void act(async () => {
      await session.cancelInvitation(account.login);
      said(`Se canceló la invitación de @${account.login}: ya no puede entrar.`);
      await load();
    }, `No se pudo cancelar la invitación de @${account.login}.`);
  };

  const stopConfirming = (account: AdminAccount): void => {
    setConfirming(undefined);
    focusAfter.current = { id: account.id, target: 'toggle' };
  };

  const startQuota = (account: AdminAccount): void => {
    setConfirming(undefined);
    setQuotaEdit({ id: account.id, draft: draftOf(account.quota, account.limits) });
  };

  const stopQuota = (account: AdminAccount): void => {
    setQuotaEdit(undefined);
    focusAfter.current = { id: account.id, target: 'quota' };
  };

  const saveQuota = (account: AdminAccount): void => {
    if (!quotaEdit || quotaEdit.id !== account.id) return;
    const result = quotaChangeOf(quotaEdit.draft);
    if ('error' in result) {
      setQuotaEdit({ ...quotaEdit, error: result.error });
      return;
    }
    focusAfter.current = { id: account.id, target: 'quota' };
    void act(async () => {
      const saved = await session.setAccount(account.login, { quota: result.change });
      said(
        saved.account.quota
          ? `Se guardó la cuota de @${saved.account.login}: ${describeQuota(saved.account)}.`
          : `@${saved.account.login} vuelve a los topes de la instancia.`,
      );
      setQuotaEdit(undefined);
      await load();
    }, `No se pudo guardar la cuota de @${account.login}.`);
  };

  const editDraft = (key: keyof QuotaDraft, patch: Partial<QuotaDraft[keyof QuotaDraft]>): void =>
    setQuotaEdit((current) => (current ? { id: current.id, draft: { ...current.draft, [key]: { ...current.draft[key], ...patch } } } : current));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      const editing = accounts?.find((a) => a.id === quotaEdit?.id);
      if (editing) {
        stopQuota(editing);
        return;
      }
      const pending = accounts?.find((a) => a.id === confirming?.id);
      if (pending) stopConfirming(pending);
      else onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Foco atrapado dentro del cuadro.
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const shown = useMemo(() => {
    const needle = fold(query.trim());
    return (accounts ?? [])
      .filter((a) => {
        if (filter === 'pending') return a.pending;
        if (filter === 'disabled') return a.disabled;
        if (filter !== 'all' && a.siteRole !== filter) return false;
        return true;
      })
      .filter((a) => !needle || fold(a.login).includes(needle) || fold(a.name ?? '').includes(needle))
      .sort((a, b) => COMPARE[sort](a, b) || byLogin(a, b));
  }, [accounts, query, filter, sort]);

  const total = accounts?.length ?? 0;
  const admins = accounts?.filter((a) => a.siteRole === 'admin').length ?? 0;
  const pending = accounts?.filter((a) => a.pending).length ?? 0;
  const disabled = accounts?.filter((a) => a.disabled).length ?? 0;
  const filtering = query.trim() !== '' || filter !== 'all';
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | undefined => (sort === key ? (key === 'lastLogin' || key === 'projects' || key === 'usage' ? 'descending' : 'ascending') : undefined);

  const roleOptions = SITE_ROLES.map((r) => (
    <option key={r} value={r}>
      {SITE_ROLE_TITLE[r]}
    </option>
  ));

  /** Lo que ocupa una cuenta frente a sus topes, y el botón para cambiarlos. */
  const usageCell = (account: AdminAccount, open: boolean) => {
    const { usage, limits } = account;
    const level = accountLevel(usage, limits);
    const percent = usage && limits ? percentOf(usage.bytes, limits.bytes) : undefined;
    const own = account.quota && Object.keys(account.quota).length > 0;
    return (
      <div className="pj-admin-quota-cell">
        {usage && limits ? (
          <>
            <span data-testid="admin-usage" data-level={level}>
              {limits.bytes > 0 ? `${formatBytes(usage.bytes)} de ${formatBytes(limits.bytes)}` : `${formatBytes(usage.bytes)} (sin tope)`}
            </span>
            {percent !== undefined && <progress className="pj-quota-bar" value={percent} max={100} aria-label={`Espacio de @${account.login}: ${percent} % del tope`} />}
            <small className="pj-hint" data-testid="admin-usage-projects">
              {limits.projects > 0 ? `${usage.projects} de ${limits.projects} proyectos` : plural(usage.projects, 'proyecto propio', 'proyectos propios')}
              {limits.diagramsPerProject > 0 ? ` · hasta ${plural(limits.diagramsPerProject, 'diagrama', 'diagramas')} cada uno` : ''}
            </small>
          </>
        ) : (
          <small className="pj-hint">{limits ? `Topes: espacio ${limitText('bytes', limits.bytes)}, proyectos ${limitText('projects', limits.projects)}.` : '—'}</small>
        )}
        <span className="pj-admin-states">
          {own && (
            <span className="pj-chip" title={`Cuota propia: ${describeQuota(account)}`} data-testid="admin-own-quota">
              cuota propia
            </span>
          )}
          {(level === 'near' || level === 'full') && (
            <span className={`pj-chip ${level === 'full' ? 'pj-off' : 'pj-near'}`} data-testid="admin-usage-level" data-level={level}>
              {LEVEL_TEXT[level]}
            </span>
          )}
        </span>
        {limits && (
          <button
            type="button"
            onClick={() => (open ? stopQuota(account) : startQuota(account))}
            disabled={busy || !INSTANCE_LOGIN.test(account.login)}
            aria-expanded={open}
            aria-label={`Cuota de @${account.login}`}
            data-focus="quota"
          >
            Cuota…
          </button>
        )}
      </div>
    );
  };

  /** La fila de debajo de una cuenta con el editor de su cuota: por cada tope, el valor de la instancia, sin tope o uno concreto. */
  const quotaEditor = (account: AdminAccount, edit: { id: string; draft: QuotaDraft; error?: string }) => {
    const errorId = `pj-admin-quota-error-${account.id}`;
    const fields: ReadonlyArray<{ key: keyof QuotaDraft; label: string; unit: string }> = [
      { key: 'bytes', label: 'Espacio', unit: 'MB' },
      { key: 'projects', label: 'Proyectos', unit: 'proyectos' },
      { key: 'diagramsPerProject', label: 'Diagramas por proyecto', unit: 'diagramas' },
    ];
    return (
      <tr role="row" className="pj-admin-quota-row" data-testid="admin-quota-row" data-login={account.login}>
        <td role="cell" colSpan={7}>
          <form
            className="pj-admin-quota-form"
            aria-label={`Cuota de @${account.login}`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              saveQuota(account);
            }}
          >
            <div className="pj-admin-quota-fields">
              {fields.map(({ key, label, unit }) => {
                const field = edit.draft[key];
                return (
                  <div className="pj-admin-quota-field" key={key}>
                    <label>
                      {label}
                      <select
                        aria-label={`Tope de ${label.toLowerCase()} de @${account.login}`}
                        value={field.mode}
                        disabled={busy}
                        onChange={(e) => editDraft(key, { mode: e.target.value as QuotaMode })}
                      >
                        <option value="instance">Valor de la instancia</option>
                        <option value="none">Sin tope</option>
                        <option value="custom">Otro valor…</option>
                      </select>
                    </label>
                    {field.mode === 'custom' && (
                      <label>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={key === 'bytes' ? 0.1 : 1}
                          step={key === 'bytes' ? 'any' : 1}
                          aria-label={`${label} de @${account.login}, en ${unit}`}
                          aria-invalid={edit.error ? true : undefined}
                          aria-describedby={edit.error ? errorId : undefined}
                          value={field.amount}
                          disabled={busy}
                          onChange={(e) => editDraft(key, { amount: e.target.value })}
                        />
                        <span aria-hidden="true">{unit}</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            <small className="pj-hint">
              «Valor de la instancia» son los topes con los que arrancó el servicio (<code>--max-bytes</code>, <code>--max-projects</code>, <code>--max-diagrams</code>); los administradores de la
              instancia no tienen tope si no se les fija uno. Se cobran a quien posee el proyecto (su administrador más antiguo) y cuentan los documentos y todo su historial de versiones.
            </small>
            {edit.error && (
              <p className="pj-error pj-admin-field-error" id={errorId} role="alert" data-testid="admin-quota-error">
                {edit.error}
              </p>
            )}
            <span className="pj-actions">
              <button type="submit" className="pj-primary" disabled={busy} aria-label={`Guardar cuota de @${account.login}`}>
                Guardar cuota
              </button>
              <button type="button" onClick={() => stopQuota(account)} disabled={busy} aria-label={`Cancelar el cambio de cuota de @${account.login}`}>
                Cancelar
              </button>
            </span>
          </form>
        </td>
      </tr>
    );
  };

  const row = (account: AdminAccount) => {
    const mine = account.id === me.id;
    const actionable = INSTANCE_LOGIN.test(account.login);
    const reason = !actionable
      ? 'Esta cuenta conserva un nombre que ya usa otra persona en GitHub y el servicio no puede nombrarla: no se administra desde aquí.'
      : mine
        ? 'Es tu cuenta: no puedes cambiar tu propio rol ni desactivarte.'
        : account.listed
          ? 'Figura en --admins: su rol y su acceso los manda esa lista.'
          : undefined;
    const reasonId = `pj-admin-reason-${account.id}`;
    const draft = drafts[account.id];
    const edited = draft !== undefined && draft !== account.siteRole;
    const seen = lastAccess(account);
    const asking = confirming?.id === account.id ? confirming.kind : undefined;
    return (
      <Fragment key={account.id}>
      <tr role="row" data-testid="admin-row" data-account={account.id} data-login={account.login} data-role={account.siteRole} data-pending={account.pending ? 'true' : undefined} data-disabled={account.disabled ? 'true' : undefined}>
        <th scope="row" role="rowheader" className="pj-admin-who">
          <div className="pj-admin-id">
            <Avatar account={account} />
            <span className="pj-admin-name">
              <strong>@{account.login}</strong>
              {mine && <span className="pj-chip"> tú</span>}
              {account.listed && (
                <span className="pj-chip" title="Figura en la lista de administradores del servicio (--admins): su rol y su acceso los manda esa lista">
                  en --admins
                </span>
              )}
              {account.name && account.name !== account.login && <small>{account.name}</small>}
            </span>
          </div>
        </th>
        <td role="cell" data-label="Rol">
          <div className="pj-admin-role">
            <select aria-label={`Rol de @${account.login}`} aria-describedby={reason ? reasonId : undefined} value={draft ?? account.siteRole} disabled={busy || reason !== undefined} data-focus="role" onChange={(e) => setDrafts((previous) => ({ ...previous, [account.id]: e.target.value as SiteRole }))}>
              {roleOptions}
            </select>
            {reason && (
              <small id={reasonId} className="pj-hint">
                {reason}
              </small>
            )}
            {edited && (
              <span className="pj-admin-draft">
                {draft === 'admin' && <small className="pj-hint">Podrá ver y cambiar todas las cuentas y todos los proyectos de la instancia.</small>}
                <span className="pj-actions">
                  <button type="button" className="pj-primary" onClick={() => saveRole(account)} disabled={busy} aria-label={`Guardar rol de @${account.login}`}>
                    Guardar rol
                  </button>
                  <button type="button" onClick={() => discardRole(account)} disabled={busy} aria-label={`Descartar el cambio de rol de @${account.login}`}>
                    Descartar
                  </button>
                </span>
              </span>
            )}
          </div>
        </td>
        <td role="cell" data-label="Estado">
          <span className="pj-admin-states">
            {account.pending && (
              <span className="pj-chip pj-pending" title="La invitaron y todavía no ha entrado con su cuenta de GitHub">
                Invitación pendiente
              </span>
            )}
            {account.disabled && (
              <span className="pj-chip pj-off" title="Un administrador la desactivó: no puede entrar">
                Desactivada
              </span>
            )}
            {!account.pending && !account.disabled && <span className="pj-chip pj-on">Activa</span>}
          </span>
        </td>
        <td role="cell" data-label="Último acceso">
          {account.lastLoginAt ? (
            <time dateTime={account.lastLoginAt} title={seen.full}>
              {seen.text}
            </time>
          ) : (
            seen.text
          )}
        </td>
        <td role="cell" data-label="Proyectos">
          {account.projects}
        </td>
        <td role="cell" data-label="Espacio" className="pj-admin-usage">
          {usageCell(account, quotaEdit?.id === account.id)}
        </td>
        <td role="cell" data-label="Acciones" className="pj-admin-actions">
          {asking ? (
            <span className="pj-confirm" role="alert" data-testid="admin-confirm">
              {asking === 'disable'
                ? `¿Desactivar a @${account.login}? Se cerrarán sus sesiones y no podrá volver a entrar hasta que la reactives.`
                : `¿Cancelar la invitación de @${account.login}? Ya no podrá entrar y se quitará de los proyectos que le hubieran compartido.`}{' '}
              <button type="button" className="pj-danger" onClick={() => (asking === 'disable' ? setDisabled(account, true) : cancelInvitation(account))} disabled={busy}>
                {asking === 'disable' ? 'Sí, desactivar' : 'Sí, cancelar invitación'}
              </button>
              <button type="button" onClick={() => stopConfirming(account)} autoFocus>
                No
              </button>
            </span>
          ) : (
            <span className="pj-actions">
              {account.disabled && (
                <button type="button" onClick={() => setDisabled(account, false)} disabled={busy || !actionable} data-focus="toggle" aria-label={`Reactivar a @${account.login}`}>
                  Reactivar
                </button>
              )}
              {!account.disabled && !account.pending && (
                <button type="button" onClick={() => setConfirming({ id: account.id, kind: 'disable' })} disabled={busy || reason !== undefined} aria-describedby={reason ? reasonId : undefined} data-focus="toggle" aria-label={`Desactivar a @${account.login}`}>
                  Desactivar
                </button>
              )}
              {account.pending && (
                <button type="button" onClick={() => setConfirming({ id: account.id, kind: 'cancel' })} disabled={busy || !actionable} data-focus={account.disabled ? undefined : 'toggle'} aria-label={`Cancelar invitación de @${account.login}`}>
                  Cancelar invitación
                </button>
              )}
            </span>
          )}
        </td>
      </tr>
      {quotaEdit?.id === account.id && quotaEditor(account, quotaEdit)}
      </Fragment>
    );
  };

  return (
    <div className="pj-overlay pj-admin-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog pj-admin" role="dialog" aria-modal="true" aria-labelledby="pj-admin-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown} data-testid="admin-dialog">
        <div className="pj-head">
          <div className="pj-admin-title">
            <h2 id="pj-admin-title">Administración de la instancia</h2>
            <small className="pj-hint">
              {host ? `Servidor ${host} · ` : ''}Entraste como @{me.login}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        {blocked ? (
          <div className="pj-admin-body">
            <p className="pj-error" role="alert" data-testid="admin-blocked" data-code={blocked.code}>
              {blocked.message}
            </p>
            {blocked.code === 'other' && (
              <p>
                <button type="button" onClick={() => void load()} disabled={loading}>
                  {loading ? 'Reintentando…' : 'Reintentar'}
                </button>
              </p>
            )}
          </div>
        ) : (
          <>
            {error && (
              <p className="pj-error" role="alert" data-testid="admin-error">
                {error}
              </p>
            )}
            {note && (
              <p className="pj-ok" role="status" data-testid="admin-note">
                {note}
              </p>
            )}
            <div className="pj-admin-body">
              {accounts === undefined ? (
                <p className="pj-empty" role="status">
                  Cargando las cuentas…
                </p>
              ) : (
                <>
                  <form className="pj-form pj-admin-invite" onSubmit={invite} aria-label="Invitar a una persona" noValidate>
                    <strong>Invitar a una persona</strong>
                    <div className="pj-row">
                      <label className="pj-grow">
                        Usuario de GitHub
                        <input
                          ref={inviteInput}
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="octocat"
                          maxLength={40}
                          value={login}
                          aria-invalid={inviteError ? true : undefined}
                          aria-describedby={inviteError ? 'pj-admin-invite-help pj-admin-invite-error' : 'pj-admin-invite-help'}
                          onChange={(e) => {
                            setLogin(e.target.value);
                            setInviteError(undefined);
                          }}
                        />
                      </label>
                      <label>
                        Rol inicial
                        <select aria-label="Rol inicial de la persona invitada" value={role} onChange={(e) => setRole(e.target.value as SiteRole)}>
                          {roleOptions}
                        </select>
                      </label>
                      <button type="submit" className="pj-primary" disabled={busy || !login.trim()}>
                        Invitar
                      </button>
                    </div>
                    <small id="pj-admin-invite-help" className="pj-hint">
                      La invitación la reclama quien entre con esa cuenta de GitHub; hasta entonces figura como «pendiente» y puedes cancelarla.
                    </small>
                    <details className="pj-admin-roles">
                      <summary>Qué puede hacer cada rol</summary>
                      <ul>
                        {SITE_ROLES.map((r) => (
                          <li key={r}>
                            <strong>{SITE_ROLE_TITLE[r]}</strong>: {SITE_ROLE_HELP[r]}.
                          </li>
                        ))}
                      </ul>
                    </details>
                    {inviteError && (
                      <p className="pj-error pj-admin-field-error" id="pj-admin-invite-error" role="alert" data-testid="admin-invite-error">
                        {inviteError}
                      </p>
                    )}
                  </form>

                  <div className="pj-admin-tools" role="group" aria-label="Buscar y ordenar las cuentas">
                    <label className="pj-grow">
                      Buscar
                      <input ref={searchInput} type="search" autoComplete="off" spellCheck={false} placeholder="Usuario o nombre" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </label>
                    <label>
                      Mostrar
                      <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                        {FILTERS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Ordenar por
                      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                        {SORTS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={() => void load()} disabled={busy || loading}>
                      {loading ? 'Actualizando…' : 'Actualizar'}
                    </button>
                  </div>

                  <p className="pj-hint" role="status" data-testid="admin-count">
                    {filtering ? `Mostrando ${shown.length} de ${plural(total, 'cuenta', 'cuentas')}` : plural(total, 'cuenta', 'cuentas')}
                    {` · ${plural(admins, 'administrador', 'administradores')} · ${plural(pending, 'invitación pendiente', 'invitaciones pendientes')} · ${plural(disabled, 'desactivada', 'desactivadas')}`}
                  </p>

                  {shown.length === 0 ? (
                    <p className="pj-empty" data-testid="admin-empty">
                      {total === 0 ? 'Todavía no hay cuentas.' : 'Ninguna cuenta coincide con la búsqueda.'}{' '}
                      {filtering && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery('');
                            setFilter('all');
                          }}
                        >
                          Quitar filtros
                        </button>
                      )}
                    </p>
                  ) : (
                    <table className="pj-table pj-admin-table" role="table" aria-busy={loading} data-testid="admin-table">
                      <caption className="pj-visually-hidden">Cuentas de la instancia</caption>
                      <thead role="rowgroup">
                        <tr role="row">
                          <th scope="col" role="columnheader" aria-sort={ariaSort('login')}>
                            Cuenta
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('role')}>
                            Rol
                          </th>
                          <th scope="col" role="columnheader">
                            Estado
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('lastLogin')}>
                            Último acceso
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('projects')}>
                            Proyectos
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('usage')}>
                            Espacio y cuota
                          </th>
                          <th scope="col" role="columnheader">
                            <span className="pj-visually-hidden">Acciones</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">{shown.map(row)}</tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
