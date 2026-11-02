import type { ModuleRegistry, ProjectStore } from '@iark/kernel';

/** Puerto hexagonal: proveedor de modelos (spec 008). */
export interface ModelProvider {
  /** Genera o revisa un documento vía el proveedor externo. */
  generate(input: unknown): Promise<unknown>;
}

/** Puerto hexagonal: lectura acotada de un repositorio (--from-repo). */
export interface RepositoryReader {
  readTree(options: Record<string, unknown>): Promise<{ text: string; warnings?: string[] }>;
}

/** Carpeta de proyectos del CLI (no el Postgres del servicio). */
export type CliProjectStore = ProjectStore;

/** Registro de módulos de la suite (incorporados y plugins). */
export type ModulesPort = ModuleRegistry;
