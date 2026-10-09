// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { pretty } from '@iark/kernel';
import { WorkbenchController, type ModuleSource } from './controller';
import { installFlowMocks } from './testing-dom';
import { FAKE_DOC, fakeModule, type FakeDoc } from './testing-editor';
import { Workbench } from './Workbench';

beforeAll(installFlowMocks);

const SOURCES: ModuleSource[] = [
  { id: 'fake', label: 'Con contratos', load: async () => fakeModule as never, example: async () => pretty(FAKE_DOC) },
  { id: 'otro', label: 'Otro', load: async () => ({ ...fakeModule, id: 'otro' }) as never, example: async () => pretty(FAKE_DOC) },
];

/** La versión anterior: sin «libre», con «api» con otros reintentos, con un «antiguo» que ya no está y con otro paso en cola-worker. */
function base(): FakeDoc {
  const doc = structuredClone(FAKE_DOC);
  doc.nodes = doc.nodes.filter((n) => n.id !== 'libre').map((n) => (n.id === 'api' ? { ...n, retries: 1 } : n));
  doc.nodes.push({ id: 'antiguo', kind: 'service', name: 'Servicio antiguo' });
  doc.edges = doc.edges.map((e) => (e.id === 'cola-worker' ? { ...e, step: 3 } : e));
  return doc;
}

async function open(): Promise<WorkbenchController> {
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
  await controller.selectModule('fake');
  render(<Workbench controller={controller} />);
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  return controller;
}

/** jsdom no implementa `Blob.text()`, que es lo que usa el banco de trabajo para leer un archivo abierto. */
const fileWith = (content: string, name: string): File => Object.defineProperty(new File([content], name, { type: 'application/json' }), 'text', { value: async () => content });

const paste = async (text: string): Promise<void> => {
  await userEvent.click(screen.getByRole('tab', { name: /^Versiones/ }));
  fireEvent.change(screen.getByLabelText('JSON de la versión con la que comparar'), { target: { value: text } });
  await userEvent.click(screen.getByTestId('compare-run'));
};

