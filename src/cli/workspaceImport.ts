import { existsSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { ProjectError, type DiagramVersion } from '@iark/kernel';
import { CliError, info } from './io';
import { releaseDatabase } from './postgres/shared';
import type { ImportableProject, PostgresProjectStore } from './postgresProjects';
import { asCliError, openPostgresProjects } from './workspaceStore';
import { FolderProjectStore } from './workspace';

/**
 * `iark workspace import --from <carpeta>`: pasa los proyectos de una carpeta de trabajo (la de `iark serve --workspace` y `iark project`) a
 * Postgres (la base que describe el entorno, `IARK_DATABASE_URL`…). Conserva los ids de proyectos y diagramas, las fechas y el historial de
 * versiones; es idempotente (un proyecto que ya está en la base se omite, así que se puede repetir sin miedo) y solo lee la carpeta.
 */

export type ImportStatus = 'imported' | 'exists' | 'name-taken' | 'error' | 'dry-run';

export interface ProjectImportReport {
  id: string;
  name: string;
  status: ImportStatus;
  diagrams: number;
  versions: number;
  /** Para `name-taken`, el proyecto de la base que ya se llama así; para `error`, el motivo. */
  detail?: string;
  /** Diagramas cuyo nombre estaba repetido en la carpeta y se numeraron. */
  renamed: string[];
}

/** Lee un proyecto de la carpeta con todo lo que se importa. `versions: false` no lee el historial. */
export async function readFolderProject(source: FolderProjectStore, id: string, options: { versions: boolean }): Promise<ImportableProject> {
  const summary = await source.getProject(id);
  if (!summary) throw new ProjectError('not-found', `No existe el proyecto «${id}».`);
  const diagrams: ImportableProject['diagrams'] = [];
  for (const meta of summary.diagrams) {
    const diagram = await source.getDiagram(id, meta.id);
    if (!diagram) continue; // lo borraron en este instante
    const versions: DiagramVersion[] = [];
    if (options.versions) {
      for (const v of await source.listVersions(id, meta.id)) {
        const full = await source.getVersion(id, meta.id, v.id);
        if (full) versions.push(full);
      }
    }
    diagrams.push({ id: diagram.id, module: diagram.module, name: diagram.name, text: diagram.text, createdAt: diagram.createdAt, updatedAt: diagram.updatedAt, versions });
  }
  return { id: summary.id, name: summary.name, description: summary.description, createdAt: summary.createdAt, updatedAt: summary.updatedAt, diagrams };
}

/** Pasa los proyectos de `source` a `target` (o, sin `target`, solo cuenta lo que pasaría). Un proyecto que falla no impide los demás. */
export async function importWorkspace(source: FolderProjectStore, target: PostgresProjectStore | undefined, options: { replace?: boolean; onProject?: (report: ProjectImportReport) => void } = {}): Promise<ProjectImportReport[]> {
  const reports: ProjectImportReport[] = [];
  for (const listed of await source.listProjects()) {
    const report: ProjectImportReport = { id: listed.id, name: listed.name, status: 'dry-run', diagrams: listed.diagrams.length, versions: 0, renamed: [] };
    try {
      const project = await readFolderProject(source, listed.id, { versions: target ? target.keepsVersions : true });
      report.diagrams = project.diagrams.length;
      report.versions = project.diagrams.reduce((n, d) => n + (d.versions?.length ?? 0), 0);
      if (target) {
        const outcome = await target.importProject(project, { replace: options.replace });
        report.status = outcome.status === 'imported' ? 'imported' : outcome.status;
        if (outcome.status === 'imported') {
          report.versions = outcome.versions;
          report.renamed = outcome.renamed;
        } else if (outcome.status === 'name-taken') report.detail = outcome.id;
        else report.versions = 0;
      }
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      report.status = 'error';
      report.detail = error.message;
    }
    reports.push(report);
    options.onProject?.(report);
  }
  return reports;
}

const describeReport = (r: ProjectImportReport): string => {
  const what = `«${r.name}» (${r.id}): ${r.diagrams} diagrama(s), ${r.versions} versión(es)`;
  switch (r.status) {
    case 'imported':
      return `  importado ${what}${r.renamed.length ? ` · nombres repetidos numerados: ${r.renamed.join('; ')}` : ''}`;
    case 'exists':
      return `  omitido  «${r.name}» (${r.id}): ya está en la base (use --replace para reemplazarlo)`;
    case 'name-taken':
      return `  omitido  «${r.name}» (${r.id}): otro proyecto de la base (${r.detail}) ya se llama así`;
    case 'error':
      return `  ERROR    «${r.name}» (${r.id}): ${r.detail}`;
    default:
      return `  se importaría ${what}`;
  }
};

export function registerWorkspace(program: Command): void {
  const workspace = program.command('workspace').description('Espacio de trabajo de proyectos de `iark serve`: pasar una carpeta de proyectos a Postgres');
  workspace
    .command('import')
    .description(
      'Importa a Postgres los proyectos de una carpeta de trabajo (con sus ids, fechas y versiones). La base sale del entorno (IARK_DATABASE_URL…), nunca de la línea de comandos. ' +
        'Es idempotente: un proyecto que ya está en la base se omite, salvo con --replace. Solo lee la carpeta',
    )
    .requiredOption('--from <carpeta>', 'la carpeta de trabajo con los proyectos (la de `iark serve --workspace` o `iark project`)')
    .option('--replace', 'reemplaza (borra y vuelve a crear) los proyectos que ya existen en la base con el mismo id', false)
    .option('--dry-run', 'solo cuenta lo que se importaría, sin tocar la base (no hace falta IARK_DATABASE_URL)', false)
    .action(async (opts: { from: string; replace: boolean; dryRun: boolean }) => {
      if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) throw new CliError(`La carpeta de trabajo «${opts.from}» no existe o no es una carpeta.`, 2);
      // El historial se lee aunque IARK_VERSIONS=off en el entorno: lo que no guarde el destino se descarta allí.
      const source = new FolderProjectStore(opts.from, { versions: {} });
      const target = opts.dryRun ? undefined : await openPostgresProjects();
      try {
        const reports = await importWorkspace(source, target, { replace: opts.replace, onProject: (r) => info(describeReport(r)) });
        const count = (status: ImportStatus): number => reports.filter((r) => r.status === status).length;
        info(
          opts.dryRun
            ? `${reports.length} proyecto(s) en «${opts.from}»; no se tocó la base (--dry-run).`
            : `${count('imported')} importado(s), ${count('exists')} ya estaban, ${count('name-taken')} con el nombre ocupado, ${count('error')} con error, de ${reports.length} proyecto(s).`,
        );
        if (count('error') > 0) throw new CliError('Algunos proyectos no se importaron (ver arriba); el resto sí.', 1);
      } catch (error) {
        throw asCliError(error);
      } finally {
        if (target) await releaseDatabase();
      }
    });
}
