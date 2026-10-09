// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, type DiagramMeta } from '@iark/kernel';
import { ProjectsDialog, type ProjectsDialogProps } from './ProjectsDialog';
import { ProjectSession } from './session';

const MODULES = [
  { id: 'c4', label: 'C4' },
  { id: 'data', label: 'Datos' },
];

async function setup(extra: Partial<ProjectsDialogProps> = {}) {
  const store = new MemoryProjectStore();
  const session = new ProjectSession(store, { broadcast: false, persist: false, debounceMs: 10 });
  await session.init();
  const onOpen = vi.fn<(projectId: string, diagram: DiagramMeta) => void>();
  const onClose = vi.fn();
  const notify = vi.fn();
  render(<ProjectsDialog session={session} modules={MODULES} onOpen={onOpen} onClose={onClose} notify={notify} template={async (id, kind) => `{"module":"${id}","kind":"${kind}"}`} {...extra} />);
  return { store, session, onOpen, onClose, notify };
}

const create = async (name: string): Promise<void> => {
  await userEvent.type(screen.getByPlaceholderText('Nombre del proyecto'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
  await screen.findByRole('heading', { name });
};

describe('gestor de proyectos', () => {
  it('sin proyectos invita a crear el primero; crear uno lo selecciona y lo deja abierto en la sesión', async () => {
    const { session } = await setup();
    expect(screen.getByText(/Aún no hay proyectos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled();
    await create('Tienda');
    expect(session.getState().projectId).toBe(session.getState().projects[0].id);
    expect(screen.getByText('Este proyecto no tiene diagramas todavía.')).toBeInTheDocument();
  });

  it('«Crear y abrir» crea el diagrama con la plantilla elegida, lo abre y cierra el diálogo', async () => {
    const { store, session, onOpen, onClose } = await setup();
    await create('Tienda');
    const form = screen.getByRole('form', { name: 'Nuevo diagrama' });
    await userEvent.selectOptions(within(form).getByLabelText('Módulo del diagrama nuevo'), 'data');
    await userEvent.selectOptions(within(form).getByLabelText('Con qué empieza el diagrama nuevo'), 'blank');
    await userEvent.type(within(form).getByLabelText('Nombre del diagrama nuevo'), 'Ventas');
    await userEvent.click(within(form).getByRole('button', { name: 'Crear y abrir' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    const [projectId, meta] = onOpen.mock.calls[0];
    expect(meta).toMatchObject({ module: 'data', name: 'Ventas' });
    expect((await store.getDiagram(projectId, meta.id))?.text).toBe('{"module":"data","kind":"blank"}');
    expect(session.getState().diagramId).toBe(meta.id);
    expect(onClose).toHaveBeenCalled();
  });

  it('muestra el motivo cuando el almacén rechaza algo (nombre repetido) y no cierra', async () => {
    const { onClose } = await setup();
    await create('Tienda');
    await userEvent.type(screen.getByPlaceholderText('Nombre del proyecto'), 'tienda');
    await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('Ya existe un proyecto llamado «tienda»');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('borrar pide confirmación explícita y avisa de que no se puede deshacer', async () => {
    const { store } = await setup();
    await create('Tienda');
    await userEvent.click(screen.getByRole('button', { name: 'Borrar Tienda' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No se puede deshacer');
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(await store.listProjects()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Borrar Tienda' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(async () => expect(await store.listProjects()).toHaveLength(0));
    expect(await screen.findByText(/Aún no hay proyectos/)).toBeInTheDocument();
  });

  it('con un documento en edición ofrece guardarlo en el proyecto elegido', async () => {
    const { store, session, notify, onClose } = await setup({ current: () => ({ module: 'data', text: '{"x":1}', name: 'Ventas actual' }) });
    await create('Tienda');
    await userEvent.click(screen.getByRole('button', { name: /Guardar en «Tienda»/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [project] = await store.listProjects();
    expect(project.diagrams).toHaveLength(1);
    expect(project.diagrams[0]).toMatchObject({ module: 'data', name: 'Ventas actual' });
    expect(session.getState().diagramId).toBe(project.diagrams[0].id);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Los cambios se guardan solos'));
  });

  it('un archivo que no es un proyecto se rechaza con el motivo, y Escape cierra el diálogo', async () => {
    const { onClose } = await setup();
    const content = '{"workspace":{"name":"x"}}';
    const file = new File([content], 'x.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => content }); // jsdom no implementa `File.text()`
    await userEvent.upload(screen.getByLabelText('Importar proyecto desde un archivo'), file);
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('No es un proyecto de DIAgrams');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('si el almacenamiento no está disponible lo dice y sigue permitiendo importar', async () => {
    const store = new MemoryProjectStore();
    store.listProjects = async () => {
      throw new Error('bloqueado');
    };
    const session = new ProjectSession(store, { broadcast: false, persist: false });
    await session.init();
    render(<ProjectsDialog session={session} modules={MODULES} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('El almacenamiento del navegador no está disponible: bloqueado');
    expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled();
    expect(screen.getByLabelText('Importar proyecto desde un archivo')).toBeEnabled();
  });
});
