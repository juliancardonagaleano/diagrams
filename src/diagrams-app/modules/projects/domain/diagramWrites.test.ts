import { ProjectError } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { prepareCreateDiagram } from './diagramWrites';

describe('prepareCreateDiagram', () => {
  it('exige módulo y texto', () => {
    expect(() => prepareCreateDiagram({ module: '', text: 'x' })).toThrow(ProjectError);
    expect(() => prepareCreateDiagram({ module: 'c4', text: '   ' })).toThrow(ProjectError);
  });
});
