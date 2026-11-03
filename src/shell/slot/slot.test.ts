import { describe, expect, it } from 'vitest';
import type { ModuleSlotHost, ProjectSlotContext } from './types';

describe('contrato del slot (spec 007)', () => {
  it('el host entrega contexto de proyecto', () => {
    const context: ProjectSlotContext = { moduleId: 'data', projectId: 'p1', diagramId: 'd1' };
    const host: ModuleSlotHost = { getContext: () => context, onDocumentChange: (t) => expect(t).toBe('{}') };
    host.onDocumentChange?.('{}');
    expect(host.getContext()).toEqual(context);
  });
});
