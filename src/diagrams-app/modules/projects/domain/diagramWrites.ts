import { ProjectError } from '@iark/kernel';

export interface CreateDiagramCommand {
  module: string;
  name?: string;
  text: string;
  by?: string;
}

export function prepareCreateDiagram(input: CreateDiagramCommand): CreateDiagramCommand {
  if (!input.module.trim()) throw new ProjectError('invalid', 'Falta el módulo del diagrama.');
  if (!input.text.trim()) throw new ProjectError('invalid', 'El diagrama no puede estar vacío.');
  return input;
}

export function prepareRenameDiagram(name: string): string {
  if (!name.trim()) throw new ProjectError('invalid', 'Falta el nombre del diagrama.');
  return name;
}
