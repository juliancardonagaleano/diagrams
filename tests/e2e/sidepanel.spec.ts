import { test, expect } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';

test('cambiar el tipo de un elemento a uno cuyo padre actual ya no es válido limpia el padre', async ({ page }) => {
  await openEditor(page);

  // "Base de datos" es un container hoja con padre "Sistema de banca en línea" (softwareSystem); al
  // bajar a C2 y pasarlo a "Componente" (que exige un padre container), ese padre ya no es válido.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page, 'contenedores');
  await page.locator('.react-flow__node', { hasText: 'Base de datos' }).click();
  await expect(page.locator('.c4-card[data-element-id="db"].is-selected')).toHaveCount(1);

  const tipoField = page.locator('.c4-field', { has: page.locator('label', { hasText: 'Tipo' }) });
  await tipoField.getByRole('combobox').click();
  await page.getByRole('listbox').last().getByText('Componente', { exact: true }).click();

  const parentField = page.locator('.c4-field', { has: page.locator('label', { hasText: 'Pertenece a' }) });
  await expect(parentField.locator('.semi-select-selection-text')).toHaveText('Elige contenedor');
});

test('un elemento con hijos no permite cambiar su tipo (dejaría el documento inválido)', async ({ page }) => {
  await openEditor(page);

  // "Aplicación API" es padre de componentes: pasarla a otro tipo dejaría a sus hijos con un padre inválido.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page, 'contenedores');
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).click();
  await expect(page.locator('.c4-card[data-element-id="api"].is-selected')).toHaveCount(1);

  await expect(page.getByText(/Otros tipos no están disponibles/)).toBeVisible();
  const tipoField = page.locator('.c4-field', { has: page.locator('label', { hasText: 'Tipo' }) });
  await tipoField.getByRole('combobox').click();
  await expect(page.getByRole('listbox').last().getByRole('option', { name: 'Componente' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(tipoField.locator('.semi-select-selection-text')).toHaveText('Contenedor');
});

test('no se pueden crear relaciones duplicadas ni auto-referenciadas desde el panel', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('tab', { name: /Relaciones/ }).click();
  const before = await page.locator('[data-relationship-id]').count();

  const addButton = page.getByRole('button', { name: 'Añadir relación' });
  // Semi UI no usa el atributo `placeholder` real (lo renderiza como texto dentro del propio
  // combobox), así que se localizan por posición: el primero es "Origen", el segundo "Destino".
  // Los de Semi UI llevan `role="combobox"` explícito; el selector de idioma del encabezado (un `<select>` nativo) no cuenta.
  const origen = page.locator('[role="combobox"]:not([data-testid="lang-select"])').nth(0);
  const destino = page.locator('[role="combobox"]:not([data-testid="lang-select"])').nth(1);

  // Origen = destino: queda deshabilitado.
  await origen.click();
  await page.getByRole('listbox').last().getByText('Cliente personal', { exact: true }).click();
  await destino.click();
  await page.getByRole('listbox').last().getByText('Cliente personal', { exact: true }).click();
  await expect(addButton).toBeDisabled();
  await expect(page.getByText('Origen y destino no pueden ser el mismo elemento.')).toBeVisible();

  // Un par que ya tiene relación (Cliente personal → Sistema de banca en línea, r1 del ejemplo)
  // también queda deshabilitado.
  await destino.click();
  await page.getByRole('listbox').last().getByText('Sistema de banca en línea', { exact: true }).click();
  await expect(addButton).toBeDisabled();
  await expect(page.getByText('Ya existe una relación entre estos dos elementos.')).toBeVisible();
  expect(await page.locator('[data-relationship-id]').count()).toBe(before);

  // Un par nuevo sí se puede crear.
  await destino.click();
  await page.getByRole('listbox').last().getByText('Sistema de correo', { exact: true }).click();
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(page.locator('[data-relationship-id]')).toHaveCount(before + 1);
});
