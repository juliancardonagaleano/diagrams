import { useMemo, useRef, useState } from 'react';
import type { WorkbenchController, WorkbenchState } from './controller';
import { commandInfos, countBySeverity, exportFormats, joinSourceFiles, looksLikeMermaid, multiFileImporter, whyNotMultiFile, type CommandInfo, type CommandOutput, type ExportedFile, type SourceFile } from '@iark/kernel';
import { MermaidPreview } from '../mermaid-preview/MermaidPreview';
import { useBulkInsert } from './bulkInsert';
import { copyText, downloadText, fileStem, readFile, svgDataUrl } from './files';

const SEVERITY_LABEL = { error: 'Error', warning: 'Aviso', info: 'Nota' } as const;

/**
 * Botón «Abrir archivo…» con el `<input type=file>` oculto pero accesible (el nombre accesible es la etiqueta). Con `onFiles`
 * se pueden elegir varios archivos a la vez (siempre los entrega todos, aunque sea uno); si no, entrega el primero con `onFile`.
 */
export function FilePicker({ label, accept, disabled, onFile, onFiles }: { label: string; accept?: string; disabled?: boolean; onFile?(file: File): void; onFiles?(files: File[]): void }) {
  return (
    <label className={`wb-btn${disabled ? ' disabled' : ''}`}>
      {label}
      <input
        className="wb-visually-hidden"
        type="file"
        accept={accept}
        multiple={!!onFiles}
        disabled={disabled}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (onFiles) {
            if (files.length > 0) onFiles(files);
          } else if (files[0]) onFile?.(files[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}

interface PanelProps {
  controller: WorkbenchController;
  state: WorkbenchState;
  /** Lleva el cursor del editor al `"id"` indicado. */
  reveal(id: string): void;
  notify(message: string): void;
}

// ───────────── Diagrama ─────────────

export function DiagramPanel({ controller, state }: PanelProps) {
  const [fit, setFit] = useState(true);
  const { module, choices, viewId, svg, renderError, rendering, analysis } = state;
  const stale = analysis.status !== 'ok' && !!svg;

  return (
    <div className="wb-panel diagram" role="tabpanel" aria-label="Diagrama">
      <div className="wb-toolbar">
        <label htmlFor="wb-view">Vista</label>
        <select id="wb-view" value={viewId ?? ''} disabled={choices.views.length + choices.traces.length === 0} onChange={(e) => controller.setView(e.target.value)}>
          {viewId === undefined && <option value="">—</option>}
          {choices.views.length > 0 && (
            <optgroup label="Vistas">
              {choices.views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </optgroup>
          )}
          {choices.traces.map((trace) => (
            <optgroup key={trace.prefix} label={trace.label}>
              {trace.entities.map((e) => (
                <option key={e.id} value={`${trace.prefix}:${e.id}`}>
                  {e.name} ({e.kind})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" onClick={() => setFit((f) => !f)} aria-pressed={fit}>
          {fit ? 'Tamaño real' : 'Ajustar al panel'}
        </button>
        {rendering && <span className="wb-chip info">Dibujando…</span>}
      </div>
      {stale && <div className="wb-note">El documento tiene problemas: se muestra el último dibujo válido.</div>}
      {renderError && (
        <div className="wb-note" role="alert">
          {renderError}
        </div>
      )}
      <div className={`wb-stage${fit ? ' fit' : ''}`} data-testid="diagram-stage">
        {svg ? (
          <img alt={`Diagrama de la vista ${viewId ?? ''} del módulo ${module?.name ?? ''}`} src={svgDataUrl(svg)} data-view={viewId} />
        ) : (
          <div className="wb-empty">{analysis.status === 'ok' ? (rendering ? 'Dibujando…' : 'Sin vista que mostrar.') : 'Escribe o carga un documento válido para ver el diagrama.'}</div>
        )}
      </div>
    </div>
  );
}

// ───────────── Problemas ─────────────

export function IssuesPanel({ state, reveal }: PanelProps) {
  const { analysis } = state;
  if (analysis.status === 'empty') return <div className="wb-panel wb-empty">El documento está vacío.</div>;
  if (analysis.status === 'syntax')
    return (
      <div className="wb-panel" role="tabpanel" aria-label="Problemas">
        <ul className="wb-issues">
          <li>
            <span className="wb-chip error">Sintaxis</span>
            <span>No es JSON válido: {analysis.error}</span>
          </li>
        </ul>
      </div>
    );
  if (analysis.status === 'schema')
    return (
      <div className="wb-panel" role="tabpanel" aria-label="Problemas">
        <p>El documento no cumple el esquema del módulo ({analysis.issues.length}):</p>
        <ul className="wb-issues">
          {analysis.issues.map((issue, index) => (
            <li key={index}>
              <span className="wb-chip error">Esquema</span>
              <span>
                <span className="wb-path">{issue.path}</span>
                <br />
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  const counts = countBySeverity(analysis.issues);
  if (analysis.issues.length === 0)
    return (
      <div className="wb-panel" role="tabpanel" aria-label="Problemas">
        <p>
          <span className="wb-chip ok">Sin problemas</span> El documento cumple el esquema y las reglas del módulo.
        </p>
      </div>
    );
  return (
    <div className="wb-panel" role="tabpanel" aria-label="Problemas">
      <p>
        {counts.error} errores · {counts.warning} avisos · {counts.info} notas
      </p>
      <ul className="wb-issues">
        {analysis.issues.map((issue, index) => (
          <li key={index}>
            <span className={`wb-chip ${issue.severity}`}>{SEVERITY_LABEL[issue.severity]}</span>
            <span>
              {issue.message}
              {issue.elementId && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => reveal(issue.elementId!)}>
                    ver «{issue.elementId}»
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────── Informes y conversiones ─────────────

function CommandCard({ controller, command, notify }: { controller: WorkbenchController; command: CommandInfo; notify(message: string): void }) {
  const [args, setArgs] = useState<string[]>(() => command.args.map(() => ''));
  const [options, setOptions] = useState<Record<string, string | boolean>>({});
  const [source, setSource] = useState('');
  const sourceArea = useRef<HTMLTextAreaElement>(null);
  useBulkInsert(sourceArea, setSource);
  const [result, setResult] = useState<CommandOutput | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const convert = command.kind === 'convert';

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await controller.run(command.name, { args, options, ...(convert ? { input: source, fromEditor: false } : {}) }));
    } catch (e) {
      setResult(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="wb-cmd" data-command={command.name}>
      <summary>
        {command.name} <span className="wb-chip info">{convert ? 'conversión' : 'informe'}</span>
      </summary>
      <div className="wb-cmd-body">
        <p>{command.description}</p>
        {command.args.map((arg, index) => (
          <label key={arg.name} className="wb-field">
            {arg.name} — {arg.description}
            {arg.required ? ' (obligatorio)' : ''}
            <input type="text" value={args[index] ?? ''} onChange={(e) => setArgs((a) => a.map((v, i) => (i === index ? e.target.value : v)))} />
          </label>
        ))}
        {command.options.map((option) => (
          <label key={option.key} className="wb-field">
            {option.takesValue ? (
              <>
                {option.flags} — {option.description}
                <input type="text" value={String(options[option.key] ?? '')} placeholder={option.default === undefined ? '' : String(option.default)} onChange={(e) => setOptions((o) => ({ ...o, [option.key]: e.target.value }))} />
              </>
            ) : (
              <span>
                <input type="checkbox" checked={!!options[option.key]} onChange={(e) => setOptions((o) => ({ ...o, [option.key]: e.target.checked }))} /> {option.flags} — {option.description}
              </span>
            )}
          </label>
        ))}
        {convert && (
          <label className="wb-field">
            {command.inputDescription ?? 'Documento de origen (JSON)'}
            <textarea ref={sourceArea} value={source} spellCheck={false} onChange={(e) => setSource(e.target.value)} placeholder="Pega aquí el documento de origen" />
          </label>
        )}
        <div className="wb-row">
          <button type="button" className="primary" disabled={busy} onClick={run}>
            {convert ? 'Convertir' : 'Generar informe'}
          </button>
          {convert && (
            <FilePicker label="Abrir documento de origen…" accept=".json,application/json" onFile={async (file) => setSource(await readFile(file))} />
          )}
        </div>
        {error && (
          <div className="wb-note" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        {result?.warnings.map((w, i) => (
          <div key={i} className="wb-note" style={{ margin: 0 }}>
            {w}
          </div>
        ))}
        {result && (
          <>
            <pre className="wb-out" data-testid="command-output">
              {result.output}
            </pre>
            <div className="wb-row">
              <button type="button" onClick={async () => notify((await copyText(result.output)) ? 'Copiado' : 'No se pudo copiar')}>
                Copiar
              </button>
              {convert && (
                <button type="button" className="primary" onClick={() => controller.useDocumentText(result.output)}>
                  Usar como documento
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

export function ReportsPanel({ controller, state, notify }: PanelProps) {
  const commands = useMemo(() => (state.module ? commandInfos(state.module) : []), [state.module]);
  if (commands.length === 0) return <div className="wb-panel wb-empty">Este módulo no tiene informes.</div>;
  const reports = commands.filter((c) => c.kind === 'report');
  const converts = commands.filter((c) => c.kind === 'convert');
  return (
    <div className="wb-panel" role="tabpanel" aria-label="Informes">
      {state.analysis.status !== 'ok' && <div className="wb-note" style={{ margin: '0 0 10px' }}>Los informes leen el documento del editor: corrige sus problemas antes de generarlos.</div>}
      {reports.length > 0 && <h3 style={{ marginTop: 0 }}>Informes del documento</h3>}
      {reports.map((c) => (
        <CommandCard key={`${state.moduleId}:${c.name}`} controller={controller} command={c} notify={notify} />
      ))}
      {converts.length > 0 && <h3>Crear este documento a partir de otro módulo</h3>}
      {converts.map((c) => (
        <CommandCard key={`${state.moduleId}:${c.name}`} controller={controller} command={c} notify={notify} />
      ))}
    </div>
  );
}

// ───────────── Exportar ─────────────

export function ExportPanel({ controller, state, notify }: PanelProps) {
  const formats = useMemo(() => (state.module ? exportFormats(state.module) : []), [state.module]);
  const [preview, setPreview] = useState<ExportedFile | undefined>();
  const [error, setError] = useState<string | undefined>();
  const name = state.analysis.status === 'ok' ? (state.analysis.document as { workspace?: { name?: string } }).workspace?.name : undefined;
  const stem = `${fileStem(name, state.moduleId ?? 'documento')}${state.viewId && state.viewId !== state.choices.views[0]?.id ? `-${fileStem(state.viewId.replace(':', '-'), 'vista')}` : ''}`;

  const make = async (format: string): Promise<ExportedFile | undefined> => {
    setError(undefined);
    try {
      const file = await controller.exportAs(format);
      setPreview(file);
      return file;
    } catch (e) {
      setPreview(undefined);
      setError((e as Error).message);
      return undefined;
    }
  };

  return (
    <div className="wb-panel" role="tabpanel" aria-label="Exportar">
      <p>
        Se exporta la vista activa{state.viewId ? ` (${state.viewId})` : ''} en los formatos que la aceptan; JSON es el documento completo.
      </p>
      <div className="wb-formats">
        {formats.map((f) => (
          <div key={f.id} className="wb-row" data-format={f.id}>
            <strong style={{ minWidth: 90 }}>{f.label}</strong>
            <button type="button" onClick={() => make(f.id)}>
              Ver
            </button>
            <button
              type="button"
              onClick={async () => {
                const file = await make(f.id);
                if (file) downloadText(`${stem}${file.extension}`, file.data, file.mime);
              }}
            >
              Descargar {f.extension}
            </button>
            <button
              type="button"
              onClick={async () => {
                const file = await make(f.id);
                if (file) notify((await copyText(file.data)) ? `${f.label} copiado` : 'No se pudo copiar');
              }}
            >
              Copiar
            </button>
          </div>
        ))}
      </div>
      {error && (
        <div className="wb-note" role="alert" style={{ margin: '0 0 10px' }}>
          {error}
        </div>
      )}
      {preview?.format === 'mermaid' && (
        <>
          <h3>Dibujo de Mermaid</h3>
          <MermaidPreview text={preview.data} label={`Vista previa de Mermaid${state.viewId ? ` (${state.viewId})` : ''}`} />
        </>
      )}
      {preview && (
        <pre className="wb-out" data-testid="export-preview" data-format={preview.format}>
          {preview.data.length > 20000 ? `${preview.data.slice(0, 20000)}\n… (${preview.data.length} caracteres en total; descarga el archivo para verlo completo)` : preview.data}
        </pre>
      )}
    </div>
  );
}

// ───────────── Importar ─────────────

export function ImportPanel({ controller, state, notify }: PanelProps) {
  const importers = state.module?.importers ?? [];
  const [importer, setImporter] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  // Varios archivos elegidos a la vez (los .tf de un stack): se importan juntos mientras el texto no se edite a mano.
  const [files, setFiles] = useState<SourceFile[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Los avisos viven en el controlador (no aquí): así se ven también tras «Abrir archivo…» del encabezado y al volver a esta pestaña.
  const lastImport = state.lastImport;
  const warnings = lastImport?.warnings ?? [];
  const textArea = useRef<HTMLTextAreaElement>(null);
  useBulkInsert(textArea, setText);

  // Si el texto parece Mermaid se dibuja debajo, para comprobar que es lo que se quiere importar (la librería se descarga la primera vez).
  const isMermaid = useMemo(() => text.trim().length > 0 && looksLikeMermaid(text) && importers.some((i) => i.id === 'mermaid'), [text, importers]);

  if (importers.length === 0) return <div className="wb-panel wb-empty">Este módulo no importa otros formatos.</div>;

  /** Un archivo se carga como siempre; varios (si son todos del mismo formato y de uno que se reparte en varios) se juntan en el cuadro y se importan como uno. */
  const openFiles = async (picked: File[]) => {
    if (picked.length === 1) {
      setFileName(picked[0].name);
      setFiles(undefined);
      setText(await readFile(picked[0]));
      return;
    }
    const names = picked.map((f) => f.name);
    if (!state.module || !multiFileImporter(state.module, names, importer || undefined)) {
      setError(state.module ? whyNotMultiFile(state.module, names, importer || undefined) : 'No hay ningún módulo activo.');
      return;
    }
    setError(undefined);
    const read = await Promise.all(picked.map(async (f) => ({ name: f.name, text: await readFile(f) })));
    const joined = joinSourceFiles(read);
    setFileName(undefined);
    setFiles(joined.extra.files);
    setText(joined.text);
  };

  const run = async () => {
    setError(undefined);
    try {
      const auto = !importer && fileName ? state.module?.importers.find((i) => i.extensions.some((ext) => fileName.toLowerCase().endsWith(ext)))?.id : undefined;
      const result = files ? await controller.importFiles(files, importer || undefined) : await controller.importFrom(text, importer || auto, { file: fileName });
      notify(`Importado desde ${result.importer}${result.warnings.length ? ` con ${result.warnings.length} avisos` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="wb-panel" role="tabpanel" aria-label="Importar">
      <p>Convierte a un documento de este módulo un texto en otro formato. Sustituye el contenido del editor.</p>
      <div className="wb-cmd-body" style={{ padding: 0 }}>
        <label className="wb-field">
          Formato
          <select value={importer} onChange={(e) => setImporter(e.target.value)} aria-label="Formato de importación">
            <option value="">Reconocer por el contenido o la extensión</option>
            {importers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label} ({i.extensions.join(', ')})
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          Texto a importar
          <textarea
            ref={textArea}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setFiles(undefined); // editado a mano: ya no es la unión de los archivos elegidos
            }}
            placeholder="Pega aquí el texto (p. ej. un flowchart de Mermaid)"
            aria-label="Texto a importar"
          />
        </label>
        {isMermaid && (
          <details className="wb-import-preview" open data-testid="import-mermaid">
            <summary>Cómo dibuja Mermaid lo que vas a importar</summary>
            <MermaidPreview text={text} label="Vista previa de Mermaid del texto a importar" />
          </details>
        )}
        <div className="wb-row">
          <FilePicker label="Abrir archivo a importar…" onFiles={(picked) => void openFiles(picked)} />
          <button type="button" className="primary" disabled={!text.trim()} onClick={run}>
            Importar
          </button>
        </div>
        {files && (
          <div className="wb-note" style={{ margin: 0 }} data-testid="import-files">
            <strong>{files.length} archivos se importan juntos</strong> (en orden alfabético): {files.map((f) => f.name).join(', ')}.
          </div>
        )}
        {error && (
          <div className="wb-note" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        {lastImport && warnings.length > 0 && (
          <div className="wb-note" style={{ margin: 0 }} data-testid="import-warnings">
            <strong>{warnings.length === 1 ? 'Aviso de la importación:' : `${warnings.length} avisos de la importación:`}</strong>
            <div style={{ fontSize: 12 }}>
              Origen: {lastImport.importer}
              {lastImport.file ? ` · ${lastImport.file}` : ''}
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
