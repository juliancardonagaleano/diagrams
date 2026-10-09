import { useEffect, useId, useState } from 'react';
import type { EditorGraph, EditorSpec } from '@iark/kernel';

interface Props {
  spec: EditorSpec<unknown>;
  graph: EditorGraph;
  /** Elemento de origen de la relación. */
  source: string;
  /** Tipos de relación que se pueden crear a mano. */
  kinds: ReadonlyArray<{ kind: string; label: string }>;
  kind: string;
  onKind(kind: string): void;
  /** Crea la relación (el lienzo valida si el módulo la admite y avisa si no). */
  onConnect(source: string, target: string): void;
}

/**
 * Crear una relación sin arrastrar (WCAG 2.1.1 y 2.5.7): el lienzo las crea arrastrando desde el punto de conexión de un elemento hasta
 * otro, algo que no se puede hacer con teclado ni con un puntero que no arrastra. Este formulario, en el panel de propiedades, hace lo
 * mismo con dos selectores y un botón, y pasa por la misma validación del módulo.
 */
export function ConnectForm({ spec, graph, source, kinds, kind, onKind, onConnect }: Props) {
  const id = useId();
  const targets = graph.nodes.filter((n) => n.id !== source);
  const [target, setTarget] = useState('');
  useEffect(() => setTarget(''), [source]);
  if (targets.length === 0 || kinds.length === 0) return null;
  const kindLabel = (k: string): string => spec.nodeKinds.find((n) => n.kind === k)?.label ?? k;
  return (
    <fieldset className="cv-connect" data-testid="connect-form">
      <legend>Crear una relación desde aquí</legend>
      {kinds.length > 1 && (
        <div className="cv-field">
          <label htmlFor={`${id}-kind`}>Tipo de relación</label>
          <select id={`${id}-kind`} value={kind} onChange={(e) => onKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cv-field">
        <label htmlFor={`${id}-target`}>Hacia</label>
        <select id={`${id}-target`} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="connect-target">
          <option value="">Elige un elemento</option>
          {targets.map((n) => (
            <option key={n.id} value={n.id}>
              {kindLabel(n.kind)}: {n.label}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="cv-tool" disabled={!target} onClick={() => target && onConnect(source, target)} data-testid="connect-create">
        Crear relación
      </button>
    </fieldset>
  );
}
