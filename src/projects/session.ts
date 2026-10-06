import {
  bundleFileName,
  bundleToText,
  createBundle,
  duplicateDiagram,
  importBundle,
  parseBundle,
  ProjectError,
  snapshotProject,
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

/**
 * Sesión de proyectos de una pantalla (banco de trabajo o editor C4): qué proyecto y qué diagrama están abiertos, la lista
 * de proyectos, y el guardado automático del diagrama abierto con control de concurrencia. Sin React: la interfaz se
 * suscribe y el anfitrión (el controlador del banco o el editor C4) le pasa el texto cuando cambia.
 */

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

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
}

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
    this.set({ ready: true });
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
    await this.refresh({ background: true });
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
    const diagram = await this.store.getDiagram(projectId, diagramId);
    if (!diagram) throw new ProjectError('not-found', 'El diagrama ya no existe en el proyecto.');
    this.baseUpdatedAt = diagram.updatedAt;
    this.pendingText = undefined;
    this.set({ projectId, diagramId, save: 'idle', ...NO_SAVE_ERROR });
    this.remember();
    return diagram;
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
    if (this.state.save !== 'conflict') this.set({ save: 'pending', ...NO_SAVE_ERROR });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  private discardPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingText = undefined;
  }

  /** Guarda ya lo pendiente y espera a que termine (antes de cambiar de diagrama, exportar o salir). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.run();
    } else if (this.pendingText !== undefined && this.state.save === 'error') {
      await this.run();
    }
    await this.inFlight;
  }

  /** Hay cambios que aún no están guardados (para avisar al cerrar la pestaña). */
  get dirty(): boolean {
    return this.pendingText !== undefined || this.state.save === 'saving' || this.state.save === 'error' || this.state.save === 'conflict';
  }

  private run(): Promise<void> {
    this.timer = undefined;
    this.inFlight = (this.inFlight ?? Promise.resolve()).then(() => this.write());
    return this.inFlight;
  }

  private async write(): Promise<void> {
    const { projectId, diagramId } = this.state;
    const text = this.pendingText;
    if (text === undefined || !projectId || !diagramId || this.state.save === 'conflict') return;
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
      const code = codeOf(error);
      this.set({ save: code === 'conflict' ? 'conflict' : 'error', saveError: (error as Error).message, saveErrorCode: code });
    }
  }

  /**
   * Un conflicto se da cuando otra pestaña guardó el mismo diagrama. `overwrite` conserva lo de esta pestaña;
   * `reload` descarta lo de esta y devuelve el diagrama como quedó, para que el anfitrión lo cargue.
   */
  async resolveConflict(choice: 'overwrite' | 'reload'): Promise<Diagram | undefined> {
    const { projectId, diagramId } = this.state;
    if (!projectId || !diagramId) return undefined;
    const current = await this.store.getDiagram(projectId, diagramId);
    if (!current) {
      this.detach();
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

  /** Reintenta un guardado que falló. */
  async retry(): Promise<void> {
    if (this.pendingText !== undefined) {
      this.set({ save: 'pending' });
      await this.run();
    }
  }

  dispose(): void {
    this.stopWatching?.();
    this.discardPending();
    this.listeners.clear();
    this.channel?.close();
  }
}
