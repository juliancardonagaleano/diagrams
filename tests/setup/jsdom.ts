import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sin `test.globals: true`, Testing Library no detecta el framework y no limpia el DOM montado
// entre pruebas: sin esto, el render de una prueba sigue visible (y las consultas por texto
// empiezan a devolver varias coincidencias) en la siguiente. No-op si la prueba no usa RTL.
afterEach(() => cleanup());

// Setup para pruebas con `// @vitest-environment jsdom`. Semi UI usa `ResizeObserver` (que jsdom
// no implementa) para varios componentes (Input, Select…) y `lottie-web` para algunos iconos
// animados, que en cuanto se importa intenta dibujar en un <canvas>; jsdom no implementa
// getContext() (requeriría el paquete nativo `canvas`). Se sustituyen por versiones mínimas que
// no fallan, sin depender de esos paquetes nativos.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Polyfill mínimo, solo para pruebas.
  window.ResizeObserver = NoopResizeObserver;
}

if (typeof HTMLCanvasElement !== 'undefined') {
  // Contexto simplificado, solo para que no lance en pruebas (por eso el molde: no es un CanvasRenderingContext2D completo).
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
    putImageData: () => {},
    getImageData: () => ({ data: [] }),
    createImageData: () => [],
    setTransform: () => {},
    measureText: () => ({ width: 0 }),
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {},
    stroke: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// El idioma de la interfaz sale de `?lang=`, de lo guardado y del navegador (ver `src/i18n`). jsdom se presenta como `en-US`, y las pruebas escriben
// los textos en español (el idioma por omisión de IArk): se fija el navegador de las pruebas en español. Las pruebas de i18n lo cambian a propósito.
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'language', { value: 'es-ES', configurable: true });
  Object.defineProperty(navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
}
