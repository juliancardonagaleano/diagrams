// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, pretty, type DiagramMeta, type VersionPolicy } from '@iark/kernel';
import { FAKE_DOC, fakeModule, type FakeDoc } from '../modules-app/testing-editor';
import { createProjectSession } from './factory';
import { HistoryDialog, type HistoryDialogProps } from './HistoryDialog';
import { ProjectSession } from './session';
import { resetLang, setLang } from '../i18n';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

/**
 * El cuadro «Historial de versiones» contra el servidor simulado (`fakeServer`: los mismos roles, errores y códigos que `iark serve`) y contra el almacén
 * de este navegador. Que el servidor de verdad hace lo mismo está en `src/cli/serveVersions.test.ts` y en la spec e2e `projects-versions.spec.ts`.
 */
const URL_ = 'http://localhost:8787';
/** Sin coalescencia (cada guardado es una versión), 5 automáticas y 2 nombradas como máximo. */
const POLICY: Partial<VersionPolicy> = { coalesceSeconds: 0, keepAutomatic: 5, maxVersions: 7 };
const ANA: FakePerson = { id: 'u_ana', login: 'ana', siteRole: 'member' };

/** El documento de pruebas con otro conjunto de nodos: cada variante es un documento distinto. */
const variant = (n: number): string => {
  const doc: FakeDoc = structuredClone(FAKE_DOC);
  if (n >= 2) doc.nodes.push({ id: 'extra', kind: 'service', name: 'Servicio extra' });
  if (n >= 3) doc.nodes[1].name = 'API pública';
  for (let i = 4; i <= n; i++) doc.nodes.push({ id: `nuevo${i}`, kind: 'service', name: `Servicio ${i}` });
  return pretty(doc);
};

interface Setup {
  session: ProjectSession;
  server?: FakeServer;
  project: { id: string; name: string };
  diagram: DiagramMeta;
}

/** El proyecto «Tienda» con el diagrama «Pedidos» guardado `saves` veces (las versiones 1 a `saves`) y abierto en la sesión. */
async function seed(session: ProjectSession, saves: number): Promise<Pick<Setup, 'project' | 'diagram'>> {
  await session.init();
  const project = await session.createProject('Tienda');
  const diagram = await session.createDiagram({ module: 'fake', name: 'Pedidos', text: variant(1) });
  for (let n = 2; n <= saves; n++) await session.store.saveDiagram(project.id, { id: diagram.id, text: variant(n) });
  await session.refresh();
  await session.openDiagram(project.id, diagram.id);
  return { project, diagram: session.diagram! };
}

/** Un servidor con tokens: el rol del token decide qué puede hacer. */
async function remote(role: 'viewer' | 'editor' | 'admin', saves = 3, store = new MemoryProjectStore(undefined, { versions: POLICY })): Promise<Setup> {
  const server = fakeServer({ token: 'secreto', role, name: 'Eva', store });
  // los datos los guarda el rol que haga falta; después la sesión de la prueba usa el rol pedido
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token: 'secreto' }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  server.role = 'admin';
  const seeded = await seed(session, saves);
  server.role = role;
  return { session, server, ...seeded };
}

/** Un servidor con cuentas: Ana tiene el rol dado en el proyecto «Tienda». */
async function withAccounts(role: 'viewer' | 'editor' | 'admin', saves = 3): Promise<Setup> {
  const server = fakeServer({ accounts: true, store: new MemoryProjectStore(undefined, { versions: POLICY }) });
  const token = server.openSession(ANA);
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  const seeded = await seed(session, saves);
  server.share(seeded.project.id, ANA, role);
  await session.refresh();
  return { session, server, ...seeded };
}

async function local(saves = 3): Promise<Setup> {
  // la pausa del autoguardado es larga: lo pendiente solo se guarda si alguien lo pide (`flush`)
  const session = new ProjectSession(new MemoryProjectStore(undefined, { versions: POLICY }), { broadcast: false, persist: false, debounceMs: 60_000 });
  return { session, ...(await seed(session, saves)) };
}

