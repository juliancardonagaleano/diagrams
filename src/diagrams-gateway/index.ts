/** Proceso lógico `diagrams-gateway`: API de módulos y piscina de cálculo. */
export { createModuleApi, type ModuleApiOptions } from './moduleApi';
export { ComputePool, type ComputePoolOptions } from '../cli/computePool';
export { inlineExecutor, COMPUTE_ACTIONS, executeJob, type ComputeExecutor, type ComputeJob } from '../cli/compute';
