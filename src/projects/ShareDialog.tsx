import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ProjectError, type ProjectMember, type ProjectRole } from '@iark/kernel';
import { GITHUB_LOGIN, PROJECT_ROLE_HELP, PROJECT_ROLE_LABEL, PROJECT_ROLES, safeAvatarUrl } from './people';
import type { ProjectSession } from './session';

export interface ShareDialogProps {
  session: ProjectSession;
  project: { id: string; name: string };
  onClose(): void;
  notify?(message: string): void;
  /** Quien llama salió del proyecto (ya no le pertenece): el gestor lo quita de su lista. */
  onLeft?(): void;
}

/** Qué le pasa a la persona según el error del servidor al compartir. El mensaje del servidor es claro y viene en español: se conserva y se añade qué hacer. */
function explain(error: unknown): string {
  if (!(error instanceof ProjectError)) return (error as Error).message;
  if (error.code === 'forbidden') return `${error.message} Solo quien administra el proyecto puede cambiar quién tiene acceso.`;
  if (error.code === 'not-found') return `${error.message} Puede que el proyecto ya no exista o que ya no tengas acceso a él.`;
  if (error.code === 'unauthorized') return 'Tu sesión caducó: cierra este cuadro e inicia sesión de nuevo en «Dónde se guardan».';
  return error.message;
}

/**
 * «Compartir…»: quién tiene acceso a un proyecto de un servidor con cuentas y con qué rol. Solo lo abre quien administra el proyecto (el servidor
 * lo vuelve a comprobar). Se da acceso por el nombre de usuario de GitHub: si la persona todavía no ha entrado al servicio queda como pendiente y
 * lo tendrá cuando entre con esa cuenta. Un proyecto no se queda sin administrador (el servidor se niega).
 */
