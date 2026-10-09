export type ProjectErrorCode =
  /** El proyecto o el diagrama no existe. */
  | 'not-found'
  /** Ya hay uno con ese nombre. */
  | 'exists'
  /** Nombre, módulo o contenido que no se pueden aceptar. */
  | 'invalid'
  /** Alguien cambió el diagrama desde que se leyó (ver `SaveDiagramInput.ifUpdatedAt`). */
  | 'conflict'
  /** El almacenamiento no está disponible (ventana privada, permisos, disco, o un servidor al que no se llega). */
  | 'unavailable'
  /** Un servidor remoto pide un token, o el que se usa no existe o ya no vale. */
  | 'unauthorized'
  /** Un servidor remoto reconoce el token, pero su rol (o el origen de la petición) no permite esa operación. */
  | 'forbidden'
  /** El almacén (o el servidor) no ofrece esa operación: por ejemplo, el historial de versiones en uno que no lo guarda. */
  | 'unsupported';

/**
 * El motivo estable de un error, para que la interfaz lo cuente en el idioma de la persona sin depender del texto en español del `message`
 * (que sigue ahí para el CLI, los registros y quien no traduce). Lo ponen el cliente HTTP, los almacenes y la sesión de proyectos; cada
 * motivo tiene su texto en el catálogo de la interfaz (`errores.ts` de `src/i18n/es` y `src/i18n/en`), con los `params` que lo acompañan.
 */
export type ProjectErrorReason =
  // nombres y entradas
  | 'name-not-text'
  | 'name-empty'
  | 'name-too-long'
  | 'module-invalid'
  | 'document-not-text'
  // el proyecto, el diagrama y las versiones
  | 'project-missing'
  | 'diagram-missing'
  | 'diagram-missing-in'
  | 'project-exists'
  | 'diagram-exists'
  | 'diagram-module-fixed'
  | 'diagram-changed'
  | 'version-missing'
  // el archivo de un proyecto
  | 'bundle-not-json'
  | 'bundle-not-project'
  | 'bundle-invalid'
  | 'bundle-newer'
  | 'bundle-duplicate-id'
  | 'bundle-no-content'
  // el historial de versiones
  | 'policy-range'
  | 'version-id-invalid'
  | 'version-limit'
  | 'version-unnamed'
  | 'versions-unsupported'
  // el cliente HTTP: la dirección, la conexión y lo que contesta el servidor
  | 'address-invalid'
  | 'address-scheme'
  | 'address-credentials'
  | 'login-missing'
  | 'server-no-session'
  | 'server-no-member'
  | 'server-no-account'
  | 'server-no-restore'
  | 'server-no-version'
  | 'server-not-json'
  | 'server-timeout'
  | 'server-unreachable'
  | 'server-versions-unsupported'
  | 'last-admin'
  | 'account-locked'
  | 'limit'
  | 'limit-projects'
  | 'limit-diagrams'
  | 'limit-bytes'
  | 'invalid-grant'
  | 'token-required'
  | 'token-forbidden'
  | 'rate-limited'
  | 'rate-limited-wait'
  | 'too-large'
  | 'bad-request'
  | 'no-projects-api'
  | 'http-error'
  | 'server-status'
  | 'server-status-detail'
  // la sesión de proyectos y los almacenes del navegador
  | 'newer-unsaved'
  | 'logout-unsupported'
  | 'share-unsupported'
  | 'admin-unsupported'
  | 'not-member-anymore'
  | 'diagram-gone'
  | 'save-needs-project'
  | 'history-unsupported'
  | 'restore-conflict'
  | 'restore-unsaved'
  | 'module-unknown'
  | 'storage-full'
  | 'storage-unavailable'
  | 'storage-no-idb'
  | 'storage-blocked'
  | 'login-no-crypto'
  | 'login-no-storage'
  | 'offline-browser'
  | 'offline-check-failed'
  | 'offline-send-failed';

/** Detalle opcional de un error que vino de un servidor remoto (el cliente HTTP lo rellena; los almacenes locales no). */
export interface ProjectErrorInfo {
  /** Código de estado HTTP de la respuesta. */
  status?: number;
  /** `true` si ni siquiera hubo respuesta (red caída, tiempo agotado, o el navegador bloqueó la petición por CORS o por contenido mixto). */
  network?: boolean;
  /**
   * El `code` que mandó el servidor cuando no tiene un `ProjectErrorCode` propio y se tradujo a uno cercano (`limit`, `last-admin`,
   * `invalid-grant`…): deja que una pantalla distinga, por ejemplo, un tope de proyectos de un contenido inválido.
   */
  serverCode?: string;
  /** Con un 429 («demasiados intentos fallidos»), los segundos que pidió esperar el servidor (`Retry-After`), si los dio. Quien reintenta debe respetarlos. */
  retryAfterSec?: number;
  /** Por qué falló, de forma estable (ver `ProjectErrorReason`): la interfaz traduce por este código y no por el texto. */
  reason?: ProjectErrorReason;
  /** Los datos que completan el texto del motivo (nombres, cifras…), ya como texto o número. */
  params?: Record<string, string | number>;
  /** Con un error que llegó del servidor, el texto que mandó él (en el idioma del servidor): en español se muestra tal cual; en otros idiomas se prefiere la traducción del motivo. */
  serverMessage?: string;
}

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly info: ProjectErrorInfo = {},
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}
