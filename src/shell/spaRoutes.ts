/**
 * Router unificado del shell SPA (spec 006, primer paso).
 * Resuelve rutas canónicas por pathname y conserva las consultas históricas de `boot.ts`.
 */

export type SpaBootTarget =
  | { kind: 'home' }
  | { kind: 'studio' }
  | { kind: 'classic-editor' }
  | { kind: 'suite-shell' }
  | { kind: 'legacy-modules'; moduleId: string; search: string }
  | { kind: 'legacy-trace'; search: string };

/** Normaliza el pathname (sin barra final, salvo `/`). */
export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

/**
 * Decide qué superficie cargar. Las rutas `/modules/*` y `/trace` siguen en sus HTML legacy
 * hasta quitar entradas extra de Vite (spec 006, paso siguiente).
 */
export function resolveSpaBootTarget(pathname: string, params: URLSearchParams): SpaBootTarget {
  const path = normalizePathname(pathname);

  const modules = /^\/modules\/([^/]+)$/.exec(path);
  if (modules) {
    const moduleId = decodeURIComponent(modules[1]);
    const search = new URLSearchParams(params);
    search.set('module', moduleId);
    return { kind: 'legacy-modules', moduleId, search: search.toString() };
  }

  if (path === '/trace') {
    const search = params.toString();
    return { kind: 'legacy-trace', search };
  }

  if (path === '/studio') return { kind: 'studio' };
  if (path === '/editor') return { kind: 'classic-editor' };
  if (path === '/projects') return { kind: 'home' };

  const embed = params.get('embed') === '1';
  const editor = params.get('editor') === '1' || (embed && params.get('surface') !== 'home');
  const studio =
    path === '/studio' ||
    (!embed && params.get('classic') !== '1' && (params.get('studio') === '1' || params.get('editor') === '1'));

  if (studio) return { kind: 'studio' };
  if (editor) return { kind: 'classic-editor' };
  if (params.has('manifest')) return { kind: 'suite-shell' };
  return { kind: 'home' };
}

export async function bootSpaTarget(target: SpaBootTarget): Promise<void> {
  switch (target.kind) {
    case 'legacy-modules': {
      const suffix = target.search ? `?${target.search}` : '';
      window.location.replace(`/modulos.html${suffix}`);
      return;
    }
    case 'legacy-trace': {
      const suffix = target.search ? `?${target.search}` : '';
      window.location.replace(`/trazabilidad.html${suffix}`);
      return;
    }
    case 'studio':
      await import('../studio/main.tsx');
      return;
    case 'classic-editor':
      await import('../app/main.tsx');
      return;
    case 'suite-shell': {
      const { renderSuiteShell } = await import('./document');
      renderSuiteShell();
      await import('./main.ts');
      return;
    }
    case 'home':
      await import('../home/main.tsx');
      return;
  }
}
