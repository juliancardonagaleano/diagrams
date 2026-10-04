// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { pretty } from '@iark/kernel';
import { BULK_INSERT_LINES, useBulkInsert } from './bulkInsert';
import { WorkbenchController, type ModuleSource } from './controller';
import { installFlowMocks } from './testing-dom';
import { FAKE_DOC, fakeModule } from './testing-editor';
import { Workbench } from './Workbench';

beforeAll(installFlowMocks);

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `línea ${i + 1}`).join('\n');

/** Un `beforeinput` como el que dispara Chromium con `Input.insertText` (Playwright `fill`/`insertText`, dictado…). */
function beforeInput(el: HTMLElement, data: string | null, inputType = 'insertText', cancelable = true): InputEvent {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable, inputType, data });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function Harness({ onChange }: { onChange?(value: string): void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useBulkInsert(ref, setText);
  return <textarea ref={ref} aria-label="texto" value={text} onChange={(e) => (setText(e.target.value), onChange?.(e.target.value))} />;
}

describe('useBulkInsert', () => {
  it('una inserción de muchas líneas se aplica de una vez: cancela la nativa, sustituye la selección y deja el cursor al final', () => {
    render(<Harness />);
    const area = screen.getByLabelText('texto') as HTMLTextAreaElement;
    // Texto previo con una parte seleccionada, que la inserción debe sustituir.
    act(() => {
      area.value = 'inicio [VIEJO] fin';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    area.setSelectionRange(7, 14);
    const pasted = lines(BULK_INSERT_LINES + 50);
    const event = beforeInput(area, pasted);
    expect(event.defaultPrevented).toBe(true);
    expect(area.value).toBe(`inicio ${pasted} fin`);
    expect(area.selectionStart).toBe(7 + pasted.length);
    expect(area.selectionEnd).toBe(7 + pasted.length);
  });

  it('en un cuadro vacío inserta todo el texto y el cursor queda al final', () => {
    render(<Harness />);
    const area = screen.getByLabelText('texto') as HTMLTextAreaElement;
    const pasted = lines(1000);
    expect(beforeInput(area, pasted).defaultPrevented).toBe(true);
    expect(area.value).toBe(pasted);
    expect(area.selectionStart).toBe(pasted.length);
  });

  it('lo normal no se toca: teclear, pocas líneas, el pegado real, el IME y los eventos no cancelables', () => {
    render(<Harness />);
    const area = screen.getByLabelText('texto') as HTMLTextAreaElement;
    const muchas = lines(BULK_INSERT_LINES + 50);
    expect(beforeInput(area, 'a').defaultPrevented).toBe(false);
    expect(beforeInput(area, lines(BULK_INSERT_LINES - 1)).defaultPrevented).toBe(false);
    expect(beforeInput(area, muchas, 'insertFromPaste').defaultPrevented).toBe(false);
    expect(beforeInput(area, muchas, 'insertCompositionText').defaultPrevented).toBe(false);
    expect(beforeInput(area, muchas, 'insertText', false).defaultPrevented).toBe(false);
    expect(beforeInput(area, null).defaultPrevented).toBe(false);
    expect(area.value).toBe('');
  });

  it('teclear después sigue funcionando con el texto insertado', async () => {
    render(<Harness />);
    const area = screen.getByLabelText('texto') as HTMLTextAreaElement;
    beforeInput(area, lines(300));
    await userEvent.type(area, '!');
    expect(area.value).toBe(`${lines(300)}!`);
  });
});

describe('cuadro «Texto a importar» del banco de trabajo', () => {
  const importado: string[] = [];
  const conImportador = {
    ...fakeModule,
    importers: [{ id: 'falso', label: 'Falso', extensions: ['.fake'], detect: (t: string) => t.startsWith('línea'), import: (t: string) => (importado.push(t), { document: FAKE_DOC, warnings: [] }) }],
  };
  const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con importador', load: async () => conImportador as never, example: async () => pretty(FAKE_DOC) }];

  it('una inserción sintética grande llega entera al importador', async () => {
    const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
    await controller.selectModule('fake');
    render(<Workbench controller={controller} />);
    await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'Importar' }));

    const area = screen.getByLabelText('Texto a importar') as HTMLTextAreaElement;
    const text = lines(2000);
    expect(beforeInput(area, text).defaultPrevented).toBe(true);
    expect(area.value).toBe(text);
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await waitFor(() => expect(importado).toEqual([text]));
  });
});

describe('el resto de cuadros grandes del banco de trabajo', () => {
  const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Fake', load: async () => fakeModule as never, example: async () => pretty(FAKE_DOC) }];
  const openWorkbench = async () => {
    const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
    await controller.selectModule('fake');
    render(<Workbench controller={controller} />);
    await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
    return controller;
  };

  it('«Documento JSON»: una inserción sintética grande entra de una vez en el documento del controlador', async () => {
    const controller = await openWorkbench();
    const area = screen.getByLabelText('Documento JSON') as HTMLTextAreaElement;
    area.setSelectionRange(0, area.value.length);
    const text = lines(2000);
    expect(beforeInput(area, text).defaultPrevented).toBe(true);
    expect(area.value).toBe(text);
    expect(controller.getState().text).toBe(text);
  });

  it('«Comparar»: el JSON de la otra versión se pega de una vez', async () => {
    await openWorkbench();
    await userEvent.click(screen.getByRole('tab', { name: /^Comparar/ }));
    const area = screen.getByLabelText('JSON de la versión con la que comparar') as HTMLTextAreaElement;
    const text = lines(1000);
    expect(beforeInput(area, text).defaultPrevented).toBe(true);
    expect(area.value).toBe(text);
    expect(area.selectionStart).toBe(text.length);
  });
  it('«Documento de origen» de una conversión: una inserción sintética grande entra de una vez', async () => {
    const convertir = { ...fakeModule, cliCommands: [{ name: 'convertir', kind: 'convert', description: 'Convierte', input: { description: 'documento de origen (JSON)' }, options: [], run: () => '{}' }] };
    const controller = new WorkbenchController([{ ...SOURCES[0], load: async () => convertir as never }], { renderDelay: 0 });
    await controller.selectModule('fake');
    render(<Workbench controller={controller} />);
    await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'Informes' }));
    const area = screen.getByPlaceholderText('Pega aquí el documento de origen') as HTMLTextAreaElement;
    const text = lines(1000);
    expect(beforeInput(area, text).defaultPrevented).toBe(true);
    expect(area.value).toBe(text);
  });
});
