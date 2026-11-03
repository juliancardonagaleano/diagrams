import { describe, expect, it } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { prepareSaveDiagram } from './saveDiagram';

describe('prepareSaveDiagram', () => {
  it('rechaza texto vacío', () => {
    expect(() => prepareSaveDiagram({ id: 'd1', text: '   ' })).toThrow(ProjectError);
  });

  it('conserva ifUpdatedAt y autor', () => {
    expect(prepareSaveDiagram({ id: 'd1', text: 'x', ifUpdatedAt: 't1', by: '@ana' })).toEqual({
      id: 'd1',
      text: 'x',
      ifUpdatedAt: 't1',
      by: '@ana',
    });
  });
});
