import { ProjectError } from '@iark/kernel';

export function prepareCreateProject(input: { name: string; description?: string }): { name: string; description?: string } {
  if (!input.name.trim()) throw new ProjectError('invalid', 'Falta el nombre del proyecto.');
  return input;
}

export function prepareRenameProject(name: string): string {
  if (!name.trim()) throw new ProjectError('invalid', 'Falta el nombre del proyecto.');
  return name;
}
