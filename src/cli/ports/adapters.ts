import type { ModuleRegistry } from '@iark/kernel';
import { generateDocument } from '@core/ai/generate';

type GenerateDocumentInput = Parameters<typeof generateDocument>[0];
import { formatSummary } from '../repo/format';
import { scanRepo } from '../repo/scan';
import type { CliProjectStore, ModelProvider, ModulesPort, RepositoryReader } from './index';
import { FolderProjectStore } from '../../diagrams-app/modules/projects/infrastructure/workspace';

/** Adaptador Infrastructure → puerto `Modules` (registro existente). */
export function asModulesPort(registry: ModuleRegistry): ModulesPort {
  return registry;
}

/** Adaptador Infrastructure → puerto `ProjectStore` del CLI (carpeta). */
export function createCliProjectStore(root: string): CliProjectStore {
  return new FolderProjectStore(root);
}

/** Adaptador Infrastructure → puerto `ModelProvider` (`generateDocument` del núcleo). */
export function createModelProvider(defaults: Partial<GenerateDocumentInput> = {}): ModelProvider {
  return {
    async generate(input) {
      return generateDocument({ ...defaults, ...(input as GenerateDocumentInput) });
    },
  };
}

/** Adaptador Infrastructure → puerto `RepositoryReader` (`scanRepo` del CLI). */
export function createRepositoryReader(): RepositoryReader {
  return {
    async readTree(options) {
      const path = String(options.path ?? '');
      const budgetBytes = typeof options.budgetBytes === 'number' ? options.budgetBytes : undefined;
      const include = Array.isArray(options.include) ? (options.include as string[]) : undefined;
      const exclude = Array.isArray(options.exclude) ? (options.exclude as string[]) : undefined;
      const digest = scanRepo(path, { budgetBytes, include, exclude });
      const warnings = digest.redactions > 0 ? [`Se redactaron ${digest.redactions} valor(es) con aspecto de secreto.`] : undefined;
      return { text: formatSummary(digest), warnings };
    },
  };
}
