// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { accionable } from './accionable';
import { pestanaDestino, tabIndexDePestana, teclasDePestanas } from './pestanas';

describe('pestanaDestino', () => {
  it('da la vuelta en los extremos y salta a Inicio y Fin', () => {
    expect(pestanaDestino('ArrowRight', 0, 3)).toBe(1);
    expect(pestanaDestino('ArrowRight', 2, 3)).toBe(0);
    expect(pestanaDestino('ArrowLeft', 0, 3)).toBe(2);
    expect(pestanaDestino('Home', 2, 3)).toBe(0);
    expect(pestanaDestino('End', 0, 3)).toBe(2);
  });

  it('ignora las demás teclas y las listas vacías', () => {
    expect(pestanaDestino('Enter', 0, 3)).toBeUndefined();
    expect(pestanaDestino('ArrowRight', 0, 0)).toBeUndefined();
  });
});

describe('tabIndexDePestana', () => {
  it('solo la pestaña activa (o la primera si ninguna lo está) es parada del tabulador', () => {
    expect(tabIndexDePestana(true, false, false)).toBe(0);
    expect(tabIndexDePestana(false, false, true)).toBe(-1);
    expect(tabIndexDePestana(false, true, true)).toBe(0);
    expect(tabIndexDePestana(false, true, false)).toBe(-1);
  });
});

function Pestanas() {
  const [activa, setActiva] = useState('uno');
  const ids = ['uno', 'dos', 'tres'];
  return (
    <div role="tablist" aria-label="Secciones" onKeyDown={teclasDePestanas}>
      {ids.map((id) => (
        <button key={id} type="button" role="tab" aria-selected={activa === id} tabIndex={tabIndexDePestana(activa === id, false, id === 'uno')} disabled={id === 'tres'} onClick={() => setActiva(id)}>
          {id}
        </button>
      ))}
    </div>
  );
}

describe('teclasDePestanas', () => {
  it('las flechas mueven el foco a la pestaña vecina y la activan, saltando las desactivadas', () => {
    render(<Pestanas />);
    const [uno, dos] = screen.getAllByRole('tab');
    uno.focus();
    fireEvent.keyDown(uno, { key: 'ArrowRight' });
    expect(dos).toHaveFocus();
    expect(dos).toHaveAttribute('aria-selected', 'true');
    expect(uno).toHaveAttribute('tabindex', '-1');
    // La siguiente a «dos» es «tres», desactivada: se da la vuelta a «uno».
    fireEvent.keyDown(dos, { key: 'ArrowRight' });
    expect(uno).toHaveFocus();
    expect(uno).toHaveAttribute('aria-selected', 'true');
  });

  it('con Ctrl, Alt o Meta no intercepta la tecla', () => {
    render(<Pestanas />);
    const [uno, dos] = screen.getAllByRole('tab');
    uno.focus();
    fireEvent.keyDown(uno, { key: 'ArrowRight', ctrlKey: true });
    expect(dos).not.toHaveFocus();
  });
});

describe('accionable', () => {
  function Fila({ alActivar }: { alActivar: () => void }) {
    return (
      <div data-testid="fila" {...accionable(alActivar, { expandido: false })}>
        <button type="button">Botón interior</button>
      </div>
    );
  }

  it('anuncia un botón con su estado, entra en el tabulador y se activa con Intro y con Espacio', () => {
    let veces = 0;
    render(<Fila alActivar={() => (veces += 1)} />);
    const fila = screen.getByTestId('fila');
    expect(fila).toHaveAttribute('role', 'button');
    expect(fila).toHaveAttribute('tabindex', '0');
    expect(fila).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(fila, { key: 'Enter' });
    fireEvent.keyDown(fila, { key: ' ' });
    fireEvent.click(fila);
    expect(veces).toBe(3);
  });

  it('Intro sobre un botón de su interior es de ese botón, no de la fila', () => {
    let veces = 0;
    render(<Fila alActivar={() => (veces += 1)} />);
    fireEvent.keyDown(screen.getByText('Botón interior'), { key: 'Enter' });
    expect(veces).toBe(0);
  });

  it('no usa atributos que no pidió', () => {
    expect(accionable(() => undefined)).not.toHaveProperty('aria-expanded');
    expect(accionable(() => undefined, { pulsado: true })).toHaveProperty('aria-pressed', true);
  });
});
