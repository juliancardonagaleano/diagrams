import {
  bundleFileName,
  bundleToText,
  createBundle,
  duplicateDiagram,
  importBundle,
  parseBundle,
  ProjectError,
  snapshotProject,
  type AccountChange,
  type AdminAccount,
  type Diagram,
  type DiagramMeta,
  type HttpProjectStore,
  type ImportedProject,
  type ProjectErrorCode,
  type ProjectMember,
  type ProjectRole,
  type ProjectStore,
  type ProjectSummary,
  type RemoteSession,
} from '@iark/kernel';
import { hostOf, LAST_KEY } from './backend';
import { isTransient, OfflineQueue, type PendingChange, type PendingStatus } from './offlineQueue';
import { OfflineSync, type IdentityMemory, type LockManagerLike, type OfflineSnapshot, type SyncHost } from './offlineSync';
import type { RetryPolicy } from './offlineQueue';

/**
 * Sesión de proyectos de una pantalla (banco de trabajo o editor C4): qué proyecto y qué diagrama están abiertos, la lista
 * de proyectos, y el guardado automático del diagrama abierto con control de concurrencia. Sin React: la interfaz se
 * suscribe y el anfitrión (el controlador del banco o el editor C4) le pasa el texto cuando cambia.
 */

/**
 * Cómo va el guardado del diagrama abierto. `offline`: con un servidor, el cambio no llegó por la red y está guardado en este
 * navegador esperando (se reenvía solo); `conflict`: el servidor cambió el diagrama y lo tuyo se conserva aparte hasta que decidas.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict' | 'offline';

export interface ProjectsState {
  ready: boolean;
  /** `false` si el almacén no funciona (ventana privada, permisos…): la lista queda vacía y `error` dice por qué. */
  available: boolean;
  error?: string;
  /** Con `available: false`, el código del error (`unauthorized`: el servidor no aceptó el token; `unavailable`: no se llega a él…). */
  errorCode?: ProjectErrorCode;
  projects: ProjectSummary[];
  /** Proyecto abierto: el que se muestra y donde se crean los diagramas nuevos. */
  projectId?: string;
  /** Diagrama del proyecto abierto en el editor; sus cambios se guardan solos. */
  diagramId?: string;
  save: SaveState;
  savedAt?: number;
  saveError?: string;
  saveErrorCode?: ProjectErrorCode;
  /**
   * Solo con un servidor: la última lectura en segundo plano de la lista falló (sin conexión, token…). La lista que se ve es la
   * última que se pudo leer; el almacén sigue «disponible» para que un corte de red no desactive la pantalla.
   */
  syncError?: string;
  syncErrorCode?: ProjectErrorCode;
  /** Solo con un servidor: los cambios guardados en este navegador que esperan a enviarse (ver `offlineSync.ts`). */
  offline?: OfflineSnapshot;
}

/** Dónde se guardan los proyectos de esta sesión: este navegador o un servidor (con su dirección, para mostrarla). */
export type SessionBackend = { kind: 'local' } | { kind: 'remote'; url: string; host: string; label?: string };

/** Dónde se recuerda el último proyecto y diagrama abiertos (por navegador; nunca es el único sitio donde viven los datos). */
export interface LastOpened {
  projectId?: string;
  diagramId?: string;
}
export interface PointerStorage {
  read(): LastOpened | undefined;
  write(value: LastOpened): void;
}

