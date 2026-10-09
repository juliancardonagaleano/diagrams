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
  | 'forbidden';

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
