import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSink, jsonLine, openLogSink, StreamSink } from './sink';

const folders: string[] = [];
const sinks: Array<{ close(): Promise<void> }> = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-sink-'));
  folders.push(dir);
  return dir;
};
afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('jsonLine: una línea es una línea', () => {
  it('escapa saltos de línea, comillas, controles y los separadores que algunos lectores toman por salto (U+0085, U+2028, U+2029)', () => {
    const hostile = 'a\nb\rc\u0085d\u2028e\u2029f"g\\h\0i\u001bj\t{"type":"audit"}';
    const line = jsonLine({ valor: hostile, anidado: { [hostile]: hostile } });
    expect(line).not.toMatch(/[\n\r\u0085\u2028\u2029\0\u001b\t]/);
    expect(JSON.parse(line)).toEqual({ valor: hostile, anidado: { [hostile]: hostile } });
    expect(line).toContain('\\u2028');
    expect(line).toContain('\\u0085');
  });

  it('mil textos al azar con caracteres de control nunca producen más de una línea ni cambian al volver a leerlos', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pool = ['\n', '\r', '\u0085', '\u2028', '\u2029', '"', '\\', '\0', '{', '}', ':', 'a', 'ñ', '😀', '\u001f', '\u007f', '\ud800'];
    for (let i = 0; i < 1000; i++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 30) }, () => pool[Math.floor(random() * pool.length)]).join('');
      const line = jsonLine({ text });
      expect(line).not.toMatch(/[\n\r\u0085\u2028\u2029]/);
      expect((JSON.parse(line) as { text: string }).text).toBe(JSON.parse(JSON.stringify({ text })).text);
    }
  });
});

