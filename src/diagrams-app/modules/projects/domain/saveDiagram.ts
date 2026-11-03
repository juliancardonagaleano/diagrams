import { ProjectError } from '@iark/kernel';

export interface SaveDiagramCommand {
  id: string;
  text: string;
  ifUpdatedAt?: string;
  by?: string;
}

/** Escritura: reglas de negocio del guardado (la comparación atómica de `ifUpdatedAt` sigue en infraestructura). */
export function prepareSaveDiagram(input: SaveDiagramCommand): SaveDiagramCommand {
  if (!input.text.trim()) throw new ProjectError('invalid', 'El diagrama no puede estar vacío.');
  return input;
}
