export type ChangeType = 'project.created' | 'project.changed' | 'project.deleted' | 'diagram.created' | 'diagram.saved' | 'diagram.renamed' | 'diagram.deleted' | 'diagram.restored';

/** Lo que cuenta un aviso: identificadores y marcas, nunca contenido. */
export interface ChangeEvent {
  type: ChangeType;
  project: string;
  diagram?: string;
  updatedAt?: string;
  /** Quién lo hizo: el nombre del token o `@usuario` de la sesión. */
  by?: string;
}

export interface PublishOptions {
  /** Cuentas que deben recibir el aviso aunque ya no pertenezcan al proyecto. */
  alsoUsers?: Iterable<string>;
}

/** Lo que `diagrams-app` necesita para avisar de un cambio. */
export interface EventPublisher {
  publish(event: ChangeEvent, options?: PublishOptions): Promise<void>;
}