/** El puntero en la clave `key` de localStorage. Cada almacén tiene la suya: los ids de un servidor no se parecen a los del navegador. */
export const pointerAt = (key: string): PointerStorage => ({
  read() {
    try {
      const raw = window.localStorage.getItem(key);
      const value = raw ? (JSON.parse(raw) as LastOpened) : undefined;
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  },
  write(value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
  },
});

/** El puntero del almacén de este navegador (conserva su clave de siempre). */
export const localPointer: PointerStorage = pointerAt(LAST_KEY);

export interface SessionOptions {
  pointer?: PointerStorage;
  /** Espera tras el último cambio antes de guardar. */
  debounceMs?: number;
  /** Avisar a las demás pestañas de los cambios (BroadcastChannel). */
  broadcast?: boolean;
  /** Pide al navegador que no borre el almacenamiento por falta de espacio (`navigator.storage.persist`). Solo cuenta en este navegador. */
  persist?: boolean;
  /** Dónde se guardan los proyectos. Por defecto se deduce del almacén (`http` es un servidor). */
  backend?: SessionBackend;
  /** Nombre del canal de BroadcastChannel: cada almacén usa el suyo, para que una pestaña con servidor y otra local no se avisen entre sí. */
  channel?: string;
  /**
   * Solo con un servidor (no hay BroadcastChannel entre equipos): cada cuántos milisegundos se vuelve a leer la lista mientras
   * alguien la mira y la ventana está visible. `0` lo desactiva. Por defecto, 30 s.
   */
  pollMs?: number;
  /**
   * Solo con un servidor: el trabajo sin conexión. Por omisión, los cambios que no llegan al servidor se guardan en IndexedDB y se
   * reenvían solos; `false` lo desactiva (el cambio queda en memoria, con «Reintentar»). Las pruebas dan su propia cola y reloj.
   */
  offline?: false | { queue?: OfflineQueue; policy?: Partial<RetryPolicy>; now?: () => number; identity?: IdentityMemory; locks?: false | LockManagerLike };
}

/** Cómo se resuelve un conflicto: `reload` se queda con lo del servidor, `overwrite` con lo propio (sobre lo del servidor) y `copy` guarda lo propio como diagrama nuevo. */
export type ConflictChoice = 'overwrite' | 'reload' | 'copy';

const CHANNEL = 'iark-projects';
export const DEFAULT_POLL_MS = 30_000;

/** El almacén que usa una sesión cuando no se le dice: `http` es un servidor y todo lo demás, este navegador. */
function backendOf(store: ProjectStore): SessionBackend {
  const baseUrl = (store as { baseUrl?: unknown }).baseUrl;
  return store.kind === 'http' && typeof baseUrl === 'string' ? { kind: 'remote', url: baseUrl, host: hostOf(baseUrl) } : { kind: 'local' };
}

const codeOf = (error: unknown): ProjectErrorCode | undefined => (error instanceof ProjectError ? error.code : undefined);
const NO_SAVE_ERROR = { saveError: undefined, saveErrorCode: undefined } as const;

export class ProjectSession {
  private state: ProjectsState = { ready: false, available: true, projects: [], save: 'idle' };
  private listeners = new Set<() => void>();
  private pendingText: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private baseUpdatedAt: string | undefined;
  private channel: BroadcastChannel | undefined;
  private persisted = false;
  private readonly pointer: PointerStorage | undefined;
  private readonly debounceMs: number;
  /** Dónde se guardan los proyectos de esta sesión. */
  readonly backend: SessionBackend;
  /** Cuántas pantallas están mirando la lista ahora mismo (el gestor abierto): mientras haya alguna, con un servidor se mantiene al día. */
  private watchers = 0;
  private refreshing: Promise<void> | undefined;
  private stopWatching: (() => void) | undefined;
  /** El trabajo sin conexión (solo con un servidor): guarda en este navegador lo que no llega y lo reenvía solo. */
  private readonly sync: OfflineSync | undefined;
  private stopNetwork: (() => void) | undefined;

  constructor(
    readonly store: ProjectStore,
    private readonly options: SessionOptions = {},
  ) {
    this.pointer = options.pointer;
    this.debounceMs = options.debounceMs ?? 500;
    this.backend = options.backend ?? backendOf(store);
    if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(options.channel ?? CHANNEL);
        this.channel.onmessage = () => void this.refreshQuiet();
      } catch {
        this.channel = undefined;
      }
    }
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    if (this.remote && pollMs > 0) this.startWatching(pollMs);
    if (this.backend.kind === 'remote' && options.offline !== false) {
      const offline = options.offline ?? {};
      this.sync = new OfflineSync(offline.queue ?? new OfflineQueue(), this.syncHost, store, this.backend.url, { policy: offline.policy, now: offline.now, identity: offline.identity, locks: offline.locks });
      this.listenToNetwork();
    }
  }

  // ───────────── trabajo sin conexión ─────────────

  /** Lo que el motor de reenvío necesita saber de la sesión y lo que le cuenta a la sesión. */
  private readonly syncHost: SyncHost = {
    credentialRejected: () => this.state.errorCode === 'unauthorized' || this.state.syncErrorCode === 'unauthorized',
    changed: () => {
      if (this.sync) this.set({ offline: this.sync.snapshot });
    },
    sent: (change, meta) => {
      if (this.isOpen(change)) {
        this.baseUpdatedAt = meta.updatedAt;
        this.set(this.pendingText === undefined ? { save: 'saved', savedAt: Date.now(), ...NO_SAVE_ERROR } : { save: 'pending', ...NO_SAVE_ERROR });
      }
      this.announce();
      void this.refresh({ background: true });
    },
    conflicted: (change) => {
      if (this.isOpen(change)) this.set({ save: 'conflict', saveError: change.reason, saveErrorCode: 'conflict' });
    },
    authRequired: (error, change) => {
      const open = change ? this.isOpen(change) : this.openEntry() !== undefined;
      if (open) this.set({ save: 'error', saveError: error.message, saveErrorCode: error.code });
      else if (error.code === 'unauthorized') this.set({ syncError: error.message, syncErrorCode: error.code });
    },
  };

  private isOpen(change: Pick<PendingChange, 'projectId' | 'diagramId'>): boolean {
    return change.projectId === this.state.projectId && change.diagramId === this.state.diagramId;
  }

  /** El cambio guardado en este navegador del diagrama abierto, si lo hay. */
  private openEntry(): PendingChange | undefined {
    const { projectId, diagramId } = this.state;
    return this.sync && projectId && diagramId ? this.sync.find(projectId, diagramId) : undefined;
  }

  private browserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** Al volver la red, al volver el foco a la ventana y al volver a mostrarla, se reintenta lo que esperaba (con la ventana oculta, el foco no cuenta). */
  private listenToNetwork(): void {
    if (typeof window === 'undefined') return;
    const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const online = (): void => void this.sync?.kick('online');
    const focus = (): void => {
      if (visible()) void this.sync?.kick('focus');
    };
    window.addEventListener('online', online);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    this.stopNetwork = () => {
      window.removeEventListener('online', online);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }

  /** Cuántos cambios de esta persona hay guardados en este navegador sin haber llegado al servidor (con o sin conflicto). */
  get unsentCount(): number {
    const offline = this.state.offline;
    return offline ? offline.waiting + offline.authBlocked + offline.conflicts : 0;
  }

  /** Descarta los cambios sin enviar de esta persona en este servidor (al cerrar sesión, tras confirmarlo). */
  async discardQueued(): Promise<void> {
    await this.sync?.discardMine();
  }

  /** Descarta los cambios sin enviar que dejó otra persona en este navegador (nunca se enviarían con tu credencial). */
  async discardOthersQueued(): Promise<void> {
    await this.sync?.discardForeign();
  }

  /** Reintenta ya lo que espera a poder enviarse («Reintentar ahora»). */
  async retryNow(): Promise<void> {
    await this.sync?.kick('manual');
  }

  /** `true` si los proyectos están en un servidor (y no en este navegador). */
  get remote(): boolean {
    return this.backend.kind === 'remote';
  }

  // ───────────── suscripción ─────────────

  getState = (): ProjectsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ProjectsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get project(): ProjectSummary | undefined {
    return this.state.projects.find((p) => p.id === this.state.projectId);
  }

  get diagram(): DiagramMeta | undefined {
    return this.project?.diagrams.find((d) => d.id === this.state.diagramId);
  }

  // ───────────── arranque y lista ─────────────

  /** Carga la lista. Devuelve lo último que había abierto, si sigue existiendo, para que el anfitrión decida si lo reabre. */
  async init(): Promise<LastOpened | undefined> {
    await this.refresh();
    await this.sync?.ready;
    this.set({ ready: true });
    // Lo que quedó pendiente de otra vez (la pestaña se cerró sin red) se reenvía al abrir. Y se averigua quién es la credencial para que lo que se
    // escriba desde ahora quede guardado a su nombre (y no lo pueda enviar otra persona con otra credencial).
    void this.sync?.verifyQuiet();
    void this.sync?.kick('start');
    const last = this.pointer?.read();
    const project = this.state.projects.find((p) => p.id === last?.projectId);
    if (!project) return undefined;
    this.set({ projectId: project.id });
    return { projectId: project.id, diagramId: project.diagrams.some((d) => d.id === last?.diagramId) ? last?.diagramId : undefined };
  }

  /**
   * Vuelve a leer la lista. Con `background` (lecturas que nadie pidió: tras guardar, el sondeo, un aviso de otra pestaña) un
   * fallo con el almacén ya disponible no lo desactiva: deja el aviso en `syncError` y conserva la lista que había.
   */
  async refresh(options: { background?: boolean } = {}): Promise<void> {
    try {
      const projects = await this.store.listProjects();
      const projectId = projects.some((p) => p.id === this.state.projectId) ? this.state.projectId : undefined;
      const diagramId = projects.find((p) => p.id === projectId)?.diagrams.some((d) => d.id === this.state.diagramId) ? this.state.diagramId : undefined;
      // Con un servidor otra persona puede haber borrado el diagrama que se está editando: ya no hay dónde guardar, y lo pendiente
      // se descarta (el texto sigue en el editor como borrador, que se puede guardar de nuevo en el proyecto).
      const lost = this.remote && this.state.diagramId !== undefined && diagramId === undefined;
      if (lost) {
        this.discardPending();
        this.baseUpdatedAt = undefined;
      }
      this.set({ projects, available: true, error: undefined, errorCode: undefined, syncError: undefined, syncErrorCode: undefined, projectId, diagramId, ...(lost ? { save: 'idle' as const, ...NO_SAVE_ERROR } : {}) });
    } catch (error) {
      if (options.background && this.state.available) this.set({ syncError: (error as Error).message, syncErrorCode: codeOf(error) });
      else this.set({ available: false, error: (error as Error).message, errorCode: codeOf(error) });
    }
  }

  /** Lectura en segundo plano que se junta con la que ya esté en curso. Con un servidor un fallo de red no desactiva la pantalla. */
  private refreshQuiet(): Promise<void> {
    this.refreshing ??= this.refresh({ background: this.remote }).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Una pantalla pide que la lista se mantenga al día mientras la mira (el gestor abierto); devuelve cómo dejar de pedirlo.
   * Con un servidor lee la lista al momento. Sin servidor no hace nada: las demás pestañas avisan por BroadcastChannel.
   */
  watch(): () => void {
    this.watchers += 1;
    if (this.remote) void this.refreshQuiet();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers -= 1;
    };
  }

  /**
   * ¿Hay que mantener la lista fresca? Si alguien la mira (el gestor abierto, o un diagrama abierto: la barra del proyecto y los
   * enlaces entre diagramas dependen de ella) y el servidor no está rechazando el token: insistir cada 30 s con un token malo
   * solo suma intentos fallidos (el servidor puede limitarlos). Con un token nuevo (`useToken`) se vuelve a leer.
   */
  private get interested(): boolean {
    const rejected = this.state.errorCode === 'unauthorized' || this.state.syncErrorCode === 'unauthorized';
    return (this.watchers > 0 || this.attached) && !rejected;
  }

  /**
   * Con un servidor no hay aviso entre equipos: la lista se vuelve a leer al volver el foco a la ventana y cada `intervalMs`
   * mientras esté visible, y solo si `interested` (con el gestor cerrado y sin diagrama abierto no hay nada que mantener al día).
   * Los conflictos no dependen de esto: se detectan al guardar (`ifUpdatedAt`), así que no hace falta sondear para verlos.
   * Un guardado que falló por la red se reintenta solo al volver `online` o el foco (con la ventana oculta, el reintento espera).
   */
  private startWatching(intervalMs: number): void {
    if (typeof window === 'undefined') return;
    const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const comeBack = (): void => {
      if (!visible()) return;
      void this.retryTransient();
      if (this.interested) void this.refreshQuiet();
    };
    const online = (): void => {
      void this.retryTransient();
      if (this.interested && visible()) void this.refreshQuiet();
    };
    const tick = (): void => {
      if (visible() && this.interested) void this.refreshQuiet();
    };
    window.addEventListener('focus', comeBack);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', comeBack);
    const interval = setInterval(tick, intervalMs);
    this.stopWatching = () => {
      window.removeEventListener('focus', comeBack);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', comeBack);
      clearInterval(interval);
    };
  }

  /** Reintenta el guardado pendiente si falló por algo que puede pasar solo (red, servidor caído), no por el token ni por el contenido. */
  private async retryTransient(): Promise<void> {
    if (this.state.save === 'error' && this.state.saveErrorCode === 'unavailable' && this.pendingText !== undefined) await this.retry();
  }

  /** Quién es el token ante el servidor (nombre y rol), o `undefined` si el almacén es el de este navegador. */
  async whoami(): Promise<RemoteSession | undefined> {
    const store = this.store as { whoami?: () => Promise<RemoteSession> };
    return store.whoami ? store.whoami() : undefined;
  }

  /** Con qué se identifica esta sesión ante el servidor: una sesión de persona (inicio de sesión de GitHub), un token o nada (un servidor abierto o este navegador). */
  get credential(): 'session' | 'token' | 'none' {
    return (this.store as { credential?: 'session' | 'token' | 'none' }).credential ?? 'none';
  }

  /**
   * Cierra en el servidor la sesión de persona que usa este almacén (`POST /api/auth/logout`): deja de valer aunque alguien la hubiera copiado.
   * Quien llama decide qué hacer con lo guardado en el navegador. `unauthorized` si ya no valía; `invalid` si no era una sesión (un token).
   */
  async logout(): Promise<void> {
    const store = this.store as { logout?: () => Promise<void> };
    if (!store.logout) throw new ProjectError('invalid', 'Este almacén no tiene una sesión que cerrar.');
    await store.logout();
  }

  /**
   * Usa un token nuevo (o ninguno) sin recargar la página, para no perder lo que está pendiente de guardar: relee la lista y
   * reintenta el guardado que falló por no tenerlo (o porque su rol no alcanzaba).
   */
  async useToken(token: string | undefined): Promise<void> {
    (this.store as { setToken?: (token?: string) => void }).setToken?.(token);
    await this.refresh();
    await this.sync?.credentialsChanged();
    const refused = this.state.saveErrorCode === 'unauthorized' || this.state.saveErrorCode === 'forbidden';
    if (this.pendingText !== undefined && this.state.save === 'error' && refused) await this.retry();
  }

  private remember(): void {
    this.pointer?.write({ projectId: this.state.projectId, diagramId: this.state.diagramId });
  }

  private announce(): void {
    try {
      this.channel?.postMessage({ type: 'changed' });
    } catch {
      /* la pestaña se está cerrando */
    }
  }

  /** Pide al navegador almacenamiento persistente (una vez, y solo tras una acción de la persona). Un servidor no lo necesita. */
  private requestPersistence(): void {
    if (this.persisted || this.options.persist === false || this.remote) return;
    this.persisted = true;
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      /* no disponible */
    }
  }

  // ───────────── proyectos ─────────────

  selectProject(id: string | undefined): void {
    if (id === this.state.projectId) return;
    void this.flush();
    this.set({ projectId: id, diagramId: undefined, save: 'idle', ...NO_SAVE_ERROR });
    this.baseUpdatedAt = undefined;
    this.remember();
  }

  async createProject(name: string, description?: string): Promise<ProjectSummary> {
    const project = await this.store.createProject({ name, description });
    this.requestPersistence();
    await this.refresh();
    this.announce();
    this.selectProject(project.id);
    return project;
  }

  async renameProject(id: string, name: string): Promise<void> {
    await this.store.renameProject(id, name);
    await this.refresh();
    this.announce();
  }

  async deleteProject(id: string): Promise<void> {
    if (id === this.state.projectId) {
      this.discardPending();
      this.selectProject(undefined);
    }
    await this.store.deleteProject(id);
    await this.sync?.drop(id);
    await this.refresh();
    this.announce();
  }

  // ───────────── compartir (solo con un servidor con cuentas) ─────────────

  /** ¿Este almacén sabe compartir proyectos? Solo un servidor con cuentas; el servidor decide además a quién se lo deja hacer (administradores del proyecto). */
  get canShare(): boolean {
    return typeof (this.store as { listMembers?: unknown }).listMembers === 'function';
  }

  private get members(): Pick<HttpProjectStore, 'listMembers' | 'setMember' | 'removeMember'> {
    if (!this.canShare) throw new ProjectError('invalid', 'Este almacén no permite compartir proyectos: hace falta un servidor con inicio de sesión de GitHub.');
    return this.store as unknown as HttpProjectStore;
  }

  listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.members.listMembers(projectId);
  }

  /** Da acceso (o cambia el rol) y relee la lista: el rol de quien llama pudo cambiar (un administrador que se degrada a sí mismo). */
  async setMember(projectId: string, login: string, role: ProjectRole): Promise<ProjectMember> {
    const member = await this.members.setMember(projectId, login, role);
    await this.refresh({ background: true });
    return member;
  }

  /** Quita el acceso de una persona y relee la lista. */
  async removeMember(projectId: string, login: string): Promise<void> {
    await this.members.removeMember(projectId, login);
    await this.refresh({ background: true });
  }

  /**
   * Quien llama sale del proyecto (deja de pertenecer a él, sin borrarlo): el servidor lo quita de sus miembros y el proyecto desaparece de su lista.
   * Se busca a quien llama por la marca `you` de la lista de miembros, así no depende de que se sepa su nombre de usuario.
   */
  async leaveProject(projectId: string): Promise<void> {
    const me = (await this.members.listMembers(projectId)).find((m) => m.you);
    if (!me) throw new ProjectError('not-found', 'Ya no perteneces a este proyecto.');
    if (projectId === this.state.projectId) {
      this.discardPending();
      this.selectProject(undefined);
    }
    await this.members.removeMember(projectId, me.login);
    await this.sync?.drop(projectId);
    await this.refresh({ background: true });
  }

  // ───────────── administrar la instancia (solo con un servidor con cuentas) ─────────────

  /** ¿Este almacén sabe administrar cuentas? Solo un servidor; que la persona sea administradora de la instancia lo decide el servidor (403 si no). */
  get canAdminister(): boolean {
    return typeof (this.store as { listAccounts?: unknown }).listAccounts === 'function';
  }

  private get accounts(): Pick<HttpProjectStore, 'listAccounts' | 'setAccount' | 'cancelInvitation'> {
    if (!this.canAdminister) throw new ProjectError('invalid', 'Este almacén no administra cuentas: hace falta un servidor con inicio de sesión de GitHub.');
    return this.store as unknown as HttpProjectStore;
  }

  /** Las cuentas de la instancia (y sus invitaciones sin reclamar). `forbidden` si quien llama no la administra. */
  listAccounts(): Promise<AdminAccount[]> {
    return this.accounts.listAccounts();
  }

  /** Cambia el rol o la activación de una cuenta; con un nombre que no existe, la invita (`created`). */
  setAccount(login: string, change: AccountChange): Promise<{ account: AdminAccount; created: boolean }> {
    return this.accounts.setAccount(login, change);
  }

  /** Cancela la invitación de quien todavía no ha entrado. */
  cancelInvitation(login: string): Promise<void> {
    return this.accounts.cancelInvitation(login);
  }

  /** El proyecto completo en el archivo único: nombre sugerido y contenido. */
  async exportProject(id: string): Promise<{ fileName: string; text: string }> {
    await this.flush();
    const snapshot = await snapshotProject(this.store, id);
    return { fileName: bundleFileName(snapshot.name), text: bundleToText(createBundle(snapshot, { generator: 'IArk - DIAgrams' })) };
  }

  /** Crea un proyecto nuevo con el contenido del archivo y lo abre. Nunca pisa uno existente. */
  async importProject(text: string, name?: string): Promise<ImportedProject> {
    const imported = await importBundle(this.store, parseBundle(text), { name });
    this.requestPersistence();
    await this.refresh();
    this.announce();
    this.selectProject(imported.project.id);
    return imported;
  }

  // ───────────── diagramas ─────────────

  /** Abre un diagrama: guarda lo pendiente del anterior, lo adjunta (sus cambios se guardan solos) y lo devuelve. */
  async openDiagram(projectId: string, diagramId: string): Promise<Diagram> {
    await this.flush();
    await this.sync?.ready;
    const queued = this.sync?.find(projectId, diagramId);
    const found = await this.store.getDiagram(projectId, diagramId);
    if (!found && !queued) throw new ProjectError('not-found', 'El diagrama ya no existe en el proyecto.');
    // Si quedó trabajo sin enviar de este diagrama (la pestaña se cerró sin red), lo que se abre es ese trabajo y no la versión del servidor:
    // sigue esperando para enviarse sobre la marca del servidor en la que se escribió, así que un cambio ajeno se detecta como conflicto.
    const diagram: Diagram = queued
      ? { id: diagramId, module: queued.module ?? found?.module ?? '', name: found?.name ?? queued.name, createdAt: found?.createdAt ?? queued.baseUpdatedAt, updatedAt: found?.updatedAt ?? queued.baseUpdatedAt, text: queued.text }
      : found!;
    this.baseUpdatedAt = queued?.baseUpdatedAt ?? diagram.updatedAt;
    this.pendingText = undefined;
    this.set({ projectId, diagramId, ...(queued ? this.stateOf(queued) : { save: 'idle' as const, ...NO_SAVE_ERROR }) });
    this.remember();
    return diagram;
  }

  /** El estado de guardado que corresponde a un cambio guardado en este navegador. */
  private stateOf(change: PendingChange): Pick<ProjectsState, 'save' | 'saveError' | 'saveErrorCode'> {
    if (change.status === 'conflict') return { save: 'conflict', saveError: change.reason, saveErrorCode: 'conflict' };
    if (change.status === 'auth') return { save: 'error', saveError: change.reason, saveErrorCode: this.state.saveErrorCode === 'forbidden' ? 'forbidden' : 'unauthorized' };
    return { save: 'offline', saveError: change.reason, saveErrorCode: 'unavailable' };
  }

  /** Crea un diagrama en el proyecto abierto (o en `projectId`) y lo adjunta. */
  async createDiagram(input: { module: string; name?: string; text: string }, projectId = this.state.projectId): Promise<DiagramMeta> {
    if (!projectId) throw new ProjectError('invalid', 'Abre o crea un proyecto antes de guardar un diagrama en él.');
    await this.flush();
    const meta = await this.store.saveDiagram(projectId, input);
    this.requestPersistence();
    this.baseUpdatedAt = meta.updatedAt;
    this.pendingText = undefined;
    await this.refresh();
    this.set({ projectId, diagramId: meta.id, save: 'saved', savedAt: Date.now(), ...NO_SAVE_ERROR });
    this.remember();
    this.announce();
    return meta;
  }

  async renameDiagram(projectId: string, diagramId: string, name: string): Promise<void> {
    const meta = await this.store.renameDiagram(projectId, diagramId, name);
    if (diagramId === this.state.diagramId) this.baseUpdatedAt = meta.updatedAt;
    await this.refresh();
    this.announce();
  }

  async duplicateDiagram(projectId: string, diagramId: string): Promise<DiagramMeta> {
    await this.flush();
    const copy = await duplicateDiagram(this.store, projectId, diagramId);
    await this.refresh();
    this.announce();
    return copy;
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    if (diagramId === this.state.diagramId) {
      this.discardPending();
      this.detach();
    }
    await this.store.deleteDiagram(projectId, diagramId);
    await this.sync?.drop(projectId, diagramId);
    await this.refresh();
    this.announce();
  }

  /** Guarda lo pendiente y deja de guardar en el diagrama abierto (el documento pasa a ser un borrador suelto). */
  async release(): Promise<void> {
    await this.flush();
    this.detach();
  }

  /** Deja de guardar en el diagrama abierto, descartando lo pendiente (para cuando el diagrama ya no existe). */
  detach(): void {
    this.discardPending();
    this.baseUpdatedAt = undefined;
    this.set({ diagramId: undefined, save: 'idle', ...NO_SAVE_ERROR });
    this.remember();
  }

  // ───────────── guardado automático ─────────────

  get attached(): boolean {
    return this.state.projectId !== undefined && this.state.diagramId !== undefined;
  }

  /** El anfitrión avisa de que el documento del diagrama abierto cambió. Se guarda tras una pausa. */
  queueSave(text: string): void {
    if (!this.attached) return;
    this.pendingText = text;
    // Con un cambio ya guardado en este navegador (sin conexión, en conflicto, esperando credenciales) el estado visible no cambia al seguir
    // escribiendo: «Sin conexión: 1 cambio pendiente» no parpadea a «Guardando…» con cada tecla.
    if (!this.openEntry() && this.state.save !== 'conflict') this.set({ save: 'pending', ...NO_SAVE_ERROR });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  private discardPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingText = undefined;
  }

  /**
   * Guarda ya lo pendiente y espera a que termine (antes de cambiar de diagrama, exportar o salir). Un guardado que falló porque el servidor no
   * acepta la credencial (`unauthorized`: un token revocado o una sesión caducada) no se vuelve a intentar aquí: volvería a fallar y cada fallo
   * cuenta contra el límite de intentos fallidos del servidor, que frena a TODA la dirección (también a quien entre después con una sesión buena).
   * Lo retoma `useToken`, o se pierde si la persona lo decide al cambiar de almacén.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.run();
    } else if (this.pendingText !== undefined && this.state.save === 'error' && this.state.saveErrorCode !== 'unauthorized') {
      await this.run();
    }
    await this.inFlight;
  }

  /**
   * Hay cambios que se perderían si se cierra la pestaña (para avisar al cerrar). Un cambio ya guardado en este navegador (IndexedDB) no cuenta:
   * sobrevive a cerrar la pestaña y se envía al volver. Sí cuenta si ese almacenamiento no es duradero (ventana privada) o no cupo.
   */
  get dirty(): boolean {
    if (this.pendingText !== undefined || this.state.save === 'saving') return true;
    if (this.state.save === 'error' || this.state.save === 'conflict' || this.state.save === 'offline') return !(this.sync?.queue.durable && this.openEntry());
    return false;
  }

  private run(): Promise<void> {
    this.timer = undefined;
    this.inFlight = (this.inFlight ?? Promise.resolve()).then(() => this.write());
    return this.inFlight;
  }

  private async write(): Promise<void> {
    const { projectId, diagramId } = this.state;
    const text = this.pendingText;
    if (text === undefined || !projectId || !diagramId) return;
    const sync = this.sync;
    if (sync) await sync.ready;
    const queued = sync?.find(projectId, diagramId);
    if (this.state.save === 'conflict' && !queued) return;
    // Ya hay un cambio de este diagrama esperando en la cola (o el navegador dice que no hay red): no se llama al servidor con cada pausa, se anota
    // lo último y el motor de reenvío lo envía cuando toca. Así un corte largo no genera una petición por cada edición.
    if (sync && (queued || this.browserOffline())) {
      if (await this.park(text, queued ? 'keep' : 'retry')) {
        if (!queued) sync.noteFailure(new ProjectError('unavailable', 'El navegador está sin conexión.', { network: true }));
        else if (queued.status === 'retry') void sync.kick('edit');
        return;
      }
    }
    this.set({ save: 'saving' });
    try {
      const meta = await this.store.saveDiagram(projectId, { id: diagramId, text, ifUpdatedAt: this.baseUpdatedAt });
      // Si el diagrama abierto cambió mientras se guardaba, este resultado ya no le corresponde.
      if (this.state.diagramId !== diagramId) return;
      this.baseUpdatedAt = meta.updatedAt;
      if (this.pendingText === text) this.pendingText = undefined;
      this.set({ save: this.pendingText === undefined ? 'saved' : 'pending', savedAt: Date.now(), ...NO_SAVE_ERROR });
      this.announce();
      await this.refresh({ background: this.remote });
    } catch (error) {
      if (this.state.diagramId === diagramId && sync && (await this.parkAfter(error, text))) return;
      const code = codeOf(error);
      this.set({ save: code === 'conflict' ? 'conflict' : 'error', saveError: (error as Error).message, saveErrorCode: code });
    }
  }

  /**
   * Guarda `text` en la cola de este navegador como el último estado del diagrama abierto. `false` si no se pudo (tope superado, sin
   * almacenamiento, sin marca del servidor sobre la que reenviar): quien llama sigue con el comportamiento de siempre (el texto queda en memoria).
   */
  private async park(text: string, status: PendingStatus | 'keep', error?: ProjectError): Promise<boolean> {
    const sync = this.sync;
    const { projectId, diagramId } = this.state;
    if (!sync || !projectId || !diagramId || !this.baseUpdatedAt) return false;
    const meta = this.diagram;
    const problem = status === 'conflict' ? ('changed' as const) : undefined;
    const result = await sync.park({ projectId, diagramId, name: meta?.name ?? diagramId, module: meta?.module, text, baseUpdatedAt: this.baseUpdatedAt }, status, { problem, reason: error?.message });
    if (!result.ok) return false;
    if (this.state.diagramId !== diagramId) return true;
    if (this.pendingText === text) this.pendingText = undefined;
    const entry = sync.find(projectId, diagramId);
    if (entry) this.set(this.stateOf(entry));
    return true;
  }

  /** Un guardado falló: si es algo que la cola sabe esperar (la red, una credencial, un conflicto), el cambio se guarda en ella. `true` si quedó guardado. */
  private async parkAfter(error: unknown, text: string): Promise<boolean> {
    const sync = this.sync;
    if (!sync) return false;
    if (isTransient(error)) {
      if (!(await this.park(text, 'retry', error))) return false;
      sync.noteFailure(error);
      return true;
    }
    if (error instanceof ProjectError && (error.code === 'unauthorized' || error.code === 'forbidden')) {
      if (!(await this.park(text, 'auth', error))) return false;
      sync.noteAuth(error);
      this.set({ save: 'error', saveError: error.message, saveErrorCode: error.code });
      return true;
    }
    if (error instanceof ProjectError && error.code === 'conflict') return this.park(text, 'conflict', error);
    return false;
  }

  /**
   * Un conflicto se da cuando otra pestaña, otra persona u otro equipo guardó el mismo diagrama. Tres salidas:
   * - `reload`: te quedas con lo del servidor y lo tuyo se descarta (devuelve el diagrama como quedó, para que el anfitrión lo cargue).
   * - `overwrite`: te quedas con lo tuyo, que se envía sobre lo que hay ahora en el servidor.
   * - `copy`: lo tuyo se guarda como un diagrama nuevo (`name`, o «Nombre (mi versión)») y el original conserva lo del servidor.
   * Con un servidor, lo tuyo se conserva en este navegador mientras decides y se puede resolver el conflicto de cualquier diagrama con `key`.
   */
  async resolveConflict(choice: ConflictChoice, options: { key?: string; name?: string } = {}): Promise<Diagram | undefined> {
    const entry = this.sync ? (options.key ? this.sync.queue.get(options.key) : this.openEntry()) : undefined;
    if (this.sync && entry) return this.resolveQueued(entry, choice, options.name);
    const { projectId, diagramId } = this.state;
    if (!projectId || !diagramId) return undefined;
    const current = await this.store.getDiagram(projectId, diagramId);
    if (!current) {
      this.detach();
      return undefined;
    }
    if (choice === 'copy') {
      const text = this.pendingText;
      if (text === undefined) return undefined;
      await this.saveAsNew({ projectId, module: current.module, name: options.name ?? current.name, text });
      return undefined;
    }
    this.baseUpdatedAt = current.updatedAt;
    this.set({ save: 'idle', ...NO_SAVE_ERROR });
    if (choice === 'reload') {
      this.discardPending();
      return current;
    }
    if (this.pendingText !== undefined) await this.run();
    return undefined;
  }

  /** Un nombre libre en el proyecto a partir de `wanted` («Ventas (mi versión)», «Ventas (mi versión 2)»…). */
  private freeName(projectId: string, wanted: string): string {
    const taken = new Set((this.state.projects.find((p) => p.id === projectId)?.diagrams ?? []).map((d) => d.name.trim().toLowerCase()));
    if (!taken.has(wanted.trim().toLowerCase())) return wanted;
    const base = wanted.replace(/\s*\(mi versión(?: \d+)?\)$/, '');
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? `${base} (mi versión)` : `${base} (mi versión ${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** Guarda un texto como diagrama nuevo del proyecto y, si es el abierto, deja la sesión guardando en él. */
  private async saveAsNew(input: { projectId: string; module: string; name: string; text: string }, wasOpen = true): Promise<DiagramMeta> {
    let meta: DiagramMeta | undefined;
    for (let attempt = 0; !meta; attempt += 1) {
      try {
        meta = await this.store.saveDiagram(input.projectId, { module: input.module, name: this.freeName(input.projectId, attempt === 0 ? input.name : `${input.name} (${attempt + 1})`), text: input.text });
      } catch (error) {
        if (!(error instanceof ProjectError && error.code === 'exists') || attempt >= 5) throw error;
        await this.refresh({ background: true }); // alguien creó ese nombre en medio: se relee la lista para elegir otro
      }
    }
    await this.refresh({ background: this.remote });
    if (wasOpen) {
      this.discardPending();
      this.baseUpdatedAt = meta.updatedAt;
      this.set({ diagramId: meta.id, save: 'saved', savedAt: Date.now(), ...NO_SAVE_ERROR });
      this.remember();
    }
    this.announce();
    return meta;
  }

  /** `resolveConflict` de un cambio guardado en este navegador. */
  private async resolveQueued(entry: PendingChange, choice: ConflictChoice, name?: string): Promise<Diagram | undefined> {
    const sync = this.sync!;
    const open = this.isOpen(entry);
    if (choice === 'reload') {
      // Primero se lee lo del servidor: sin red falla aquí y no se pierde nada de lo tuyo.
      const current = entry.problem === 'gone' ? undefined : await this.store.getDiagram(entry.projectId, entry.diagramId);
      await sync.dropKey(entry.key);
      if (open) {
        this.discardPending();
        if (current) {
          this.baseUpdatedAt = current.updatedAt;
          this.set({ save: 'idle', ...NO_SAVE_ERROR });
        } else this.detach();
      }
      await this.refresh({ background: this.remote });
      return open ? current : undefined;
    }
    const fresh = choice === 'overwrite' && entry.problem !== 'gone' ? await this.store.getDiagram(entry.projectId, entry.diagramId) : undefined;
    if (choice === 'overwrite' && fresh) {
      // Lo tuyo se envía sobre lo que hay ahora en el servidor (la marca nueva): si cambia otra vez mientras tanto, vuelve a ser conflicto.
      await sync.patch(entry.key, { status: 'retry', problem: undefined, reason: undefined, baseUpdatedAt: fresh.updatedAt });
      if (open) {
        this.baseUpdatedAt = fresh.updatedAt;
        this.set({ save: 'saving', ...NO_SAVE_ERROR });
      }
      await sync.kick('manual');
      return undefined;
    }
    // Copia (o «la mía» de un diagrama que ya no existe): un diagrama nuevo con otro nombre; el original no se toca.
    const module = entry.module ?? this.state.projects.find((p) => p.id === entry.projectId)?.diagrams.find((d) => d.id === entry.diagramId)?.module;
    if (!module) throw new ProjectError('invalid', 'No se sabe de qué módulo es el diagrama: no se puede guardar la copia.');
    await this.saveAsNew({ projectId: entry.projectId, module, name: name?.trim() || `${entry.name} (mi versión)`, text: entry.text }, open);
    await sync.dropKey(entry.key);
    return undefined;
  }

  /** Reintenta un guardado que falló (o, si está en la cola de este navegador, lo envía ya). */
  async retry(): Promise<void> {
    if (this.openEntry()?.status === 'retry') {
      await this.sync!.kick('manual');
      return;
    }
    if (this.pendingText !== undefined) {
      this.set({ save: 'pending' });
      await this.run();
    }
  }

  dispose(): void {
    this.stopWatching?.();
    this.stopNetwork?.();
    this.sync?.dispose();
    this.discardPending();
    this.listeners.clear();
    this.channel?.close();
  }
}
