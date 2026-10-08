import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Frame, type Page } from '@playwright/test';

/**
 * Espera a que el lienzo de módulos esté asentado: ELK ha colocado la estructura actual y la cámara ha terminado de
 * encuadrarla (`data-layout="ready"` en `module-canvas`). Antes de eso los nodos ya están en el DOM, pero en posiciones
 * provisionales que se desplazan cuando llega el autolayout y se anima el encuadre, de modo que un clic o una medida
 * hechos en ese intervalo caen donde ya no está el elemento. Con `view` espera además a que sea esa la vista activa
 * (al cambiar de vista el atributo pasa a «pending» en el mismo render que cambia `data-view`).
 */
export async function canvasReady(page: Page, view?: string): Promise<void> {
  const canvas = page.getByTestId('module-canvas');
  if (view !== undefined) await expect(canvas).toHaveAttribute('data-view', view);
  await expect(canvas).toHaveAttribute('data-layout', 'ready', { timeout: 20000 });
}

/** Cambia de vista (o de variante) con el selector del lienzo y espera a que la nueva vista esté colocada y encuadrada. */
export async function selectView(page: Page, view: string, selector: 'canvas-view' | 'canvas-variant' = 'canvas-view'): Promise<void> {
  await page.getByTestId(selector).selectOption(view);
  await canvasReady(page, view);
}

/**
 * Espera a que el lienzo del editor C4 (`index.html`, `c4-canvas`) esté asentado: la vista activa tiene todos sus nodos
 * colocados por ELK, React Flow ya los dibuja y la cámara ha terminado de encuadrar (`data-layout="ready"`). Antes de eso
 * puede haber nodos sin dibujar (el editor no pinta los que aún no tienen posición) o una cámara animándose, y un clic o una
 * medida hechos en ese intervalo caen donde ya no está el elemento. Pasa a «pending» en el mismo render en que se
 * cambia de vista, se añade un elemento sin posición o se pulsa Autolayout, así que basta llamarla justo después de la
 * acción. Con `view` espera además a que sea esa la vista activa. Con un `Frame` sirve para el editor embebido.
 */
export async function c4Ready(page: Page | Frame, view?: string): Promise<void> {
  const canvas = page.getByTestId('c4-canvas');
  if (view !== undefined) await expect(canvas).toHaveAttribute('data-view', view);
  await expect(canvas).toHaveAttribute('data-layout', 'ready', { timeout: 20000 });
}

/**
 * Abre el editor C4 y espera a que la primera vista esté colocada y encuadrada. No usa `networkidle`: en una carga
 * lenta puede darse por alcanzado antes de que ELK termine, y con iframes (modo embebido) a veces ni llega.
 */
export async function openEditor(page: Page, url = '/'): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await c4Ready(page);
}

/** Recarga el editor C4 y espera a que vuelva a estar asentado. */
export async function reloadEditor(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await c4Ready(page);
}

/**
 * Captura de documentación: se guarda en la carpeta compartida del proyecto (`/mnt/project-files/...`) solo si esa
 * carpeta existe. En el contenedor de desarrollo existe; en un runner de CI no, y allí la captura se omite en vez de
 * hacer fallar la prueba con ENOENT.
 */
export async function docShot(page: Page, file: string): Promise<void> {
  if (!existsSync(dirname(file))) return;
  await page.screenshot({ path: file });
}
