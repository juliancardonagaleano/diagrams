import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/model/issues';
import { validateDocument } from '@core/model/schema';

function loadModel(path: string) {
  const result = validateDocument(JSON.parse(readFileSync(path, 'utf8')));
  if (!result.ok) {
    expect(result.ok, `${path} no cumple el esquema C4`).toBe(true);
    throw new Error(`${path}: esquema inválido`);
  }
  return result.document;
}

describe('modelos C4 de arquitectura en examples/', () => {
  it('diagrams-as-is.json permanece congelado y válido', () => {
    const doc = loadModel('examples/diagrams-as-is.json');
    const issues = analyzeDocument(doc);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(0);
    expect(doc.model.elements).toHaveLength(59);
    expect(doc.model.relationships).toHaveLength(112);
    expect(doc.views).toHaveLength(7);
  });

  it('diagrams-to-be.json (spec 001) permanece válido', () => {
    const doc = loadModel('examples/diagrams-to-be.json');
    const issues = analyzeDocument(doc);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(1);
    expect(doc.model.elements).toHaveLength(71);
    expect(doc.model.relationships).toHaveLength(133);
    expect(doc.views).toHaveLength(10);
  });
});