function open(setup: Setup, extra: Partial<HistoryDialogProps> = {}) {
  const props = {
    onClose: vi.fn(),
    notify: vi.fn(),
    onRestore: vi.fn((id: number) => setup.session.restoreVersion(setup.project.id, setup.diagram.id, id)),
    ...extra,
  };
  render(<HistoryDialog session={setup.session} projectId={setup.project.id} diagram={setup.diagram} loadModule={async () => fakeModule as never} {...props} />);
  return props;
}

const items = (): HTMLElement[] => screen.queryAllByTestId('history-item');
const ids = (): string[] => items().map((el) => el.getAttribute('data-version') ?? '');
const current = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-testid="history-item"][aria-current="true"]');
  if (!found) throw new Error('No hay ninguna versión elegida');
  return found;
};
const loaded = async (): Promise<void> => void (await screen.findAllByTestId('history-item'));
const changes = (): HTMLElement => screen.getByTestId('history-changes');
const pick = (version: number) => userEvent.click(items().find((el) => el.getAttribute('data-version') === String(version))!);
const stored = async (setup: Setup): Promise<string> => (await setup.session.store.getDiagram(setup.project.id, setup.diagram.id))!.text;

describe('historial de versiones (cuadro)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  describe('la lista y los cambios', () => {
    it('es un cuadro de diálogo con nombre; lista las versiones de la más reciente a la más antigua, con fecha y quién guardó', async () => {
      const setup = await remote('editor');
      open(setup);
      await loaded();
      const dialog = screen.getByRole('dialog', { name: 'Historial de versiones' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveTextContent('«Pedidos» · proyecto «Tienda» · servidor localhost:8787');
      expect(ids()).toEqual(['3', '2', '1']);
      expect(screen.getByTestId('history-count')).toHaveTextContent('3 versiones');
      const newest = items()[0];
      expect(newest).toHaveTextContent('Versión 3');
      expect(newest).toHaveTextContent('Actual');
      expect(newest).toHaveTextContent('· Eva'); // el nombre del token, no el que el cliente quiera poner
      expect(within(newest).getByText(/\d{4}/).closest('time')).toHaveAttribute('datetime', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
      expect(screen.getByRole('list')).toBeInTheDocument();
    });

    it('elige por omisión la última versión que difiere del diagrama de ahora y resume lo que cambió con el motor de diff', async () => {
      const setup = await remote('editor');
      open(setup);
      await loaded();
      expect(current()).toHaveAttribute('data-version', '2');
      await waitFor(() => expect(screen.getByTestId('history-summary')).toBeInTheDocument());
      // de la 2 a la actual: el nodo «API» se llama ahora «API pública»
      expect(screen.getByTestId('history-summary')).toHaveTextContent('1 modificado');
      expect(screen.getByTestId('history-summary')).toHaveTextContent('De la versión 2 al diagrama actual');
      const modified = screen.getByTestId('history-changed');
      expect(modified).toHaveTextContent('Modificados (1)');
      expect(modified).toHaveTextContent('name');
      expect(modified).toHaveTextContent('API');
      expect(modified).toHaveTextContent('API pública');
      expect(screen.queryByTestId('history-added')).toBeNull();
    });

    it('cada versión que se elige trae su propio resumen; la versión actual dice que es igual y la más antigua suma lo añadido', async () => {
      const setup = await remote('editor');
      open(setup);
      await loaded();
      await pick(1);
      await waitFor(() => expect(screen.getByTestId('history-summary')).toHaveTextContent('De la versión 1 al diagrama actual'));
      expect(screen.getByTestId('history-added')).toHaveTextContent('Añadidos (1)');
      expect(screen.getByTestId('history-added')).toHaveTextContent('Servicio extra');
      expect(screen.getByTestId('history-changed')).toHaveTextContent('Modificados (1)');
      await pick(3);
      await waitFor(() => expect(changes()).toHaveAttribute('data-status', 'same'));
      expect(changes()).toHaveTextContent('Sin cambios de contenido frente al diagrama actual');
      expect(screen.getByRole('region', { name: 'Detalle de la versión 3' })).toHaveTextContent('Actual');
    });

    it('si un documento no se puede interpretar lo dice sin romper el cuadro', async () => {
      const setup = await local(2);
      // un borrador que ya no es JSON: se guarda tal cual
      await setup.session.store.saveDiagram(setup.project.id, { id: setup.diagram.id, text: 'esto no es JSON' });
      open(setup);
      await loaded();
      await pick(1);
      await waitFor(() => expect(changes()).toHaveAttribute('data-status', 'unreadable'));
      expect(changes()).toHaveTextContent('no es JSON válido');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('muestra de dónde viene una versión restaurada y el tamaño', async () => {
      const setup = await local(3);
      await setup.session.restoreVersion(setup.project.id, setup.diagram.id, 1);
      open(setup);
      await loaded();
      expect(items()[0]).toHaveTextContent('Versión 4');
      expect(screen.getByRole('region', { name: /Detalle de la versión/ })).toHaveTextContent(/KB|\d+ B/);
      await pick(4);
      expect(screen.getByTestId('history-detail')).toHaveTextContent('Restaurada de la versión 1');
    });

    it('un diagrama anterior al historial no tiene versiones: lo dice, sin botones que no sirven', async () => {
      const setup = await local(1);
      vi.spyOn(setup.session.store as MemoryProjectStore, 'listVersions').mockResolvedValue([]);
      open(setup);
      expect(await screen.findByTestId('history-empty')).toHaveTextContent('todavía no tiene versiones');
      expect(screen.queryByRole('button', { name: 'Restaurar esta versión' })).toBeNull();
    });

    it('en este navegador no se sabe quién guarda: el detalle lo explica en lugar de dejar un hueco', async () => {
      const setup = await local(2);
      open(setup);
      await loaded();
      expect(screen.getByRole('region', { name: /Detalle de la versión/ })).toHaveTextContent('no se sabe');
      expect(items()[0].textContent).not.toContain('·  ·');
    });
  });

  describe('restaurar', () => {
    it('pide confirmación (con el foco en «No»); «No» no toca nada y «Sí, restaurar» restaura, avisa y deja la versión de antes para deshacerlo', async () => {
      const setup = await remote('editor');
      const props = open(setup);
      await loaded();
      await pick(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      const confirm = screen.getByTestId('history-confirm-restore');
      expect(confirm).toHaveTextContent('¿Restaurar la versión 1?');
      expect(confirm).toHaveTextContent('no se pierde');
      expect(screen.getByRole('button', { name: 'No' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'No' }));
      expect(props.onRestore).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toHaveFocus(); // el foco vuelve al botón
      expect(await stored(setup)).toBe(variant(3));

      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
      await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('Versión 1 restaurada: quedó guardada como la versión 4.'));
      expect(screen.getByTestId('history-note')).toHaveTextContent('Lo que había antes sigue en la versión 3');
      expect(props.onRestore).toHaveBeenCalledWith(1);
      expect(props.notify).toHaveBeenCalled();
      expect(await stored(setup)).toBe(variant(1));
      // la lista tiene la versión nueva arriba, elegida y marcada como la actual, y nada del historial se perdió
      await waitFor(() => expect(ids()).toEqual(['4', '3', '2', '1']));
      expect(current()).toHaveAttribute('data-version', '4');
      expect(current()).toHaveTextContent('Actual');
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeDisabled();
      expect(screen.getByTestId('history-hint')).toHaveTextContent('igual al diagrama actual');
      // deshacer = restaurar la 3
      await pick(3);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
      await waitFor(async () => expect(await stored(setup)).toBe(variant(3)));
    });

    it('en este navegador funciona igual, y guarda antes lo pendiente: lo que se estaba editando queda en el historial', async () => {
      const setup = await local(2);
      setup.session.queueSave(variant(3)); // un cambio sin guardar todavía
      open(setup);
      await loaded();
      // al abrir se guardó lo pendiente: es la versión 3, la actual
      expect(ids()).toEqual(['3', '2', '1']);
      expect(items()[0]).toHaveTextContent('Actual');
      await pick(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
      await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('quedó guardada como la versión 4'));
      expect(await stored(setup)).toBe(variant(1));
      expect((await setup.session.listVersions(setup.project.id, setup.diagram.id)).map((v) => v.id)).toEqual([4, 3, 2, 1]);
    });

    it('si otra persona guardó mientras tanto: avisa del conflicto, no toca nada y deja el conflicto donde se resuelve (la barra del proyecto)', async () => {
      const setup = await remote('editor');
      open(setup);
      await loaded();
      await pick(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      // otra persona guarda el mismo diagrama
      await setup.server!.store.saveDiagram(setup.project.id, { id: setup.diagram.id, text: variant(2) });
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
      await waitFor(() => expect(screen.getByTestId('history-error')).toHaveTextContent('No se pudo restaurar la versión 1.'));
      expect(screen.getByTestId('history-error')).toHaveTextContent('Resuelve el conflicto en la barra del proyecto');
      expect(await stored(setup)).toBe(variant(2));
      expect(setup.session.getState().save).toBe('conflict');
    });

    it('restaurar una versión que ya rotó del historial (otra persona siguió guardando) lo cuenta y relee la lista', async () => {
      const setup = await remote('editor', 3, new MemoryProjectStore(undefined, { versions: { coalesceSeconds: 0, keepAutomatic: 3, maxVersions: 4 } }));
      open(setup);
      await loaded();
      await pick(1);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      // otra persona guarda: la versión 1 rota fuera del historial
      await setup.server!.store.saveDiagram(setup.project.id, { id: setup.diagram.id, text: variant(2) });
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
      await waitFor(() => expect(screen.getByTestId('history-error')).toBeInTheDocument());
      await waitFor(() => expect(ids()).not.toContain('1'));
    });
  });

  describe('nombrar y borrar', () => {
    it('«Nombrar versión» abre un campo con su ayuda; no admite un nombre vacío; al guardarlo la versión lleva el nombre y no se descarta sola', async () => {
      const setup = await remote('editor');
      open(setup);
      await loaded();
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      const field = screen.getByRole('textbox', { name: 'Nombre de la versión' });
      expect(field).toHaveFocus();
      expect(field).toHaveAccessibleDescription(/no se sustituye ni se descarta sola/);
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      expect(screen.getByTestId('history-name-error')).toHaveTextContent('Escribe un nombre');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect((await setup.session.listVersions(setup.project.id, setup.diagram.id)).every((v) => v.label === undefined)).toBe(true);

      await userEvent.type(field, 'Antes de ampliar');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('Versión 2 nombrada «Antes de ampliar»'));
      expect(current()).toHaveTextContent('«Antes de ampliar»');
      expect(current()).toHaveAttribute('data-label', 'Antes de ampliar');
      expect(screen.getByTestId('history-count')).toHaveTextContent('1 con nombre');
      expect(screen.getByRole('button', { name: 'Cambiar el nombre' })).toHaveFocus();
      expect((await setup.session.listVersions(setup.project.id, setup.diagram.id)).find((v) => v.id === 2)?.label).toBe('Antes de ampliar');
    });

    it('Escape cancela el campo del nombre sin cerrar el cuadro; un segundo Escape lo cierra', async () => {
      const setup = await remote('editor');
      const props = open(setup);
      await loaded();
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('textbox', { name: 'Nombre de la versión' })).toBeNull();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Nombrar versión' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('con el tope de versiones con nombre lleno el servidor lo dice (límite) y el cuadro lo muestra con su motivo', async () => {
      const setup = await remote('editor', 4);
      open(setup);
      await loaded();
      for (const [version, name] of [
        [4, 'Cuatro'],
        [3, 'Tres'],
      ] as const) {
        await pick(version);
        await userEvent.click(screen.getByRole('button', { name: /^(Nombrar versión|Cambiar el nombre)$/ }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), name);
        await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
        await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent(`Versión ${version} nombrada`));
      }
      await pick(2);
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), 'Dos');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByTestId('history-error')).toHaveTextContent('No se pudo nombrar la versión 2.'));
      expect(screen.getByTestId('history-error')).toHaveTextContent('2 versiones con nombre');
    });

    it('borrar una versión con nombre es de quien administra: pide confirmación y la quita; un editor no ve el botón y se le explica', async () => {
      const admin = await remote('admin');
      open(admin);
      await loaded();
      expect(screen.queryByRole('button', { name: 'Borrar esta versión' })).toBeNull(); // sin nombre no se borra a mano
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), 'Entrega 1');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Borrar esta versión' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Borrar esta versión' }));
      expect(screen.getByTestId('history-confirm-delete')).toHaveTextContent('¿Borrar la versión 2 «Entrega 1» del historial? No se puede deshacer.');
      await userEvent.click(screen.getByRole('button', { name: 'No' }));
      expect((await admin.session.listVersions(admin.project.id, admin.diagram.id)).some((v) => v.label)).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: 'Borrar esta versión' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }));
      await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('Se borró la versión 2 «Entrega 1» del historial.'));
      await waitFor(() => expect(ids()).toEqual(['3', '1']));
      expect(current()).toBeTruthy();
      cleanup();

      const editor = await remote('editor');
      await editor.session.labelVersion(editor.project.id, editor.diagram.id, 2, 'De otra persona');
      open(editor);
      await loaded();
      await pick(2);
      expect(screen.queryByRole('button', { name: 'Borrar esta versión' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Cambiar el nombre' })).toBeEnabled();
      expect(screen.getByRole('region', { name: 'Detalle de la versión 2' })).toHaveTextContent('lo decide quien administra el proyecto');
    });
  });

  describe('roles', () => {
    it('un lector ve el historial y los cambios, pero no restaura ni nombra: los botones están desactivados y dicen por qué', async () => {
      const setup = await remote('viewer');
      // con un token no hay rol por proyecto: lo da `whoami`
      open(setup);
      await loaded();
      expect(ids()).toEqual(['3', '2', '1']);
      await waitFor(() => expect(screen.getByTestId('history-summary')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Nombrar versión' })).toBeDisabled();
      expect(screen.getByTestId('history-hint')).toHaveTextContent('Tu rol en el proyecto (lector) permite consultar el historial, pero no restaurar ni nombrar versiones.');
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toHaveAccessibleDescription(/permite consultar el historial/);
    });

    it('con cuentas, el rol sale de su pertenencia al proyecto: lector solo mira, editor restaura y nombra, administrador además borra', async () => {
      const viewer = await withAccounts('viewer');
      open(viewer);
      await loaded();
      expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Nombrar versión' })).toBeDisabled();
      cleanup();

      const editor = await withAccounts('editor');
      open(editor);
      await loaded();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
      expect(screen.getByRole('button', { name: 'Nombrar versión' })).toBeEnabled();
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), 'Mía');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('nombrada «Mía»'));
      expect(screen.queryByRole('button', { name: 'Borrar esta versión' })).toBeNull();
      expect((await editor.session.listVersions(editor.project.id, editor.diagram.id)).find((v) => v.label)?.savedBy).toBe('@ana');
      cleanup();

      const admin = await withAccounts('admin');
      open(admin);
      await loaded();
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), 'Mía');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Borrar esta versión' })).toBeEnabled());
    });

    it('si el rol cambia mientras el cuadro está abierto, el servidor lo niega y el cuadro cuenta el motivo del servidor', async () => {
      const setup = await withAccounts('editor');
      open(setup);
      await loaded();
      setup.server!.share(setup.project.id, ANA, 'viewer'); // un administrador le quita el permiso
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la versión' }), 'Tarde');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
      await waitFor(() => expect(screen.getByTestId('history-error')).toHaveTextContent('No se pudo nombrar la versión'));
      expect(screen.getByTestId('history-error')).toHaveTextContent('Puede que tu rol en el proyecto haya cambiado');
      expect((await setup.session.listVersions(setup.project.id, setup.diagram.id)).some((v) => v.label)).toBe(false);
    });
  });

  describe('un almacén o un servidor sin historial', () => {
    it('un servidor anterior al historial (sin las rutas) lo cuenta y deja claro que los diagramas se guardan igual', async () => {
      const setup = await remote('editor', 2, new MemoryProjectStore(undefined, { versions: false }));
      expect(setup.session.canVersion).toBe(true); // el cliente HTTP sabe pedirlo; que el servidor lo tenga se sabe al pedirlo
      open(setup);
      const blocked = await screen.findByTestId('history-blocked');
      expect(blocked).toHaveAttribute('data-code', 'unsupported');
      expect(blocked).toHaveTextContent('Este servidor no guarda historial de versiones');
      expect(screen.getByRole('dialog')).toHaveTextContent('Los diagramas se siguen guardando con normalidad');
      expect(screen.queryAllByTestId('history-item')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Restaurar esta versión' })).toBeNull();
      expect(await stored(setup)).toBe(variant(2));
    });

    it('un fallo de red al abrir lo muestra con «Reintentar», que vuelve a leer', async () => {
      const setup = await remote('editor');
      setup.server!.down = true;
      open(setup);
      const blocked = await screen.findByTestId('history-blocked');
      expect(blocked).toHaveAttribute('data-code', 'other');
      setup.server!.down = false;
      await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
      await loaded();
      expect(ids()).toEqual(['3', '2', '1']);
    });

    it('una sesión caducada lo dice y manda a iniciar sesión', async () => {
      const setup = await withAccounts('editor');
      setup.server!.sessions.clear();
      open(setup);
      const blocked = await screen.findByTestId('history-blocked');
      expect(blocked).toHaveAttribute('data-code', 'unauthorized');
      expect(blocked).toHaveTextContent('Tu sesión caducó');
    });

    it('si el diagrama se borró mientras tanto lo dice en lugar de mostrar un historial huérfano', async () => {
      const setup = await local(2);
      await setup.session.store.deleteDiagram(setup.project.id, setup.diagram.id);
      open(setup);
      expect(await screen.findByTestId('history-blocked')).toHaveTextContent('ya no existe');
    });
  });

  describe('teclado y accesibilidad', () => {
    it('el foco entra en el cuadro, queda atrapado dentro y vuelve a quien lo abrió al cerrarse', async () => {
      const setup = await remote('editor');
      const opener = document.createElement('button');
      opener.textContent = 'Historial…';
      document.body.append(opener);
      opener.focus();
      const props = open(setup);
      expect(screen.getByRole('dialog')).toHaveFocus();
      await loaded();
      // Tab recorre los controles del cuadro y vuelve al primero sin salir de él
      const focusable = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] input:not(:disabled)')].filter((el) => el.tabIndex >= 0);
      const last = focusable().at(-1)!;
      last.focus();
      await userEvent.tab();
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(focusable()[0]);
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toBe(last);
      await userEvent.keyboard('{Escape}');
      expect(props.onClose).toHaveBeenCalled();
      cleanup();
      expect(opener).toHaveFocus();
      opener.remove();
    });

    it('las flechas, inicio y fin mueven la elección por la lista (solo la elegida está en el orden de tabulación)', async () => {
      const setup = await remote('editor', 4);
      open(setup);
      await loaded();
      const tabbable = (): string[] => items().filter((el) => el.tabIndex === 0).map((el) => el.getAttribute('data-version') ?? '');
      expect(tabbable()).toEqual([current().getAttribute('data-version')]);
      current().focus();
      await userEvent.keyboard('{Home}');
      await waitFor(() => expect(current()).toHaveAttribute('data-version', '4'));
      expect(current()).toHaveFocus();
      await userEvent.keyboard('{ArrowDown}');
      await waitFor(() => expect(current()).toHaveAttribute('data-version', '3'));
      expect(current()).toHaveFocus();
      await userEvent.keyboard('{End}');
      await waitFor(() => expect(current()).toHaveAttribute('data-version', '1'));
      await userEvent.keyboard('{ArrowDown}'); // ya es la última: no se sale ni pierde el foco
      expect(current()).toHaveAttribute('data-version', '1');
      expect(current()).toHaveFocus();
      await userEvent.keyboard('{ArrowUp}');
      await waitFor(() => expect(current()).toHaveAttribute('data-version', '2'));
      expect(tabbable()).toEqual(['2']);
    });

    it('todo tiene nombre accesible: los botones, el campo, las regiones y los avisos; los avisos de estado se anuncian', async () => {
      const setup = await remote('admin');
      open(setup);
      await loaded();
      expect(screen.getByRole('button', { name: 'Cerrar' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Versiones' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: /^Acciones sobre la versión \d$/ })).toBeInTheDocument();
      expect(screen.getByTestId('history-count')).toHaveAttribute('role', 'status');
      await userEvent.click(screen.getByRole('button', { name: 'Nombrar versión' }));
      expect(screen.getByRole('form', { name: /^Nombrar la versión \d$/ })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Nombre de la versión' })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
      expect(screen.getByRole('alert')).toHaveTextContent('¿Restaurar la versión');
    });

    it('pulsar fuera del cuadro lo cierra; dentro, no', async () => {
      const setup = await remote('editor');
      const props = open(setup);
      await loaded();
      await userEvent.click(screen.getByRole('dialog'));
      expect(props.onClose).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('dialog').parentElement!);
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('historial de versiones (cuadro) en inglés', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setLang('en', { persist: false });
  });
  afterEach(() => {
    cleanup();
    resetLang();
  });

  it('todo el cuadro sale en inglés: título, lista, resumen de cambios, fechas y plurales', async () => {
    const setup = await remote('admin');
    open(setup);
    await loaded();
    const dialog = screen.getByRole('dialog', { name: 'Version history' });
    expect(dialog).toHaveTextContent('“Pedidos” · project “Tienda” · server localhost:8787');
    expect(screen.getByTestId('history-count')).toHaveTextContent('3 versions');
    expect(items()[0]).toHaveTextContent('Version 3');
    expect(items()[0]).toHaveTextContent('Current');
    await waitFor(() => expect(screen.getByTestId('history-summary')).toBeInTheDocument());
    expect(screen.getByTestId('history-summary')).toHaveTextContent('1 modified (1 field). From version 2 to the current diagram.');
    expect(screen.getByTestId('history-changed')).toHaveTextContent('Modified (1)');
    expect(screen.getByRole('region', { name: 'Versions' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Actions on version 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // la fecha sigue el formato del idioma (mes escrito en inglés, no «ene», «feb»…)
    expect(items()[0].querySelector('time')?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  });

  it('confirmar y restaurar usan los textos en inglés, con el nombre del diagrama', async () => {
    const setup = await remote('admin');
    open(setup);
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    expect(screen.getByTestId('history-confirm-restore')).toHaveTextContent('Restore version 2? The diagram “Pedidos” will take on its content');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, restore' }));
    await waitFor(() => expect(screen.getByTestId('history-note')).toHaveTextContent('Version 2 restored: it was saved as version 4.'));
  });

  it('las pistas por rol salen en inglés (un lector puede consultar pero no restaurar)', async () => {
    const setup = await remote('viewer');
    setup.server!.role = 'viewer';
    open(setup);
    await loaded();
    expect(screen.getByTestId('history-hint')).toHaveTextContent('Your role in the project (reader) lets you consult the history but not restore or name versions.');
  });
});
