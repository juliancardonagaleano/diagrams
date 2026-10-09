import { Modal } from '@douyinfe/semi-ui';
import { useMemo, useState } from 'react';
import { toMermaid, type MermaidFormat } from '@core/export/mermaid/toMermaid';
import { MermaidPreview } from '../../../mermaid-preview/MermaidPreview';
import { useDocumentStore } from '../../store/documentStore';

const FORMATS: Array<{ value: MermaidFormat; label: string }> = [
  { value: 'c4', label: 'C4 nativo' },
  { value: 'flowchart', label: 'Diagrama de flujo' },
];

/** Vista previa de la vista activa como la dibuja Mermaid (sin salir de la aplicación), con el texto que se exportaría. */
export function MermaidPreviewModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const [format, setFormat] = useState<MermaidFormat>('c4');

  const source = useMemo(() => {
    if (!visible) return undefined;
    try {
      return { text: toMermaid(doc, { viewId: activeViewId ?? undefined, format }) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [visible, doc, activeViewId, format]);

  return (
    <Modal title="Vista previa de Mermaid" visible={visible} onCancel={onClose} footer={null} width={900} bodyStyle={{ maxHeight: '75vh', overflow: 'auto' }}>
      <div className="space-y-3 text-sm">
        <p className="text-color-2">
          Así dibuja Mermaid la vista activa. Es una aproximación para pegar en un README, GitHub o Confluence; el diagrama definitivo es el del editor.
        </p>
        <div className="flex gap-2" role="group" aria-label="Formato de Mermaid">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`px-3 py-1 rounded border border-color ${format === f.value ? 'font-semibold' : ''}`}
              aria-pressed={format === f.value}
              onClick={() => setFormat(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {source?.error && (
          <p role="alert" className="text-color-2">
            {source.error}
          </p>
        )}
        {source?.text !== undefined && (
          <>
            <MermaidPreview text={source.text} label={`Vista previa de Mermaid (${format === 'c4' ? 'C4 nativo' : 'diagrama de flujo'})`} />
            <details>
              <summary className="cursor-pointer">Texto de Mermaid</summary>
              <pre tabIndex={0} role="region" aria-label="Texto de Mermaid" className="mt-2 p-2 overflow-auto border border-color rounded text-xs" data-testid="mermaid-source">
                {source.text}
              </pre>
            </details>
          </>
        )}
      </div>
    </Modal>
  );
}
