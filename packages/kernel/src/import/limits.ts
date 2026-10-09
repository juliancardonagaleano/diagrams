/**
 * Topes comunes de los importadores de formatos estructurados (JSON, YAML y XML). El servicio (`iark serve`) ejecuta `import`
 * sobre entrada no confiable, así que un importador nuevo no lee texto sin límite: comprueba el tamaño antes de analizarlo y la
 * profundidad y el número de nodos del árbol ya analizado antes de recorrerlo. Son los mismos para todos, de modo que un
 * archivo que un importador rechaza por «demasiado grande» lo rechazan igual los demás.
 *
 * Son un seguro contra entradas patológicas, no un límite de uso: un documento real (el OpenAPI de Stripe, un `manifest.json` de
 * dbt de un proyecto grande) queda muy por debajo. El cuerpo de una petición HTTP al servicio tiene además su propio tope (5 MB).
 */
export const IMPORT_LIMITS = Object.freeze({
  /** Caracteres de texto que se leen. */
  maxChars: 32 * 1024 * 1024,
  /** Niveles de anidamiento de un árbol analizado (objetos y listas dentro de objetos y listas). */
  maxDepth: 200,
  /** Nodos (valores) de un árbol analizado. */
  maxNodes: 2_000_000,
});

/** Número con punto de millar (`2.000.000`), igual en cualquier entorno (`toLocaleString` depende del ICU de Node). */
const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export interface TreeLimits {
  maxDepth?: number;
  maxNodes?: number;
}

/** Por qué un texto es demasiado grande para importarlo (en español), o `undefined` si cabe. */
export function textSizeProblem(text: string, label: string, maxChars: number = IMPORT_LIMITS.maxChars): string | undefined {
  return text.length > maxChars ? `${label} es demasiado grande (${count(text.length)} caracteres; el máximo que se importa es ${count(maxChars)}).` : undefined;
}

/**
 * Por qué un árbol analizado (JSON, YAML o la salida de un analizador de XML) es demasiado profundo o tiene demasiados nodos,
 * o `undefined` si cabe. Recorrido iterativo con pila propia: la comprobación no puede agotar la pila de llamadas con la misma
 * entrada que quiere rechazar. Un árbol con referencias circulares (que el JSON y el YAML no producen) cuenta como profundo.
 */
export function treeProblem(value: unknown, label: string, limits: TreeLimits = {}): string | undefined {
  const maxDepth = limits.maxDepth ?? IMPORT_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? IMPORT_LIMITS.maxNodes;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) return `${label} tiene demasiados nodos (más de ${count(maxNodes)}).`;
    if (current === null || typeof current !== 'object') continue;
    if (depth > maxDepth) return `${label} está anidado en más de ${maxDepth} niveles.`;
    const children = Array.isArray(current) ? current : Object.values(current as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return undefined;
}
