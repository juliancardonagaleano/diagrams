/** Escenas estáticas del mockup. No son documentos reales: solo muestran cómo se reparte cada editor. */

export interface MockField {
  label: string;
  value: string;
}

export interface MockNode {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fields: MockField[];
}

export interface MockEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** Trazo punteado, como un evento o un mensaje asíncrono. */
  dashed?: boolean;
}

export interface MockScene {
  id: string;
  label: string;
  diagram: string;
  crumb: string;
  views: string[];
  nodes: MockNode[];
  edges: MockEdge[];
}

const field = (label: string, value: string): MockField => ({ label, value });

export const SCENES: MockScene[] = [
  {
    id: 'c4',
    label: 'C4',
    diagram: 'Banca en línea',
    crumb: 'C1 · Contexto',
    views: ['Contexto del sistema', 'Contenedores'],
    nodes: [
      { id: 'cliente', name: 'Cliente personal', kind: 'Persona', x: 8, y: 30, w: 18, h: 14, fields: [field('Nombre', 'Cliente personal'), field('Tipo', 'Persona'), field('Descripción', 'Usa la banca desde el navegador')] },
      { id: 'banca', name: 'Sistema de banca', kind: 'Sistema', x: 38, y: 24, w: 20, h: 16, fields: [field('Nombre', 'Sistema de banca'), field('Tipo', 'Sistema de software'), field('Tecnología', 'Java')] },
      { id: 'web', name: 'Aplicación web', kind: 'Contenedor', x: 62, y: 50, w: 20, h: 15, fields: [field('Nombre', 'Aplicación web'), field('Tipo', 'Contenedor'), field('Tecnología', 'React')] },
    ],
    edges: [{ id: 'e1', from: 'cliente', to: 'banca', label: 'Usa' }],
  },
  {
    id: 'integration',
    label: 'Integración',
    diagram: 'Pedidos',
    crumb: 'Contexto del dominio',
    views: ['Contexto', 'Secuencia'],
    nodes: [
      { id: 'pedidos', name: 'Pedidos', kind: 'Sistema', x: 10, y: 32, w: 18, h: 14, fields: [field('Nombre', 'Pedidos'), field('Tecnología', 'Java'), field('Patrón', 'API')] },
      { id: 'cola', name: 'Cola de eventos', kind: 'Canal', x: 38, y: 18, w: 22, h: 14, fields: [field('Nombre', 'Cola de eventos'), field('Protocolo', 'AMQP'), field('Patrón', 'Publicar / suscribir')] },
      { id: 'pasarela', name: 'Pasarela', kind: 'Sistema', x: 66, y: 46, w: 18, h: 14, fields: [field('Nombre', 'Pasarela'), field('Tecnología', 'Externa'), field('Protocolo', 'HTTPS')] },
    ],
    edges: [{ id: 'e1', from: 'pedidos', to: 'cola', label: 'evento', dashed: true }],
  },
  {
    id: 'data',
    label: 'Datos',
    diagram: 'Ventas',
    crumb: 'Modelo físico',
    views: ['Modelo físico', 'Linaje'],
    nodes: [
      { id: 'erp', name: 'ERP', kind: 'Fuente', x: 10, y: 28, w: 16, h: 14, fields: [field('Nombre', 'ERP'), field('Motor', 'PostgreSQL'), field('Clasificación', 'Interna')] },
      { id: 'tabla', name: 'pedidos', kind: 'Tabla', x: 38, y: 42, w: 18, h: 16, fields: [field('Nombre', 'pedidos'), field('Clasificación', 'Interna'), field('Columnas', 'id, total, fecha')] },
      { id: 'flujo', name: 'Ingesta', kind: 'Flujo', x: 66, y: 22, w: 18, h: 14, fields: [field('Nombre', 'Ingesta'), field('Herramienta', 'Airflow'), field('Frecuencia', 'Diaria')] },
    ],
    edges: [{ id: 'e1', from: 'erp', to: 'tabla', label: 'copia' }],
  },
  {
    id: 'enterprise',
    label: 'Empresarial',
    diagram: 'Tienda',
    crumb: 'Capacidades',
    views: ['Capacidades', 'Procesos'],
    nodes: [
      { id: 'ventas', name: 'Ventas', kind: 'Capacidad', x: 12, y: 22, w: 18, h: 14, fields: [field('Nombre', 'Ventas'), field('Tipo', 'Capacidad'), field('Dueño', 'Comercial')] },
      { id: 'pedido', name: 'Tomar pedido', kind: 'Proceso', x: 40, y: 44, w: 20, h: 14, fields: [field('Nombre', 'Tomar pedido'), field('Tipo', 'Proceso'), field('Dueño', 'Operaciones')] },
      { id: 'actor', name: 'Cliente', kind: 'Actor', x: 68, y: 24, w: 16, h: 14, fields: [field('Nombre', 'Cliente'), field('Tipo', 'Actor'), field('Dueño', 'Comercial')] },
    ],
    edges: [{ id: 'e1', from: 'actor', to: 'pedido', label: 'inicia' }],
  },
  {
    id: 'platform',
    label: 'Plataforma',
    diagram: 'Producción',
    crumb: 'Despliegue',
    views: ['Despliegue', 'Entornos'],
    nodes: [
      { id: 'cluster', name: 'Clúster', kind: 'Entorno', x: 12, y: 16, w: 70, h: 58, fields: [field('Nombre', 'Clúster'), field('Entorno', 'Producción'), field('Tecnología', 'Kubernetes')] },
      { id: 'svc', name: 'Servicio de pedidos', kind: 'Servicio', x: 18, y: 32, w: 24, h: 14, fields: [field('Nombre', 'Servicio de pedidos'), field('Entorno', 'Producción'), field('Tecnología', 'Java')] },
      { id: 'db', name: 'Base de pedidos', kind: 'Datos', x: 48, y: 48, w: 24, h: 14, fields: [field('Nombre', 'Base de pedidos'), field('Entorno', 'Producción'), field('Tecnología', 'PostgreSQL')] },
    ],
    edges: [{ id: 'e1', from: 'svc', to: 'db', label: 'lee' }],
  },
  {
    id: 'security',
    label: 'Seguridad',
    diagram: 'Amenazas de la cuenta',
    crumb: 'Diagrama de amenazas',
    views: ['Amenazas', 'Superficie'],
    nodes: [
      { id: 'borde', name: 'Internet', kind: 'Frontera', x: 10, y: 14, w: 72, h: 60, fields: [field('Nombre', 'Internet'), field('Tipo', 'Frontera'), field('Riesgo', 'Alto')] },
      { id: 'cuenta', name: 'Cuenta', kind: 'Activo', x: 18, y: 36, w: 20, h: 14, fields: [field('Nombre', 'Cuenta'), field('Tipo', 'Activo'), field('Clasificación', 'Confidencial')] },
      { id: 'amenaza', name: 'Suplantación', kind: 'Amenaza', x: 48, y: 26, w: 22, h: 14, fields: [field('Nombre', 'Suplantación'), field('Tipo', 'Amenaza'), field('Riesgo', 'Alto')] },
    ],
    edges: [{ id: 'e1', from: 'amenaza', to: 'cuenta', label: 'afecta' }],
  },
];

export function sceneById(id: string | null): MockScene {
  return SCENES.find((scene) => scene.id === id) ?? SCENES[0];
}
