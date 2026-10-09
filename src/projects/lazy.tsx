import { lazy, Suspense, type ComponentProps } from 'react';
import type { HistoryDialog as HistoryDialogComponent } from './HistoryDialog';
import type { ProjectsDialog as ProjectsDialogComponent } from './ProjectsDialog';

/**
 * Los diálogos grandes del gestor de proyectos (el gestor con «Dónde se guardan», compartir y administración, y el historial de
 * versiones) solo se abren con un clic y suman unos 100 kB a la carga inicial de las páginas que los usan. Se cargan bajo demanda
 * (`import()`); mientras llega el trozo no se pinta nada, que son milisegundos tras un clic. Los topes de tamaño están en
 * `scripts/perf/limites.ts`.
 */
const ProjectsDialogChunk = lazy(() => import('./ProjectsDialog').then((m) => ({ default: m.ProjectsDialog })));
const HistoryDialogChunk = lazy(() => import('./HistoryDialog').then((m) => ({ default: m.HistoryDialog })));

export function ProjectsDialog(props: ComponentProps<typeof ProjectsDialogComponent>) {
  return (
    <Suspense fallback={null}>
      <ProjectsDialogChunk {...props} />
    </Suspense>
  );
}

export function HistoryDialog(props: ComponentProps<typeof HistoryDialogComponent>) {
  return (
    <Suspense fallback={null}>
      <HistoryDialogChunk {...props} />
    </Suspense>
  );
}
