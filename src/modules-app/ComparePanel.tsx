import { useRef, useState } from 'react';
import { diffSummaryLine, formatFieldChange, type Analysis, type ChangedEntry, type DiffEntry, type DocumentDiff } from '@iark/kernel';
import { elementOf } from './compare';
import { useBulkInsert } from './bulkInsert';
import { readFile } from './files';
import { FilePicker } from './panels';

/** La comparación en curso: contra qué se compara y qué cambió. */
export interface CompareState {
  /** Nombre de la versión base (el del archivo abierto, o «JSON pegado»). */
  name: string;
  /** Qué cambió; no está mientras el documento actual no es válido. */
  diff?: DocumentDiff;
}

export interface ComparePanelProps {
  /** Extensiones que acepta el diálogo de «Abrir archivo a comparar…». */
  accept: string;
  analysis: Analysis;
  compare?: CompareState;
  /** Compara el documento actual con este texto (de un archivo, o pegado); devuelve el motivo si no se pudo. */
  onLoad(text: string, name: string): Promise<string | undefined>;
  onClear(): void;
  /** Lleva al lienzo con el elemento seleccionado y encuadrado. */
  onFocus(id: string): void;
}

/** Las entradas agrupadas por su lista, en el orden en que aparecen. */
function byCollection<T extends DiffEntry>(entries: readonly T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const e of entries) groups.set(e.collection, [...(groups.get(e.collection) ?? []), e]);
  return [...groups];
}

const SECTIONS = [
  { kind: 'added', title: 'Añadidos', sign: '+' },
  { kind: 'removed', title: 'Quitados', sign: '−' },
  { kind: 'changed', title: 'Modificados', sign: '~' },
] as const;

/**
 * Pestaña «Versiones»: se abre (o pega) otra versión del documento y se ve, agrupado, qué se añadió, qué se quitó y qué se
 * modificó (con cada campo antes → después). Un clic en un cambio lleva al lienzo con el elemento seleccionado. Todo se calcula
 * en el navegador.
 */
export function ComparePanel({ accept, analysis, compare, onLoad, onClear, onFocus }: ComparePanelProps) {
  const [pasted, setPasted] = useState('');
  const pasteArea = useRef<HTMLTextAreaElement>(null);
  useBulkInsert(pasteArea, setPasted);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = async (text: string, name: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const reason = await onLoad(text, name);
    setBusy(false);
    setError(reason);
    if (!reason) setPasted('');
  };
  const open = async (file: File): Promise<void> => load(await readFile(file), file.name);

  const diff = compare?.diff;
  const hasCurrent = analysis.status === 'ok';

  return (
    <div className="wb-panel wb-compare" role="tabpanel" aria-label="Versiones" data-testid="compare-panel">
      <p className="wb-hint">
        Compara el documento actual con otra versión y mira qué se añadió, qué se quitó y qué cambió. La maquetación guardada (coordenadas, tamaños) y el orden de las listas no cuentan como cambios. Todo se calcula aquí, sin servidor.
      </p>
      <div className="wb-toolbar">
        <FilePicker label="Abrir archivo a comparar…" accept={accept} disabled={busy || !hasCurrent} onFile={(file) => void open(file)} />
        {compare && (
          <button type="button" onClick={onClear} data-testid="compare-clear">
            Quitar comparación
          </button>
        )}
      </div>
      <details className="wb-compare-paste" open={!compare}>
        <summary>…o pega aquí el JSON de la otra versión</summary>
        <textarea ref={pasteArea} aria-label="JSON de la versión con la que comparar" spellCheck={false} rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} disabled={!hasCurrent} />
        <button type="button" disabled={busy || !hasCurrent || !pasted.trim()} onClick={() => void load(pasted, 'JSON pegado')} data-testid="compare-run">
          Comparar con este JSON
        </button>
      </details>
      {!hasCurrent && <div className="wb-note">El documento actual no es válido: corrígelo para poder compararlo.</div>}
      {error && (
        <div className="wb-note" role="alert" data-testid="compare-error">
          {error}
        </div>
      )}

      {compare && diff && hasCurrent && (
        <>
          <p className="wb-compare-summary" data-testid="compare-summary">
            <strong>{diffSummaryLine(diff)}</strong> Documento actual frente a «{compare.name}».
          </p>
          {SECTIONS.map(({ kind, title, sign }) => {
            const entries: DiffEntry[] = diff[kind];
            if (entries.length === 0) return null;
            return (
              <section key={kind} className="wb-compare-section" aria-label={title} data-testid={`compare-${kind}`}>
                <h2>
                  <span className={`wb-compare-sign ${kind}`} aria-hidden="true">
                    {sign}
                  </span>{' '}
                  {title} ({entries.length})
                </h2>
                {byCollection(entries).map(([collection, group]) => (
                  <div key={collection} className="wb-compare-group">
                    <h3>{collection}</h3>
                    <ul>
                      {group.map((e) => (
                        <ChangeRow key={`${e.collection}/${e.id}`} entry={e} kind={kind} onFocus={onFocus} />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
          {diff.moved.length > 0 && <p className="wb-hint">{diff.moved.length === 1 ? '1 elemento reordenado' : `${diff.moved.length} elementos reordenados`} (el orden no cuenta como cambio).</p>}
        </>
      )}
    </div>
  );
}

function ChangeRow({ entry, kind, onFocus }: { entry: DiffEntry; kind: 'added' | 'removed' | 'changed'; onFocus(id: string): void }) {
  const target = kind === 'removed' ? undefined : elementOf(entry);
  const fields = kind === 'changed' ? (entry as ChangedEntry).fields : [];
  const detail = [entry.kind, entry.id !== entry.label && !entry.id.startsWith('#') && entry.collection !== 'documento' ? entry.id : undefined].filter(Boolean).join(' · ');
  const label = (
    <>
      <strong>{entry.collection === 'documento' ? 'Campos del documento' : entry.label}</strong>
      {detail && <small>{detail}</small>}
    </>
  );
  return (
    <li data-testid={`change-${kind}-${entry.collection}-${entry.id}`}>
      {target ? (
        <button type="button" className="wb-change" onClick={() => onFocus(target)} title="Seleccionar en el lienzo">
          {label}
        </button>
      ) : (
        <span className="wb-change static" title={kind === 'removed' ? 'Ya no está en el documento actual' : undefined}>
          {label}
        </span>
      )}
      {fields.length > 0 && (
        <ul className="wb-compare-fields">
          {fields.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>: {formatFieldChange(f)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
