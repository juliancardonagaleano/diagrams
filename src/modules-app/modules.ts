import type { ModuleSource } from './controller';

/**
 * Ejemplos del repositorio (`examples/*.json`), cargados bajo demanda: solo se descarga el de la especialidad que se abre.
 * C4 es una especialidad más: su lienzo es el común (`DomainModule.editor`, `packages/domain-c4/src/editor.ts`); el editor clásico (`index.html`) ya no se incrusta aquí.
 */
const examples = import.meta.glob('../../examples/*.json', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const example = (file: string): (() => Promise<string>) => {
  const loader = examples[`../../examples/${file}`];
  if (!loader) throw new Error(`Falta el ejemplo examples/${file}`);
  return loader;
};

/** Módulos que ofrece el banco de trabajo: un trozo de paquete por especialidad, que solo se descarga al abrirla. */
export const MODULE_SOURCES: ModuleSource[] = [
  {
    id: 'c4',
    label: 'C4',
    load: () => import('@iark/domain-c4').then((m) => m.c4Module),
    example: example('banca.json'),
    // Igual que «Nuevo diagrama» del editor: un documento vacío con la vista de contexto del sistema, para poder empezar a dibujar.
    blank: () =>
      import('@core/model/factories').then((m) => {
        const doc = m.createEmptyDocument();
        doc.views.push(m.createView('systemContext', { title: 'Contexto del sistema' }));
        return JSON.stringify(doc, null, 2);
      }),
  },
  { id: 'integration', label: 'Integración', load: () => import('@iark/domain-integration').then((m) => m.integrationModule), example: example('pedidos-integracion.json') },
  { id: 'data', label: 'Datos', load: () => import('@iark/domain-data').then((m) => m.dataModule), example: example('ventas-datos.json') },
  { id: 'enterprise', label: 'Empresarial', load: () => import('@iark/domain-enterprise').then((m) => m.enterpriseModule), example: example('empresa-arquitectura.json') },
  { id: 'platform', label: 'Plataforma', load: () => import('@iark/domain-platform').then((m) => m.platformModule), example: example('plataforma-ejemplo.json') },
  { id: 'security', label: 'Seguridad', load: () => import('@iark/domain-security').then((m) => m.securityModule), example: example('seguridad-ejemplo.json') },
];

/** Borradores en `localStorage`, por módulo. Falla en silencio donde no hay almacenamiento (ventana privada, iframe sin permiso…). */
export const localDrafts = {
  read(moduleId: string): string | null {
    try {
      return window.localStorage.getItem(`iark.workbench.${moduleId}`);
    } catch {
      return null;
    }
  },
  write(moduleId: string, text: string): void {
    try {
      window.localStorage.setItem(`iark.workbench.${moduleId}`, text);
    } catch {
      /* sin almacenamiento: el borrador no se conserva */
    }
  },
};
