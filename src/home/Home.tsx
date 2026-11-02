import { useEffect, useSyncExternalStore } from 'react';
import { LanguageSelect, useT } from '../i18n/react';
import { localDrafts, MODULE_SOURCES } from '../modules-app/modules';
import { LAST_KEY } from '../projects/backend';
import { getProjectSession } from '../projects/factory';
import type { LastOpened, ProjectsState } from '../projects/session';
import type { ProjectSummary } from '@iark/kernel';

function readLast(): LastOpened | undefined {
  try {
    const raw = window.localStorage.getItem(LAST_KEY);
    const value = raw ? (JSON.parse(raw) as LastOpened) : undefined;
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function projectHref(project: ProjectSummary): string {
  const params = new URLSearchParams({ project: project.id });
  const first = project.diagrams[0];
  if (first) params.set('diagram', first.id);
  return `modulos.html?${params.toString()}`;
}

function continueHref(last: LastOpened | undefined, projects: ProjectSummary[]): string | undefined {
  if (!last?.projectId) return undefined;
  const project = projects.find((item) => item.id === last.projectId);
  if (!project) return undefined;
  const params = new URLSearchParams({ project: project.id });
  if (last.diagramId && project.diagrams.some((diagram) => diagram.id === last.diagramId)) params.set('diagram', last.diagramId);
  else if (project.diagrams[0]) params.set('diagram', project.diagrams[0].id);
  return `modulos.html?${params.toString()}`;
}

export function HomeScreen({ state, last }: { state: ProjectsState; last?: LastOpened }) {
  const { t } = useT();
  const continuing = continueHref(last, state.projects);
  const continueProject = continuing ? state.projects.find((project) => project.id === last?.projectId) : undefined;
  const drafts = MODULE_SOURCES.flatMap((source) => (localDrafts.read(source.id) ? [source] : []));
  return (
    <div className="home">
      <a className="wb-skip" href="#contenido">
        {t('wb.skip')}
      </a>
      <header className="home-header mesa-bar" aria-label={t('home.header')}>
        <h1 className="wb-title">
          DIAgrams <small>Suite</small>
        </h1>
        <a href="trazabilidad.html">{t('wb.traceLink')}</a>
        <a href="?editor=1">{t('home.editor')}</a>
        <LanguageSelect />
      </header>
      <main id="contenido" className="home-main">
        <p className="home-kicker">Seis especialidades, un solo modelo</p>
        <p className="home-lead">{t('home.lead')}</p>
        {continuing && continueProject && (
          <section>
            <h2>{t('home.continue')}</h2>
            <a className="home-card" href={continuing} data-testid="home-continue">
              <strong>{continueProject.name}</strong>
              <span>{t('home.diagrams', { count: continueProject.diagrams.length })}</span>
            </a>
          </section>
        )}
        <section aria-labelledby="home-projects">
          <h2 id="home-projects">{t('home.projects')}</h2>
          {!state.ready && <p>{t('home.loading')}</p>}
          {state.ready && state.error && <p role="alert">{state.error}</p>}
          {state.ready && !state.error && state.projects.length === 0 && (
            <p>
              {t('home.noProjects')} <a href="modulos.html?module=c4">{t('home.newProject')}</a>
            </p>
          )}
          {state.projects.length > 0 && (
            <ul className="home-list">
              {state.projects.map((project) => (
                <li key={project.id}>
                  <a className="home-card" href={projectHref(project)}>
                    <strong>{project.name}</strong>
                    <span>
                      {t('home.diagrams', { count: project.diagrams.length })}
                      {project.subjects?.length ? ` · ${project.subjects.map((subject) => subject.name).join(', ')}` : ''}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="home-modules">
          <h2 id="home-modules">{t('home.modules')}</h2>
          <div className="home-grid">
            {MODULE_SOURCES.map((source, index) => (
              <a key={source.id} className="home-card home-specialty" href={`modulos.html?module=${source.id}`}>
                <span className="home-index">{String(index + 1).padStart(2, '0')}</span>
                <strong>{source.label}</strong>
                <span>{source.id}</span>
              </a>
            ))}
          </div>
        </section>
        <section aria-labelledby="home-drafts">
          <h2 id="home-drafts">{t('home.drafts')}</h2>
          {drafts.length === 0 ? (
            <p>{t('home.noDrafts')}</p>
          ) : (
            <ul className="home-list">
              {drafts.map((source) => (
                <li key={source.id}>
                  <a className="home-card" href={`modulos.html?module=${source.id}`}>
                    <strong>{source.label}</strong>
                    <span>{source.id}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="home-instance">
          <h2 id="home-instance">{t('home.instance')}</h2>
          <form
            className="home-form"
            onSubmit={(event) => {
              event.preventDefault();
              const field = new FormData(event.currentTarget).get('manifest');
              const typed = typeof field === 'string' ? field.trim() : '';
              if (!typed) return;
              const url = new URL(window.location.href);
              url.searchParams.set('manifest', typed);
              window.location.assign(url.toString());
            }}
          >
            <label className="wb-visually-hidden" htmlFor="home-manifest">
              {t('home.manifest')}
            </label>
            <input id="home-manifest" name="manifest" type="text" spellCheck={false} placeholder="/.well-known/iark.json" />
            <button type="submit" className="primary">
              {t('home.connect')}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

export function HomeApp() {
  const session = getProjectSession();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const last = readLast();
  useEffect(() => {
    if (!session.getState().ready) void session.init();
  }, [session]);
  return <HomeScreen state={state} last={last} />;
}
