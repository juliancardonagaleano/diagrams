import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ProjectError, type AdminAccount, type PublicUser, type SiteRole } from '@iark/kernel';
import { projectErrorText } from '../i18n/errores';
import { formatAgo } from '../i18n/format';
import { getLang, t } from '../i18n';
import { useT } from '../i18n/react';
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
const FILTERS: ReadonlyArray<{ id: Filter; label: () => string }> = [
  { id: 'all', label: () => t('adm.filter.all') },
  { id: 'admin', label: () => t('adm.filter.admin') },
  { id: 'member', label: () => t('adm.filter.member') },
  { id: 'guest', label: () => t('adm.filter.guest') },
  { id: 'pending', label: () => t('adm.filter.pending') },
  { id: 'disabled', label: () => t('adm.filter.disabled') },
];

type SortKey = 'role' | 'login' | 'lastLogin' | 'projects' | 'usage';
const SORTS: ReadonlyArray<{ id: SortKey; label: () => string }> = [
  { id: 'role', label: () => t('adm.sort.role') },
  { id: 'login', label: () => t('adm.sort.login') },
  { id: 'lastLogin', label: () => t('adm.sort.lastLogin') },
  { id: 'projects', label: () => t('adm.sort.projects') },
  { id: 'usage', label: () => t('adm.sort.usage') },
];

/** Qué hacer con el foco cuando termina lo que se estaba haciendo y la pantalla se vuelve a pintar. */
type FocusTarget = 'invite' | { id: string; target: 'role' | 'toggle' | 'quota' };

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const byLogin = (a: AdminAccount, b: AdminAccount): number => a.login.localeCompare(b.login, getLang(), { sensitivity: 'base' });
const roleRank = (account: AdminAccount): number => SITE_ROLES.indexOf(account.siteRole);
const lastSeen = (account: AdminAccount): number => (account.lastLoginAt ? Date.parse(account.lastLoginAt) || 0 : 0);

const COMPARE: Record<SortKey, (a: AdminAccount, b: AdminAccount) => number> = {
  role: (a, b) => roleRank(a) - roleRank(b),
  login: () => 0,
  lastLogin: (a, b) => lastSeen(b) - lastSeen(a),
  projects: (a, b) => b.projects - a.projects,
  usage: (a, b) => (b.usage?.bytes ?? 0) - (a.usage?.bytes ?? 0),
};

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
  if (!account.lastLoginAt) return { text: account.pending ? t('adm.never') : '—' };
  return formatAgo(account.lastLoginAt, { days: true }) ?? { text: '—' };
}

const QUOTA_NAMES = {
  bytes: () => t('adm.q.name.bytes'),
  projects: () => t('adm.q.name.projects'),
  diagramsPerProject: () => t('adm.q.name.diagramsPerProject'),
} as const;

/** Un tope en una frase: `sin tope`, `256 MB`, `25`. */
const limitText = (key: keyof typeof QUOTA_NAMES, value: number): string => (value === 0 ? t('adm.q.noLimit') : key === 'bytes' ? formatBytes(value) : String(value));

/** La cuota personal de una cuenta en una frase: solo lo que tiene fijado ella, no lo que le viene de la instancia. */
function describeQuota(account: AdminAccount): string {
  const own = account.quota ?? {};
  const parts = (Object.keys(QUOTA_NAMES) as Array<keyof typeof QUOTA_NAMES>).flatMap((key) => (own[key] === undefined ? [] : [t('adm.q.part', { name: QUOTA_NAMES[key](), value: limitText(key, own[key]) })]));
  return parts.length > 0 ? parts.join(', ') : t('adm.q.instanceLimits');
}

const LEVEL_TEXT = { near: () => t('adm.q.level.near'), full: () => t('adm.q.level.full') } as const;