describe('FileSink', () => {
  it('crea la carpeta (0700) y el archivo (0600), añade sin truncar y cada línea termina en salto', async () => {
    const dir = temp();
    const file = join(dir, 'logs', 'auditoria.jsonl');
    const first = new FileSink(file, { label: 'prueba', sync: true });
    first.open();
    sinks.push(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
    first.write('{"n":1}');
    first.write('{"n":2}');
    await first.close();
    const second = new FileSink(file, { label: 'prueba', sync: true });
    second.open();
    sinks.push(second);
    second.write('{"n":3}');
    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(second.stats).toEqual({ written: 1, dropped: 0, errors: 0 });
  });

  it('un archivo que ya existía con otro modo se corrige a 0600', () => {
    const file = join(temp(), 'viejo.jsonl');
    writeFileSync(file, 'previo\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const sink = new FileSink(file, { label: 'prueba', sync: true });
    sink.open();
    sinks.push(sink);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('previo\n');
  });

  it('con flujo (los accesos) escribe en orden y close() vacía lo pendiente', async () => {
    const file = join(temp(), 'accesos.jsonl');
    const sink = new FileSink(file, { label: 'prueba' });
    sink.open();
    for (let i = 0; i < 500; i++) sink.write(`{"n":${i}}`);
    await sink.close();
    expect(lines(file)).toEqual(Array.from({ length: 500 }, (_, i) => `{"n":${i}}`));
    expect(sink.stats.written).toBe(500);
  });

  it('reopen() tras rotar (logrotate: renombrar y avisar) sigue en un archivo nuevo en la ruta de siempre, sin perder ni duplicar líneas', async () => {
    const dir = temp();
    const file = join(dir, 'acceso.jsonl');
    for (const sync of [true, false]) {
      rmSync(file, { force: true });
      rmSync(`${file}.1`, { force: true });
      const sink = new FileSink(file, { label: 'prueba', sync });
      sink.open();
      sinks.push(sink);
      sink.write('{"antes":1}');
      renameSync(file, `${file}.1`);
      sink.write('{"antes":2}'); // todavía va al archivo renombrado: el descriptor es el mismo
      sink.reopen();
      sink.write('{"despues":1}');
      await sink.close();
      expect(lines(`${file}.1`)).toEqual(['{"antes":1}', '{"antes":2}']);
      expect(lines(file)).toEqual(['{"despues":1}']);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('open() falla con el error de Node si el archivo no se puede abrir (el arranque lo convierte en un error de uso)', () => {
    const dir = temp();
    writeFileSync(join(dir, 'archivo'), 'x');
    expect(() => new FileSink(join(dir, 'archivo', 'dentro.jsonl'), { label: 'prueba' }).open()).toThrowError(/ENOTDIR|EEXIST/);
    mkdirSync(join(dir, 'carpeta'));
    expect(() => new FileSink(join(dir, 'carpeta'), { label: 'prueba' }).open()).toThrowError(/EISDIR/);
  });

  it('si el archivo deja de poder escribirse: nunca lanza, avisa una sola vez, cuenta lo perdido y manda la línea a la salida de emergencia', () => {
    const dir = temp();
    const file = join(dir, 'a', 'auditoria.jsonl');
    const warnings: string[] = [];
    const emergency: string[] = [];
    let now = 1000;
    const sink = new FileSink(file, { label: 'registro de auditoría', sync: true, retryMs: 5000, now: () => now, warn: (m) => warnings.push(m), fallback: (l) => emergency.push(l) });
    sink.open();
    sinks.push(sink);
    sink.write('{"n":1}');
    // la carpeta desaparece y en su lugar queda un archivo: ni el descriptor viejo se puede reabrir ni la ruta crearse
    rmSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a'), 'ya no es una carpeta');
    sink.reopen();
    for (let i = 2; i <= 4; i++) expect(() => sink.write(`{"n":${i}}`)).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('registro de auditoría');
    expect(warnings[0]).toContain('van a stderr');
    expect(emergency).toEqual(['{"n":2}', '{"n":3}', '{"n":4}']);
    expect(sink.stats).toMatchObject({ written: 1, dropped: 3 });
    expect(sink.stats.errors).toBe(1);
    // pasado el plazo y arreglado el problema, vuelve a escribir y lo dice una vez
    rmSync(join(dir, 'a'));
    now += 5001;
    sink.write('{"n":5}');
    expect(lines(file)).toEqual(['{"n":5}']);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('vuelve a escribirse');
  });

  it('con flujo y el destino atascado descarta lo que pasaría del tope de memoria, lo cuenta y avisa una vez', () => {
    const sink = new StreamSink(new Writable({ highWaterMark: 16, write() {} }), { label: 'registro de accesos', maxBuffer: 100, warn: (m) => warnings.push(m) });
    const warnings: string[] = [];
    for (let i = 0; i < 1000; i++) sink.write('x'.repeat(40));
    expect(sink.stats.written).toBeLessThan(10);
    expect(sink.stats.dropped).toBeGreaterThan(990);
    expect(warnings).toHaveLength(1);
  });
});

describe('StreamSink', () => {
  it('un error del flujo (EPIPE: el lector de la tubería se fue) no mata el proceso: se cuenta, se avisa una vez y se sigue', () => {
    const warnings: string[] = [];
    const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const sink = new StreamSink(stream, { label: 'registro de accesos', warn: (m) => warnings.push(m) });
    sink.write('{"n":1}');
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EPIPE' }))).not.toThrow();
    sink.write('{"n":2}');
    stream.emit('error', new Error('otra vez'));
    expect(sink.stats).toMatchObject({ written: 1, dropped: 1, errors: 2 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EPIPE');
  });

  it('escribe cada línea con su salto y reopen()/close() no hacen nada (la salida estándar no es nuestra)', async () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done(); } });
    const sink = new StreamSink(stream, { label: 'prueba' });
    sink.write('{"a":1}');
    sink.reopen();
    await sink.close();
    sink.write('{"a":2}');
    expect(chunks.join('')).toBe('{"a":1}\n{"a":2}\n');
    expect(sink.target).toBe('stdout');
  });
});

describe('openLogSink', () => {
  it('`-` es la salida estándar; cualquier otra cosa, un archivo 0600 que ya existe al abrirlo', () => {
    const stdout = openLogSink('-', 'access');
    expect(stdout.target).toBe('stdout');
    const file = join(temp(), 'x', 'auditoria.jsonl');
    const sink = openLogSink(file, 'audit');
    sinks.push(sink);
    expect(existsSync(file)).toBe(true);
    expect(sink.target).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
