// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLang, resetLang, setLang } from '../../../i18n';
import { useDocumentStore } from '../../store/documentStore';
import { ControlPanel } from './ControlPanel';

/** El selector de idioma del encabezado del editor C4: cambia los menús y las etiquetas al momento, sin recargar. */
describe('encabezado del editor C4: idioma', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetLang();
    useDocumentStore.getState().newDocument();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetLang();
  });

  const header = () => render(<ReactFlowProvider><ControlPanel /></ReactFlowProvider>);

  it('en español por omisión, con el selector accesible en el encabezado', () => {
    header();
    expect(screen.getByRole('button', { name: 'Archivo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar .drawio' })).toBeInTheDocument();
    const select = within(screen.getByRole('banner')).getByRole('combobox', { name: 'Idioma' });
    expect(select).toHaveValue('es');
  });

  it('elegir English traduce los menús y los botones y deja <html lang="en">', async () => {
    header();
    await userEvent.selectOptions(screen.getByTestId('lang-select'), 'en');
    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    for (const name of ['File', 'Edit', 'View', 'Settings', 'Help']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Export .drawio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to the canvas' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await userEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(await screen.findByText('New diagram')).toBeInTheDocument();
    expect(screen.getByText('Import Structurizr DSL…')).toBeInTheDocument();
  });

  it('volver a Español lo deja como estaba', async () => {
    setLang('en', { persist: false });
    header();
    await userEvent.selectOptions(screen.getByTestId('lang-select'), 'es');
    expect(screen.getByRole('button', { name: 'Archivo' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('es');
  });
});
