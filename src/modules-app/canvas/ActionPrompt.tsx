import { useId, useState } from 'react';
import type { EditorAction } from '@iark/kernel';

interface Props {
  action: EditorAction<unknown>;
  document: unknown;
  /** Vista abierta: las propuestas de la acción pueden depender de ella. */
  viewId?: string;
  initial: string;
  onSubmit(value: string): void;
  onCancel(): void;
}

/** Formulario en línea con el que una acción del módulo pide su texto (el nombre del dominio…) antes de ejecutarse. */
export function ActionPrompt({ action, document, viewId, initial, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const listId = useId();
  const prompt = action.prompt;
  if (!prompt) return null;
  const suggestions = prompt.suggestions?.(document, viewId) ?? [];
  return (
    <form
      className="cv-prompt"
      aria-label={action.label}
      data-testid="action-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
    >
      <label>
        {prompt.label}
        <input
          type="text"
          value={value}
          placeholder={prompt.placeholder}
          list={suggestions.length > 0 ? listId : undefined}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }}
        />
      </label>
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <button type="submit" className="cv-tool cv-primary">
        Aceptar
      </button>
      <button type="button" className="cv-tool" onClick={onCancel}>
        Cancelar
      </button>
    </form>
  );
}
