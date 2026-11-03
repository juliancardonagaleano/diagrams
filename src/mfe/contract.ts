/** Contrato navegacional shell ↔ remoto (spec 007). */

export interface ProjectSlotContext {
  moduleId: string;
  projectId?: string;
  diagramId?: string;
  documentText?: string;
}

export interface ModuleSlotHost {
  getContext(): ProjectSlotContext;
  getActiveViewId?(): string | undefined;
  onDocumentChange?(text: string): void;
  onActiveViewChange?(viewId: string | undefined): void;
}

export interface ModuleSlotMount {
  unmount(): void;
}

export interface ModuleRemoteRoutes {
  remoteId: string;
  moduleId: string;
  shellMountPath: string;
}

export interface TraceRemoteRoutes {
  remoteId: 'mfe-trace';
  shellMountPath: '/trace';
}

export interface ModuleRemoteMountOptions {
  host: ModuleSlotHost;
  searchParams: URLSearchParams;
}

export interface ModuleRemoteModule {
  routes: ModuleRemoteRoutes;
  mount(options: ModuleRemoteMountOptions): Promise<ModuleSlotMount>;
}

export interface TraceRemoteMountOptions {
  searchParams: URLSearchParams;
}

export interface TraceRemoteModule {
  routes: TraceRemoteRoutes;
  mount(options: TraceRemoteMountOptions): Promise<ModuleSlotMount>;
}
