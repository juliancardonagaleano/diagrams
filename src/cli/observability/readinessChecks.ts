import { dirname } from 'node:path';
import type { ModuleRegistry, ProjectStore } from '@iark/kernel';
import type { Accounts } from '../../diagrams-identity/core/accounts/service';
import type { TokenStore } from '../../diagrams-identity/core/tokens';
import type { ComputeExecutor } from '../compute';
import { directoryWritable, fileReadable, type Check } from './health';

export type ReadinessProcess = 'suite' | 'gateway' | 'app' | 'identity' | 'sse';

export interface ReadinessCheckInput {
  process?: ReadinessProcess;
  registry?: ModuleRegistry;
  projects?: ProjectStore;
  tokens?: TokenStore;
  accounts?: Accounts;
  compute?: ComputeExecutor;
  events?: boolean;
}

function workspaceCheck(projects: ProjectStore | undefined): Check | undefined {
  const workspaceRoot = (projects as { root?: unknown } | undefined)?.root;
  const workspacePing = (projects as { ping?: unknown } | undefined)?.ping;
  if (typeof workspaceRoot === 'string') return () => directoryWritable(workspaceRoot);
  if (typeof workspacePing === 'function') return () => (workspacePing as () => Promise<boolean>).call(projects);
  return undefined;
}

function tokensCheck(tokens: TokenStore | undefined): Check | undefined {
  if (!tokens) return undefined;
  return () => tokens.lookup(undefined).status !== 'unavailable';
}

function accountsCheck(accounts: Accounts | undefined): Check | undefined {
  if (!accounts) return undefined;
  const store = accounts.store;
  return async () =>
    store.kind === 'postgres' ? store.readable() : (await fileReadable(store.path)) && (await store.readable()) && (await directoryWritable(dirname(store.path)));
}

function computeCheck(compute: ComputeExecutor | undefined): Check | undefined {
  if (!compute?.healthy) return undefined;
  return () => compute.healthy!();
}

function registryCheck(registry: ModuleRegistry | undefined): Check | undefined {
  if (!registry) return undefined;
  return () => registry.ids().length > 0;
}

function sseCheck(events: boolean | undefined): Check | undefined {
  if (!events) return undefined;
  return () => true;
}

export function buildReadinessChecks(input: ReadinessCheckInput): Record<string, Check> {
  const process = input.process ?? 'suite';
  const checks: Record<string, Check> = {};

  if (process === 'gateway') {
    const registry = registryCheck(input.registry);
    if (registry) checks.registry = registry;
    const compute = computeCheck(input.compute);
    if (compute) checks.compute = compute;
  }
  if (process === 'suite') {
    const compute = computeCheck(input.compute);
    if (compute) checks.compute = compute;
  }

  if (process === 'app' || process === 'suite') {
    const workspace = workspaceCheck(input.projects);
    if (workspace) checks.workspace = workspace;
  }

  if (process === 'identity' || process === 'suite') {
    const tokens = tokensCheck(input.tokens);
    if (tokens) checks.tokens = tokens;
    const accounts = accountsCheck(input.accounts);
    if (accounts) checks.accounts = accounts;
  }

  if (process === 'sse') {
    const sse = sseCheck(input.events);
    if (sse) checks.events = sse;
  }

  return checks;
}
