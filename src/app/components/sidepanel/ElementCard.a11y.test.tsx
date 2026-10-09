// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../../store/documentStore';
import { ElementCard } from './ElementCard';

/**
 * Nombres accesibles de la ficha de un elemento (WCAG 1.3.1, 3.3.2 y 4.1.2). El `Select` de Semi UI pone a su disparador un nombre fijo
 * («selected») que no dice de qué campo es, y sus etiquetas visibles no estaban unidas a sus controles: aquí se comprueba que cada campo
 * se anuncia con el nombre de su etiqueta. (Abrir la lista del Select no es fiable en jsdom: eso se cubre en `tests/e2e/sidepanel.spec.ts`.)
 */
function elementNow(id: string) {
  return useDocumentStore.getState().doc.model.elements.find((e) => e.id === id)!;
}

describe('ElementCard · nombres accesibles', () => {
  beforeEach(() => {
    useDocumentStore.getState().loadSample();
  });

  it('cada campo de la ficha de un contenedor tiene el nombre de su etiqueta', () => {
    const contenedor = useDocumentStore.getState().doc.model.elements.find((e) => e.type === 'container')!;
    render(<ElementCard element={elementNow(contenedor.id)} inActiveView selected />);
    expect(screen.getByRole('textbox', { name: 'Nombre' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Tecnología' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Descripción' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tipo' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Forma' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Pertenece a' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Externo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Color')).toHaveAttribute('type', 'color');
  });

  it('los selectores no apuntan a una opción que no existe mientras la lista está cerrada', () => {
    const contenedor = useDocumentStore.getState().doc.model.elements.find((e) => e.type === 'container')!;
    render(<ElementCard element={elementNow(contenedor.id)} inActiveView selected />);
    for (const selector of screen.getAllByRole('combobox')) {
      expect(selector).toHaveAttribute('aria-expanded', 'false');
      // Un `aria-activedescendant` con un id que no está en el documento es un valor inválido (WAI-ARIA); vacío o ausente es lo correcto.
      const activo = selector.getAttribute('aria-activedescendant');
      expect(activo === null || activo === '' || document.getElementById(activo) !== null).toBe(true);
    }
  });

  it('el botón de la cabecera anuncia si la ficha está desplegada, y el del «ojo» es un botón aparte (no hay botones anidados)', () => {
    render(<ElementCard element={elementNow('cliente')} inActiveView={false} selected={false} />);
    const cabecera = screen.getByRole('button', { name: /Cliente personal/, expanded: false });
    expect(cabecera).toHaveAttribute('aria-expanded', 'false');
    const ojo = screen.getByRole('button', { name: /Añadir Cliente personal a la vista activa|Quitar Cliente personal de la vista activa/ });
    expect(ojo).not.toBe(cabecera);
    expect(cabecera.contains(ojo)).toBe(false);
  });
});
