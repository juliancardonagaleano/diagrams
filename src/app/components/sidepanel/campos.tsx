import { IconChevronDown } from '@douyinfe/semi-icons';
import { useId } from 'react';

/**
 * Asociación entre una etiqueta visible y su control en las fichas del panel lateral (WCAG 1.3.1, 3.3.2 y 4.1.2): `<label for>` para
 * los campos nativos y de texto, y `aria-labelledby` para los selectores de Semi UI, cuyo nombre propio es fijo («selected») y no
 * dice de qué campo se trata.
 */
export interface Campo {
  /** Id del control. */
  id: string;
  /** Atributos de la etiqueta visible (`<label {...etiqueta}>`). */
  etiqueta: { id: string; htmlFor: string };
  /** Atributos de un `<Select>` de Semi UI: nombre accesible, sin opción activa fantasma y flecha decorativa. */
  select: { id: string; 'aria-labelledby': string; defaultActiveFirstOption: false; arrowIcon: React.ReactNode };
}

/**
 * Devuelve una función que crea los atributos de un campo por su nombre; los ids son únicos por tarjeta (`useId`), así que dos fichas
 * abiertas a la vez no comparten ids.
 */
export function useCampos(): (nombre: string) => Campo {
  const uid = useId();
  return (nombre) => {
    const id = `${uid}-${nombre}`;
    const labelId = `${id}-etiqueta`;
    return {
      id,
      etiqueta: { id: labelId, htmlFor: id },
      select: {
        id,
        'aria-labelledby': labelId,
        // Con la primera opción «activa» Semi apunta `aria-activedescendant` a una opción que no existe mientras la lista está cerrada.
        defaultActiveFirstOption: false,
        arrowIcon: <IconChevronDown aria-hidden="true" />,
      },
    };
  };
}
