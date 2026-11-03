// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectsState } from '../projects/session';
import { HomeScreen } from './Home';

const state = { ready: true, available: true, projects: [], save: 'idle' } as ProjectsState;

describe('inicio', () => {
  afterEach(() => cleanup());

  it('ofrece las especialidades, la trazabilidad y el editor clásico', () => {
    localStorage.clear();
    render(<HomeScreen state={state} />);
    expect(screen.getByRole('heading', { name: 'Especialidades' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Integración/ })).toHaveAttribute('href', '/modules/integration');
    expect(screen.getByRole('link', { name: 'Trazabilidad' })).toHaveAttribute('href', '/trace');
    expect(screen.getByRole('link', { name: 'Editor C4 clásico' })).toHaveAttribute('href', '?editor=1');
    expect(screen.getByText('Todavía no hay proyectos en este almacén.')).toBeInTheDocument();
  });

  it('continúa el último proyecto', () => {
    render(
      <HomeScreen
        state={{
          ...state,
          projects: [
            {
              id: 'tienda',
              name: 'Tienda',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              diagrams: [{ id: 'ctx', module: 'c4', name: 'Contexto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
            },
          ],
        }}
        last={{ projectId: 'tienda', diagramId: 'ctx' }}
      />,
    );
    expect(screen.getByTestId('home-continue')).toHaveAttribute('href', '/modules/c4?project=tienda&diagram=ctx');
  });
});