describe('pestaña «Versiones»', () => {
  it('sin comparar, el lienzo es el de siempre: sin marcas, sin barra y sin fantasmas', async () => {
    await open();
    expect(screen.getByRole('tab', { name: 'Versiones' })).toBeInTheDocument();
    expect(screen.queryByTestId('compare-bar')).toBeNull();
    expect(document.querySelectorAll('[data-diff]')).toHaveLength(0);
    expect(document.querySelectorAll('.cv-diff')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(FAKE_DOC.nodes.length);
  });

  it('pegando el JSON de otra versión lista lo añadido, quitado y modificado, con los campos antes → después', async () => {
    await open();
    await paste(JSON.stringify(base()));

    expect(await screen.findByTestId('compare-summary')).toHaveTextContent('1 añadido, 1 quitado, 2 modificados (2 campos). Documento actual frente a «JSON pegado».');
    expect(screen.getByRole('tab', { name: 'Versiones (4)' })).toBeInTheDocument();
    expect(within(screen.getByTestId('compare-added')).getByTestId('change-added-nodes-libre')).toHaveTextContent('Servicio libre');
    expect(within(screen.getByTestId('compare-removed')).getByTestId('change-removed-nodes-antiguo')).toHaveTextContent('Servicio antiguo');
    const api = screen.getByTestId('change-changed-nodes-api');
    expect(api).toHaveTextContent('API');
    expect(api).toHaveTextContent('retries: 1 → 2');
    expect(screen.getByTestId('change-changed-edges-cola-worker')).toHaveTextContent('step: 3 → 2');
    // Lo quitado ya no está en el documento actual: no se puede seleccionar.
    expect(within(screen.getByTestId('change-removed-nodes-antiguo')).queryByRole('button')).toBeNull();
  });

  it('un clic en un cambio lleva al lienzo con el elemento seleccionado y marca lo nuevo, lo modificado y lo quitado', async () => {
    await open();
    await paste(JSON.stringify(base()));
    await userEvent.click(within(await screen.findByTestId('change-changed-nodes-api')).getByRole('button'));

    expect(screen.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('node-api').closest('.react-flow__node')).toHaveClass('selected'), { timeout: 5000 });
    expect(screen.getByTestId('node-api')).toHaveAttribute('data-diff', 'modified');
    expect(screen.getByTestId('diff-api')).toHaveTextContent('Modificado');
    expect(screen.getByTestId('node-libre')).toHaveAttribute('data-diff', 'added');
    expect(screen.getByTestId('diff-libre')).toHaveTextContent('Nuevo');
    expect(screen.getByTestId('node-cola')).not.toHaveAttribute('data-diff');
    // La relación modificada lleva su marca, y lo quitado se dibuja como un fantasma con su insignia.
    expect(await screen.findByTestId('edge-label-cola-worker')).toHaveAttribute('data-diff', 'modified');
    expect(screen.getByTestId('node-antiguo')).toHaveAttribute('data-diff', 'removed');
    expect(screen.getByTestId('diff-antiguo')).toHaveTextContent('Quitado');
    expect(screen.getByTestId('node-antiguo').closest('.react-flow__node')).toHaveAttribute('data-id', 'ghost:antiguo');
    expect(screen.getByTestId('compare-bar')).toHaveTextContent('Comparando con JSON pegado: 1 añadido, 1 quitado, 2 modificados (2 campos).');
  });

  it('«Quitar comparación» (en la barra del lienzo o en la pestaña) vuelve al estado normal', async () => {
    await open();
    await paste(JSON.stringify(base()));
    await userEvent.click(await screen.findByTestId('compare-clear'));
    await waitFor(() => expect(screen.queryByTestId('compare-summary')).toBeNull());
    expect(screen.getByRole('tab', { name: 'Versiones' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Lienzo' }));
    expect(screen.queryByTestId('compare-bar')).toBeNull();
    expect(document.querySelectorAll('[data-diff]')).toHaveLength(0);
    expect(screen.queryByTestId('node-antiguo')).toBeNull();

    await paste(JSON.stringify(base()));
    await userEvent.click(screen.getByRole('tab', { name: 'Lienzo' }));
    await userEvent.click(await screen.findByTestId('compare-bar-clear'));
    expect(screen.queryByTestId('compare-bar')).toBeNull();
    expect(document.querySelectorAll('[data-diff]')).toHaveLength(0);
  });

  it('«Abrir archivo a comparar…» lee el archivo; «Ver cambios» de la barra vuelve a la lista', async () => {
    await open();
    await userEvent.click(screen.getByRole('tab', { name: 'Versiones' }));
    await userEvent.upload(screen.getByLabelText('Abrir archivo a comparar…'), fileWith(JSON.stringify(base()), 'version-anterior.json'));
    expect(await screen.findByTestId('compare-summary')).toHaveTextContent('Documento actual frente a «version-anterior.json».');

    await userEvent.click(screen.getByRole('tab', { name: 'Lienzo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver cambios' }));
    expect(screen.getByRole('tab', { name: /^Versiones/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('change-added-nodes-libre')).toBeInTheDocument();
  });

  it('el resultado sigue al documento: al editarlo se recalcula, y un documento igual no tiene cambios', async () => {
    const controller = await open();
    await paste(JSON.stringify(base()));
    expect(await screen.findByTestId('compare-summary')).toHaveTextContent('1 añadido, 1 quitado, 2 modificados');
    controller.setText(pretty(base()));
    await waitFor(() => expect(screen.getByTestId('compare-summary')).toHaveTextContent('Sin cambios.'));
    expect(screen.getByRole('tab', { name: 'Versiones (0)' })).toBeInTheDocument();
    expect(screen.queryByTestId('compare-added')).toBeNull();
  });

  it('un documento actual inválido avisa y conserva la comparación para cuando vuelva a serlo', async () => {
    const controller = await open();
    await paste(JSON.stringify(base()));
    await screen.findByTestId('compare-summary');
    controller.setText('{ "nodes": ');
    expect(await screen.findByText('El documento actual no es válido: corrígelo para poder compararlo.')).toBeInTheDocument();
    expect(screen.queryByTestId('compare-summary')).toBeNull();
    expect(screen.getByTestId('compare-clear')).toBeInTheDocument();
    controller.setText(pretty(FAKE_DOC));
    expect(await screen.findByTestId('compare-summary')).toHaveTextContent('1 añadido, 1 quitado, 2 modificados');
  });

  it('un texto que no sirve para comparar se explica y no cambia nada', async () => {
    await open();
    await paste('{ roto');
    expect(await screen.findByTestId('compare-error')).toHaveTextContent('no es JSON válido');
    expect(screen.queryByTestId('compare-summary')).toBeNull();
    expect(screen.queryByTestId('compare-clear')).toBeNull();
  });

  it('al cambiar de módulo la comparación se descarta', async () => {
    const controller = await open();
    await paste(JSON.stringify(base()));
    await screen.findByTestId('compare-summary');
    await controller.selectModule('otro');
    await userEvent.click(await screen.findByRole('tab', { name: 'Versiones' }));
    expect(screen.queryByTestId('compare-summary')).toBeNull();
    expect(screen.queryByTestId('compare-clear')).toBeNull();
  });
});
