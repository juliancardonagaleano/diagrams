/**
 * Proyectos: un conjunto de diagramas (de cualquier módulo de la suite) que se guardan, se abren y se mueven juntos.
 * Aquí solo está el contrato; cada superficie aporta su almacén (IndexedDB en el navegador, una carpeta en el CLI y en
 * `iark serve`, memoria en las pruebas). El documento de un diagrama es siempre el JSON de su módulo, tal cual.
 */

/** Un diagrama dentro de un proyecto, sin su documento (lo que se necesita para listarlo). */
export interface DiagramMeta {
  /** Estable mientras el diagrama exista en ese almacén (en una carpeta es el nombre del archivo, sin extensión). */
  id: string;
  /** Id del módulo de la suite que lo entiende (`c4`, `integration`, `data`…). */
  module: string;
  /** Nombre con el que aparece en la lista; no tiene por qué coincidir con el nombre que lleva el documento por dentro. */
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Un diagrama con su documento: el texto JSON del módulo (puede ser un borrador que aún no sea válido). */
export interface Diagram extends DiagramMeta {
  text: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** Rol de una persona en un proyecto de un servidor con cuentas: los mismos tres de los tokens (`viewer` lee, `editor` escribe, `admin` además borra y comparte). */
export type ProjectRole = 'viewer' | 'editor' | 'admin';

/** Un proyecto con la lista de sus diagramas (sin documentos), ordenados por nombre. */
export interface ProjectSummary extends ProjectMeta {
  diagrams: DiagramMeta[];
  /**
   * Solo con un servidor con cuentas (`iark serve --accounts`) y una persona con sesión: el rol de quien pregunta en este proyecto.
   * Con un token de `iark auth` o en un almacén local no viene (el rol del token vale para todo el espacio de trabajo).
   */
  role?: ProjectRole;
}

/** Un proyecto completo: todos sus diagramas con su documento. Es lo que se exporta a un solo archivo. */
export interface ProjectSnapshot extends ProjectMeta {
  diagrams: Diagram[];
}

export interface SaveDiagramInput {
  /** Con `id` se actualiza ese diagrama; sin él se crea uno nuevo. */
  id?: string;
  /** Obligatorio al crear. Al actualizar se conserva el del diagrama (un diagrama no cambia de módulo). */
  module?: string;
  /** Nombre al crear (por defecto, «Sin título»). Al actualizar no cambia: para eso está `renameDiagram`. */
  name?: string;
  text: string;
  /**
   * Control de concurrencia: si se indica, solo se guarda cuando el diagrama sigue teniendo esta marca `updatedAt`; si otra
   * pestaña o proceso lo cambió en medio, falla con `ProjectError('conflict')` en lugar de pisar su trabajo.
   */
  ifUpdatedAt?: string;
}

/**
 * Almacén de proyectos. Todos los nombres se comparan sin distinguir mayúsculas: no puede haber dos proyectos con el mismo
 * nombre en un almacén ni dos diagramas con el mismo nombre en un proyecto (así se puede nombrar cualquiera desde la línea de
 * comandos). Los errores esperables son `ProjectError`.
 */
export interface ProjectStore {
  /** `memory`, `indexeddb`, `folder`… para los mensajes y para saber qué ofrecer. */
  readonly kind: string;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectSummary | undefined>;
  createProject(input: { name: string; description?: string }): Promise<ProjectSummary>;
  renameProject(id: string, name: string): Promise<ProjectSummary>;
  deleteProject(id: string): Promise<void>;
  getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined>;
  saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta>;
  renameDiagram(projectId: string, diagramId: string, name: string): Promise<DiagramMeta>;
  deleteDiagram(projectId: string, diagramId: string): Promise<void>;
}