export function ShareDialog({ session, project, onClose, notify, onLeft }: ShareDialogProps) {
  const [members, setMembers] = useState<ProjectMember[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [confirming, setConfirming] = useState<string | undefined>();
  const dialog = useRef<HTMLDivElement>(null);
  const loginInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = async (): Promise<void> => {
    try {
      const list = await session.listMembers(project.id);
      if (alive.current) setMembers(list);
    } catch (e) {
      if (alive.current) {
        setMembers((previous) => previous ?? []);
        setError(explain(e));
      }
    }
  };
  useEffect(() => {
    void load();
    loginInput.current?.focus();
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(explain(e));
      await load(); // lo que la pantalla muestra vuelve a ser lo que dice el servidor (un rol que no se pudo cambiar, alguien ya quitado…)
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const add = (event: FormEvent): void => {
    event.preventDefault();
    const name = login.trim().replace(/^@/, '');
    if (!GITHUB_LOGIN.test(name)) {
      setNote(undefined);
      setError('Escribe un nombre de usuario de GitHub válido: letras, números y guiones (sin espacios), hasta 39 caracteres.');
      loginInput.current?.focus();
      return;
    }
    void act(async () => {
      const member = await session.setMember(project.id, name, role);
      setLogin('');
      const text = member.pending
        ? `Se dio acceso a @${member.login} como ${PROJECT_ROLE_LABEL[member.role].toLowerCase()}: lo tendrá en cuanto entre al servidor con esa cuenta de GitHub.`
        : `@${member.login} ahora tiene el rol de ${PROJECT_ROLE_LABEL[member.role].toLowerCase()}.`;
      setNote(text);
      notify?.(text);
      await load();
    });
  };

  const changeRole = (member: ProjectMember, next: ProjectRole): void =>
    void act(async () => {
      if (next === member.role) return;
      await session.setMember(project.id, member.login, next);
      setNote(`@${member.login} ahora tiene el rol de ${PROJECT_ROLE_LABEL[next].toLowerCase()}.`);
      await load();
    });

  const remove = (member: ProjectMember): void =>
    void act(async () => {
      await (member.you ? session.leaveProject(project.id) : session.removeMember(project.id, member.login));
      setConfirming(undefined);
      if (member.you) {
        const text = `Saliste de «${project.name}».`;
        notify?.(text);
        onLeft?.();
        onClose();
        return;
      }
      setNote(`@${member.login} ya no tiene acceso a «${project.name}».`);
      await load();
    });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirming) setConfirming(undefined);
      else onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Foco atrapado dentro del cuadro.
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const roleSelect = (label: string, value: ProjectRole, onChange: (role: ProjectRole) => void, disabled = false) => (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ProjectRole)}>
      {PROJECT_ROLES.map((r) => (
        <option key={r} value={r}>
          {PROJECT_ROLE_LABEL[r]}
        </option>
      ))}
    </select>
  );

  return (
    <div className="pj-overlay pj-share-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog pj-share" role="dialog" aria-modal="true" aria-labelledby="pj-share-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown} data-testid="share-dialog">
        <header className="pj-head">
          <h2 id="pj-share-title">Compartir «{project.name}»</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>
        {error && (
          <p className="pj-error" role="alert" data-testid="share-error">
            {error}
          </p>
        )}
        {note && (
          <p className="pj-ok" role="status" data-testid="share-note">
            {note}
          </p>
        )}
        <div className="pj-share-body">
          <ul className="pj-members" aria-label="Personas con acceso" data-testid="share-members">
            {members === undefined && <li className="pj-empty">Cargando…</li>}
            {members?.map((m) => {
              const avatar = safeAvatarUrl(m.avatarUrl);
              return (
                <li key={m.login} className="pj-member" data-login={m.login} data-role={m.role} data-pending={m.pending ? 'true' : undefined}>
                  {avatar ? <img className="pj-avatar" src={avatar} alt="" width={32} height={32} referrerPolicy="no-referrer" /> : <span className="pj-avatar pj-avatar-empty" aria-hidden="true">{m.login.slice(0, 1).toUpperCase()}</span>}
                  <span className="pj-member-who">
                    <strong>@{m.login}</strong>
                    {m.you && <span className="pj-chip"> tú</span>}
                    {m.pending && (
                      <span className="pj-chip pj-pending" title="La invitaron y todavía no ha entrado al servidor con su cuenta de GitHub">
                        pendiente
                      </span>
                    )}
                    {m.name && <small>{m.name}</small>}
                  </span>
                  {roleSelect(`Rol de @${m.login}`, m.role, (next) => changeRole(m, next), busy)}
                  {confirming === m.login ? (
                    <span className="pj-confirm" role="alert">
                      {m.you ? `¿Salir de «${project.name}»?` : `¿Quitar a @${m.login}?`}{' '}
                      <button type="button" className="pj-danger" onClick={() => remove(m)} disabled={busy}>
                        {m.you ? 'Sí, salir' : 'Sí, quitar'}
                      </button>
                      <button type="button" onClick={() => setConfirming(undefined)}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirming(m.login)} disabled={busy} aria-label={m.you ? `Salir del proyecto «${project.name}»` : `Quitar a @${m.login}`}>
                      {m.you ? 'Salir' : 'Quitar'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <form className="pj-form" onSubmit={add} aria-label="Dar acceso a otra persona">
            <strong>Dar acceso a otra persona</strong>
            <div className="pj-row">
              <label className="pj-grow">
                Usuario de GitHub
                <input ref={loginInput} type="text" autoComplete="off" spellCheck={false} placeholder="octocat" maxLength={40} value={login} onChange={(e) => setLogin(e.target.value)} />
              </label>
              <label>
                Rol
                {roleSelect('Rol de la persona nueva', role, setRole)}
              </label>
              <button type="submit" className="pj-primary" disabled={busy || !login.trim()}>
                Dar acceso
              </button>
            </div>
            <small className="pj-hint">
              {PROJECT_ROLES.map((r) => `${PROJECT_ROLE_LABEL[r]}: ${PROJECT_ROLE_HELP[r]}`).join(' · ')}. Si la persona todavía no ha entrado al servidor con su cuenta de GitHub, queda como «pendiente» y tendrá acceso en cuanto entre.
            </small>
          </form>
        </div>
      </div>
    </div>
  );
}
