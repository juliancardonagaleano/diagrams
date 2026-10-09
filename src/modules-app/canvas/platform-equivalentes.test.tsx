// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec } from '@iark/kernel';
import { platformEditor, platformModule, type PlatformDocument } from '@iark/domain-platform';
import example from '../../../examples/plataforma-ejemplo.json';
import { installFlowMocks, pickNode } from '../testing-dom';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

/** La marca «≈ <entorno>» de un recurso con equivalente declarado (`counterpartOf`) en el lienzo común. */
beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = platformEditor as unknown as EditorSpec<unknown>;
const base = platformModule.schema.parse(example) as PlatformDocument;
// La base y la cola de producción declaran las de desarrollo como suyas; el clúster y el balanceador no.
const doc: PlatformDocument = {
  ...base,
  resources: base.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, counterpartOf: 'pedidos-db-dev' } : r.id === 'kafka-prod' ? { ...r, counterpartOf: 'kafka-dev' } : r)),
};
const views = platformModule.views!(doc);

function mount(viewId: string): { doc(): PlatformDocument } {
  let current = pretty(doc);
  function Host() {
    const [text, setText] = useState(current);
    current = text;
    return <DiagramCanvas moduleId="platform" spec={spec} document={JSON.parse(text) as unknown} text={text} viewId={viewId} views={views} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={setText} notify={vi.fn()} />;
  }
  render(<Host />);
  return { doc: () => JSON.parse(current) as PlatformDocument };
}

describe('lienzo de plataforma: marca del equivalente en otro entorno', () => {
  it('el recurso con equivalente declarado lleva «≈ entorno», con su frase completa como nombre accesible y como ayuda', async () => {
    mount('env:prod');
    await waitFor(() => expect(screen.getByTestId('node-pedidos-db-prod')).toBeInTheDocument(), { timeout: 5000 });
    const mark = within(screen.getByTestId('node-pedidos-db-prod')).getByRole('img', { name: 'Equivalente en Desarrollo: Base de pedidos (dev)' });
    expect(mark).toHaveTextContent('≈ Desarrollo');
    expect(mark).toHaveAttribute('title', 'Equivalente en Desarrollo: Base de pedidos (dev)');
    expect(mark).toHaveClass('cv-node-mark');
    expect(within(screen.getByTestId('node-kafka-prod')).getByRole('img', { name: 'Equivalente en Desarrollo: Kafka (dev)' })).toBeInTheDocument();
  });

  it('un recurso sin equivalente declarado no lleva marca, ni la zona que no lo declara, ni las instancias', async () => {
    mount('env:prod');
    await waitFor(() => expect(screen.getByTestId('node-lb-prod')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('marks-lb-prod')).toBeNull();
    expect(screen.queryByTestId('marks-k8s-prod')).toBeNull();
    expect(document.querySelectorAll('.cv-node-marks')).toHaveLength(2);
  });

  it('el nombre del nodo para el lector de pantalla incluye la frase de la marca', async () => {
    mount('env:prod');
    await waitFor(() => expect(screen.getByTestId('node-pedidos-db-prod')).toBeInTheDocument(), { timeout: 5000 });
    const wrapper = screen.getByTestId('node-pedidos-db-prod').closest('.react-flow__node') as HTMLElement;
    expect(wrapper.getAttribute('aria-label')).toContain('Equivalente en Desarrollo: Base de pedidos (dev).');
  });

  it('declarar el equivalente en el panel de propiedades pone la marca, también en una zona, y quitarlo la quita', async () => {
    const host = mount('env:prod');
    await waitFor(() => expect(screen.getByTestId('node-k8s-prod')).toBeInTheDocument(), { timeout: 5000 });
    await pickNode('k8s-prod');
    const select = (await screen.findByLabelText('Equivalente en otro entorno')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'k8s-dev' } });
    await waitFor(() => expect(within(screen.getByTestId('node-k8s-prod')).getByRole('img', { name: 'Equivalente en Desarrollo: k8s-dev' })).toBeInTheDocument(), { timeout: 5000 });
    expect(host.doc().resources.find((r) => r.id === 'k8s-prod')?.counterpartOf).toBe('k8s-dev');
    fireEvent.change(screen.getByLabelText('Equivalente en otro entorno'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByTestId('marks-k8s-prod')).toBeNull(), { timeout: 5000 });
    expect(host.doc().resources.find((r) => r.id === 'k8s-prod')?.counterpartOf).toBeUndefined();
  });

  it('la vista de comparación de dos entornos no repite la marca', async () => {
    mount('compare:dev:prod');
    await waitFor(() => expect(screen.getByTestId('node-pedidos-db-prod')).toBeInTheDocument(), { timeout: 5000 });
    expect(document.querySelectorAll('.cv-node-marks')).toHaveLength(0);
  });
});
