import { describe, expect, it } from 'vitest';
import { defaultServerUrl } from './defaultServer';

describe('servidor propuesto por omisión (VITE_IARK_SERVER)', () => {
  it('acepta https y normaliza la dirección (sin barra final)', () => {
    expect(defaultServerUrl('https://iark-api.onrender.com')).toBe('https://iark-api.onrender.com');
    expect(defaultServerUrl('  https://iark-api.onrender.com/  ')).toBe('https://iark-api.onrender.com');
  });

  it('acepta http solo en la propia máquina', () => {
    expect(defaultServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(defaultServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(defaultServerUrl('http://iark.example.com')).toBeUndefined();
  });

  it('ignora en silencio lo vacío, lo mal escrito y lo que lleva credenciales', () => {
    for (const bad of [undefined, '', '   ', 'iark-api.onrender.com', 'ftp://iark.example.com', 'https://usuario:clave@iark.example.com', 'javascript:alert(1)', 'https://']) {
      expect(defaultServerUrl(bad), String(bad)).toBeUndefined();
    }
  });
});
