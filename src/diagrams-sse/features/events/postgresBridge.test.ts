import { describe, expect, it } from 'vitest';
import { parseProjectChange, serializeProjectChange } from './postgresBridge';

describe('postgresBridge', () => {
  it('serializa y parsea un aviso de cambio', () => {
    const text = serializeProjectChange({ type: 'project.created', project: 'tienda', updatedAt: '2020-01-01T00:00:00.000Z', by: '@ana' }, { alsoUsers: ['u1'] });
    expect(parseProjectChange(text)).toEqual({
      event: { type: 'project.created', project: 'tienda', updatedAt: '2020-01-01T00:00:00.000Z', by: '@ana' },
      options: { alsoUsers: ['u1'] },
    });
  });

  it('rechaza JSON inválido', () => {
    expect(parseProjectChange('not json')).toBeUndefined();
    expect(parseProjectChange('{}')).toBeUndefined();
  });
});
