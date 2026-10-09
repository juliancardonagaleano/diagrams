/**
 * Conserva las referencias entre módulos (`ref: "urn:iark:<módulo>:<id>"`) al refinar un documento con IA. El modelo no
 * conoce las URN de otros documentos y las especificaciones de generación no las incluyen; sin esto, refinar un documento
 * perdería los enlaces de trazabilidad. Los elementos se casan por su colección (la ruta de propiedades hasta ellos) y su
 * `id`, y solo se rellena `ref` en los que no lo traen. El `refType` (el tipo del enlace) viaja con su `ref`.
 */
export function carryRefs<T>(base: unknown, generated: T): T {
  const refs = new Map<string, { ref: string; refType?: string }>();
  const walk = (value: unknown, path: string, visit: (record: Record<string, unknown>, key: string) => void): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string') visit(record, `${path}#${record.id}`);
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`, visit);
    }
  };
  walk(base, '', (record, key) => {
    if (typeof record.ref === 'string') refs.set(key, { ref: record.ref, ...(typeof record.refType === 'string' ? { refType: record.refType } : {}) });
  });
  if (refs.size === 0) return generated;

  const result = structuredClone(generated);
  walk(result, '', (record, key) => {
    const carried = refs.get(key);
    if (record.ref !== undefined || !carried) return;
    record.ref = carried.ref;
    if (carried.refType !== undefined && record.refType === undefined) record.refType = carried.refType;
  });
  return result;
}
