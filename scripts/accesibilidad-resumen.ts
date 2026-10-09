import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resume el informe de la auditoría de accesibilidad (`A11Y_MODO=informe npx playwright test tests/e2e/accesibilidad.spec.ts`):
 * cuántas violaciones hay por impacto y por regla, y en cuántas superficies aparece cada una.
 *
 * Uso: `npx tsx scripts/accesibilidad-resumen.ts [carpeta]` (por omisión `test-results/a11y`).
 * Una «violación» es una regla incumplida en una superficie y tema concretos; los «nodos» son los elementos afectados.
 */
interface Hallazgo {
  superficie: string;
  tema: string;
  regla: string;
  impacto: string;
  ayuda: string;
  nodos: number;
  objetivos: string[];
}

const carpeta = process.argv[2] ?? 'test-results/a11y';
const archivos = readdirSync(carpeta).filter((f) => f.endsWith('.json'));
const hallazgos = archivos.flatMap((f) => JSON.parse(readFileSync(join(carpeta, f), 'utf8')) as Hallazgo[]);
const ORDEN = ['critical', 'serious', 'moderate', 'minor'];

console.log(`${archivos.length} superficies auditadas (por tema), ${hallazgos.length} violaciones (regla × superficie × tema).`);
console.log('\nPor impacto (violaciones / nodos afectados):');
for (const impacto of ORDEN) {
  const delImpacto = hallazgos.filter((h) => h.impacto === impacto);
  console.log(`  ${impacto.padEnd(9)} ${String(delImpacto.length).padStart(4)} / ${delImpacto.reduce((n, h) => n + h.nodos, 0)}`);
}

console.log('\nPor regla (impacto · regla · superficies · nodos · ayuda):');
const porRegla = new Map<string, { impacto: string; superficies: Set<string>; nodos: number; ayuda: string; ejemplo: string }>();
for (const h of hallazgos) {
  const actual = porRegla.get(h.regla) ?? { impacto: h.impacto, superficies: new Set<string>(), nodos: 0, ayuda: h.ayuda, ejemplo: h.objetivos[0] ?? '' };
  actual.superficies.add(`${h.tema}:${h.superficie}`);
  actual.nodos += h.nodos;
  porRegla.set(h.regla, actual);
}
const filas = [...porRegla.entries()].sort((a, b) => ORDEN.indexOf(a[1].impacto) - ORDEN.indexOf(b[1].impacto) || b[1].nodos - a[1].nodos);
for (const [regla, r] of filas) console.log(`  ${r.impacto.padEnd(9)} ${regla.padEnd(34)} ${String(r.superficies.size).padStart(3)} sup. ${String(r.nodos).padStart(5)} nodos · ${r.ayuda}\n            p. ej. ${r.ejemplo}`);

if (process.argv.includes('--superficies')) {
  console.log('\nPor superficie:');
  for (const f of archivos.sort()) {
    const delArchivo = JSON.parse(readFileSync(join(carpeta, f), 'utf8')) as Hallazgo[];
    console.log(`  ${f}: ${delArchivo.map((h) => `${h.regla}(${h.nodos})`).join(', ') || 'sin violaciones'}`);
  }
}