/**
 * Qué le pasa a la persona según el error del servidor. En español se conserva el mensaje del servidor (es lo que de verdad dijo el servicio) y en otro
 * idioma se traduce por su motivo o código (`projectErrorText`); cuando hay algo que hacer, se añade qué.
 */
function explain(error: unknown): string {
  if (!(error instanceof ProjectError)) return projectErrorText(error);
  if (error.code === 'forbidden') return `${projectErrorText(error)} ${t('adm.roleChanged')}`;
  if (error.code === 'unauthorized') return t('common.sessionExpired');
  if (error.info.serverCode === 'listed-admin') return `${projectErrorText(error)} ${t('adm.listedAdminHint')}`;
  return projectErrorText(error);
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
  const { t, tp, tr, lang } = useT();
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
    if (!INSTANCE_LOGIN.test(name)) return refuse(t('adm.invite.invalid'));
    // Un nombre que ya existe no se invita: el servidor, ante un nombre que conoce, no invita sino que cambia su rol. Esa cuenta se cambia en la lista.
    const same = accounts?.find((a) => a.login.toLowerCase() === name.toLowerCase());
    if (same) {
      return refuse(
        same.pending
          ? t('adm.invite.hasPending', { login: same.login, role: SITE_ROLE_TITLE[same.siteRole].toLowerCase() })
          : t('adm.invite.hasAccount', { login: same.login, role: SITE_ROLE_TITLE[same.siteRole].toLowerCase() }),
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
            ? t('adm.invite.done', { login: account.login, role: SITE_ROLE_TITLE[account.siteRole].toLowerCase() })
            : t('adm.invite.existing', { login: account.login, role: SITE_ROLE_TITLE[account.siteRole].toLowerCase() }),
        );
        await load();
      } catch (e) {
        if (alive.current) setInviteError(`${t('adm.invite.failed', { login: name })} ${explain(e)}`);
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
      said(t('adm.done.role', { login: result.account.login, role: SITE_ROLE_TITLE[result.account.siteRole].toLowerCase() }));
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== account.id)));
      await load();
    }, t('adm.failed.role', { login: account.login }));
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
        said(disabled ? t('adm.done.disabled', { login: account.login }) : t('adm.done.enabled', { login: account.login }));
        await load();
      },
      disabled ? t('adm.failed.disable', { login: account.login }) : t('adm.failed.enable', { login: account.login }),
    );
  };

  const cancelInvitation = (account: AdminAccount): void => {
    focusAfter.current = { id: account.id, target: 'toggle' }; // si la fila ya no está, el foco va a la búsqueda
    setConfirming(undefined);
    void act(async () => {
      await session.cancelInvitation(account.login);
      said(t('adm.done.cancelled', { login: account.login }));
      await load();
    }, t('adm.failed.cancel', { login: account.login }));
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
          ? t('adm.q.saved', { login: saved.account.login, text: describeQuota(saved.account) })
          : t('adm.q.reset', { login: saved.account.login }),
      );
      setQuotaEdit(undefined);
      await load();
    }, t('adm.failed.quota', { login: account.login }));
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
  }, [accounts, query, filter, sort, lang]);

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
              {limits.bytes > 0 ? t('quota.of', { used: formatBytes(usage.bytes), limit: formatBytes(limits.bytes) }) : t('quota.unlimitedUse', { used: formatBytes(usage.bytes) })}
            </span>
            {percent !== undefined && <progress className="pj-quota-bar" value={percent} max={100} aria-label={t('adm.q.spaceAria', { login: account.login, percent })} />}
            <small className="pj-hint" data-testid="admin-usage-projects">
              {limits.projects > 0 ? t('adm.q.projectsOf', { used: usage.projects, limit: limits.projects }) : tp('adm.q.ownProjects', usage.projects)}
              {limits.diagramsPerProject > 0 ? ` · ${tp('adm.q.diagramsEach', limits.diagramsPerProject)}` : ''}
            </small>
          </>
        ) : (
          <small className="pj-hint">{limits ? t('adm.q.limits', { bytes: limitText('bytes', limits.bytes), projects: limitText('projects', limits.projects) }) : '—'}</small>
        )}
        <span className="pj-admin-states">
          {own && (
            <span className="pj-chip" title={t('adm.q.ownTitle', { text: describeQuota(account) })} data-testid="admin-own-quota">
              {t('adm.q.own')}
            </span>
          )}
          {(level === 'near' || level === 'full') && (
            <span className={`pj-chip ${level === 'full' ? 'pj-off' : 'pj-near'}`} data-testid="admin-usage-level" data-level={level}>
              {LEVEL_TEXT[level]()}
            </span>
          )}
        </span>
        {limits && (
          <button
            type="button"
            onClick={() => (open ? stopQuota(account) : startQuota(account))}
            disabled={busy || !INSTANCE_LOGIN.test(account.login)}
            aria-expanded={open}
            aria-label={t('adm.q.of', { login: account.login })}
            data-focus="quota"
          >
            {t('adm.q.open')}
          </button>
        )}
      </div>
    );
  };

  /** La fila de debajo de una cuenta con el editor de su cuota: por cada tope, el valor de la instancia, sin tope o uno concreto. */
  const quotaEditor = (account: AdminAccount, edit: { id: string; draft: QuotaDraft; error?: string }) => {
    const errorId = `pj-admin-quota-error-${account.id}`;
    const fields: ReadonlyArray<{ key: keyof QuotaDraft; label: string; unit: string }> = [
      { key: 'bytes', label: t('adm.q.space'), unit: t('adm.q.unit.mb') },
      { key: 'projects', label: t('adm.q.projects'), unit: t('adm.q.unit.projects') },
      { key: 'diagramsPerProject', label: t('adm.q.diagrams'), unit: t('adm.q.unit.diagrams') },
    ];
    return (
      <tr role="row" className="pj-admin-quota-row" data-testid="admin-quota-row" data-login={account.login}>
        <td role="cell" colSpan={7}>
          <form
            className="pj-admin-quota-form"
            aria-label={t('adm.q.of', { login: account.login })}
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
                        aria-label={t('adm.q.limitOf', { label: label.toLowerCase(), login: account.login })}
                        value={field.mode}
                        disabled={busy}
                        onChange={(e) => editDraft(key, { mode: e.target.value as QuotaMode })}
                      >
                        <option value="instance">{t('adm.q.mode.instance')}</option>
                        <option value="none">{t('adm.q.mode.none')}</option>
                        <option value="custom">{t('adm.q.mode.custom')}</option>
                      </select>
                    </label>
                    {field.mode === 'custom' && (
                      <label>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={key === 'bytes' ? 0.1 : 1}
                          step={key === 'bytes' ? 'any' : 1}
                          aria-label={t('adm.q.amountOf', { label, login: account.login, unit })}
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
              {tr('adm.q.help')}
            </small>
            {edit.error && (
              <p className="pj-error pj-admin-field-error" id={errorId} role="alert" data-testid="admin-quota-error">
                {edit.error}
              </p>
            )}
            <span className="pj-actions">
              <button type="submit" className="pj-primary" disabled={busy} aria-label={t('adm.q.saveAria', { login: account.login })}>
                {t('adm.q.save')}
              </button>
              <button type="button" onClick={() => stopQuota(account)} disabled={busy} aria-label={t('adm.q.cancelAria', { login: account.login })}>
                {t('common.cancel')}
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
      ? t('adm.row.unnameable')
      : mine
        ? t('adm.row.mine')
        : account.listed
          ? t('adm.row.listedReason')
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
              {mine && <span className="pj-chip"> {t('adm.row.you')}</span>}
              {account.listed && (
                <span className="pj-chip" title={t('adm.row.listedTitle')}>
                  {t('adm.row.listed')}
                </span>
              )}
              {account.name && account.name !== account.login && <small>{account.name}</small>}
            </span>
          </div>
        </th>
        <td role="cell" data-label={t('adm.col.role')}>
          <div className="pj-admin-role">
            <select aria-label={t('adm.row.roleOf', { login: account.login })} aria-describedby={reason ? reasonId : undefined} value={draft ?? account.siteRole} disabled={busy || reason !== undefined} data-focus="role" onChange={(e) => setDrafts((previous) => ({ ...previous, [account.id]: e.target.value as SiteRole }))}>
              {roleOptions}
            </select>
            {reason && (
              <small id={reasonId} className="pj-hint">
                {reason}
              </small>
            )}
            {edited && (
              <span className="pj-admin-draft">
                {draft === 'admin' && <small className="pj-hint">{t('adm.row.adminWarning')}</small>}
                <span className="pj-actions">
                  <button type="button" className="pj-primary" onClick={() => saveRole(account)} disabled={busy} aria-label={t('adm.row.saveRoleAria', { login: account.login })}>
                    {t('adm.row.saveRole')}
                  </button>
                  <button type="button" onClick={() => discardRole(account)} disabled={busy} aria-label={t('adm.row.discardAria', { login: account.login })}>
                    {t('adm.row.discard')}
                  </button>
                </span>
              </span>
            )}
          </div>
        </td>
        <td role="cell" data-label={t('adm.col.state')}>
          <span className="pj-admin-states">
            {account.pending && (
              <span className="pj-chip pj-pending" title={t('adm.row.pendingTitle')}>
                {t('adm.row.pending')}
              </span>
            )}
            {account.disabled && (
              <span className="pj-chip pj-off" title={t('adm.row.disabledTitle')}>
                {t('adm.row.disabled')}
              </span>
            )}
            {!account.pending && !account.disabled && <span className="pj-chip pj-on">{t('adm.row.active')}</span>}
          </span>
        </td>
        <td role="cell" data-label={t('adm.col.lastAccess')}>
          {account.lastLoginAt ? (
            <time dateTime={account.lastLoginAt} title={seen.full}>
              {seen.text}
            </time>
          ) : (
            seen.text
          )}
        </td>
        <td role="cell" data-label={t('adm.col.projects')}>
          {account.projects}
        </td>
        <td role="cell" data-label={t('adm.col.space')} className="pj-admin-usage">
          {usageCell(account, quotaEdit?.id === account.id)}
        </td>
        <td role="cell" data-label={t('adm.col.actions')} className="pj-admin-actions">
          {asking ? (
            <span className="pj-confirm" role="alert" data-testid="admin-confirm">
              {asking === 'disable'
                ? t('adm.row.confirmDisable', { login: account.login })
                : t('adm.row.confirmCancel', { login: account.login })}{' '}
              <button type="button" className="pj-danger" onClick={() => (asking === 'disable' ? setDisabled(account, true) : cancelInvitation(account))} disabled={busy}>
                {asking === 'disable' ? t('adm.row.yesDisable') : t('adm.row.yesCancel')}
              </button>
              <button type="button" onClick={() => stopConfirming(account)} autoFocus>
                {t('common.no')}
              </button>
            </span>
          ) : (
            <span className="pj-actions">
              {account.disabled && (
                <button type="button" onClick={() => setDisabled(account, false)} disabled={busy || !actionable} data-focus="toggle" aria-label={t('adm.row.reenableAria', { login: account.login })}>
                  {t('adm.row.reenable')}
                </button>
              )}
              {!account.disabled && !account.pending && (
                <button type="button" onClick={() => setConfirming({ id: account.id, kind: 'disable' })} disabled={busy || reason !== undefined} aria-describedby={reason ? reasonId : undefined} data-focus="toggle" aria-label={t('adm.row.disableAria', { login: account.login })}>
                  {t('adm.row.disable')}
                </button>
              )}
              {account.pending && (
                <button type="button" onClick={() => setConfirming({ id: account.id, kind: 'cancel' })} disabled={busy || !actionable} data-focus={account.disabled ? undefined : 'toggle'} aria-label={t('adm.row.cancelInviteAria', { login: account.login })}>
                  {t('adm.row.cancelInvite')}
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
            <h2 id="pj-admin-title">{t('adm.title')}</h2>
            <small className="pj-hint">
              {host ? t('adm.subtitleHost', { host, login: me.login }) : t('adm.subtitle', { login: me.login })}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
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
                  {loading ? t('hist.retrying') : t('common.retry')}
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
                  {t('adm.loading')}
                </p>
              ) : (
                <>
                  <form className="pj-form pj-admin-invite" onSubmit={invite} aria-label={t('adm.invite.title')} noValidate>
                    <strong>{t('adm.invite.title')}</strong>
                    <div className="pj-row">
                      <label className="pj-grow">
                        {t('adm.invite.user')}
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
                        {t('adm.invite.role')}
                        <select aria-label={t('adm.invite.roleAria')} value={role} onChange={(e) => setRole(e.target.value as SiteRole)}>
                          {roleOptions}
                        </select>
                      </label>
                      <button type="submit" className="pj-primary" disabled={busy || !login.trim()}>
                        {t('adm.invite.button')}
                      </button>
                    </div>
                    <small id="pj-admin-invite-help" className="pj-hint">
                      {t('adm.invite.help')}
                    </small>
                    <details className="pj-admin-roles">
                      <summary>{t('adm.invite.rolesSummary')}</summary>
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

                  <div className="pj-admin-tools" role="group" aria-label={t('adm.tools')}>
                    <label className="pj-grow">
                      {t('adm.search')}
                      <input ref={searchInput} type="search" autoComplete="off" spellCheck={false} placeholder={t('adm.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
                    </label>
                    <label>
                      {t('adm.show')}
                      <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                        {FILTERS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label()}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('adm.sortBy')}
                      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                        {SORTS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label()}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={() => void load()} disabled={busy || loading}>
                      {loading ? t('hist.refreshing') : t('hist.refresh')}
                    </button>
                  </div>

                  <p className="pj-hint" role="status" data-testid="admin-count">
                    {filtering ? t('adm.showing', { shown: shown.length, total: tp('adm.n.accounts', total) }) : tp('adm.n.accounts', total)}
                    {` · ${tp('adm.n.admins', admins)} · ${tp('adm.n.pending', pending)} · ${tp('adm.n.disabled', disabled)}`}
                  </p>

                  {shown.length === 0 ? (
                    <p className="pj-empty" data-testid="admin-empty">
                      {total === 0 ? t('adm.emptyNone') : t('adm.emptyNoMatch')}{' '}
                      {filtering && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery('');
                            setFilter('all');
                          }}
                        >
                          {t('adm.clearFilters')}
                        </button>
                      )}
                    </p>
                  ) : (
                    <table className="pj-table pj-admin-table" role="table" aria-busy={loading} data-testid="admin-table">
                      <caption className="pj-visually-hidden">{t('adm.caption')}</caption>
                      <thead role="rowgroup">
                        <tr role="row">
                          <th scope="col" role="columnheader" aria-sort={ariaSort('login')}>
                            {t('adm.col.account')}
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('role')}>
                            {t('adm.col.role')}
                          </th>
                          <th scope="col" role="columnheader">
                            {t('adm.col.state')}
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('lastLogin')}>
                            {t('adm.col.lastAccess')}
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('projects')}>
                            {t('adm.col.projects')}
                          </th>
                          <th scope="col" role="columnheader" aria-sort={ariaSort('usage')}>
                            {t('adm.col.spaceQuota')}
                          </th>
                          <th scope="col" role="columnheader">
                            <span className="pj-visually-hidden">{t('adm.col.actions')}</span>
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
