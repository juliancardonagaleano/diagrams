import type { ModuleRegistry } from '@iark/kernel';
import type { CliProjectStore, ModulesPort } from './index';
import { FolderProjectStore } from '../workspace';

/** Adaptador Infrastructure → puerto `Modules` (registro existente). */
export function asModulesPort(registry: ModuleRegistry): ModulesPort {
  return registry;
}

/** Adaptador Infrastructure → puerto `ProjectStore` del CLI (carpeta). */
export function createCliProjectStore(root: string): CliProjectStore {
  return new FolderProjectStore(root);
}
