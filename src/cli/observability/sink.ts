import { closeSync, createWriteStream, fchmodSync, fstatSync, mkdirSync, openSync, writeSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';

/**
 * A dónde van las líneas de los registros de `iark serve` (el de accesos y el de auditoría): JSON por línea, a la salida estándar (`-`) o a un
 * archivo al que solo se añade. Un sitio con tres garantías que el servicio necesita:
 *
 *  - **Una línea es una línea.** `jsonLine` serializa con `JSON.stringify` (que escapa los saltos de línea, las comillas y los caracteres de
 *    control de cualquier texto) y además escapa U+0085, U+2028 y U+2029, que algunos lectores de registros toman por saltos de línea.
 *    Nadie que controle un valor (una cabecera, un nombre) puede fabricar una línea falsa ni un campo falso.
 *  - **Escribir no tumba el servicio.** `write` nunca lanza: un disco lleno o un archivo borrado se cuentan (`stats.errors`), avisan **una vez**
 *    por episodio por stderr y se reintentan cada pocos segundos; las líneas que no se pudieron escribir se cuentan (`stats.dropped`). Las
 *    métricas lo muestran, así que el fallo no se queda callado.
 *  - **Sin memoria sin fin.** Si el destino va más lento que las peticiones (una tubería saturada), las líneas que pasarían de `maxBuffer`
 *    se descartan y se cuentan en vez de acumularse.
 *
 * El archivo se crea con modo 0600 (y se corrige si ya existía con otro, siendo un archivo normal): trae nombres de usuario y direcciones.
 */

/** JSON de un registro en una sola línea, sin el salto final. */
export function jsonLine(record: unknown): string {
  return JSON.stringify(record).replace(/[\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface SinkStats {
  /** Líneas que se entregaron al destino. */
  written: number;
  /** Líneas que no se pudieron escribir o que se descartaron por ir el destino atrasado. */
  dropped: number;
  /** Fallos de escritura o de apertura. */
  errors: number;
}

export interface LogSink {
  /** Una línea ya serializada, sin salto final. Nunca lanza. */
  write(line: string): void;
  /** Vuelve a abrir el archivo (tras rotarlo con `logrotate` y `SIGHUP`). En la salida estándar no hace nada. Nunca lanza. */
  reopen(): void;
  /** Vacía lo pendiente y suelta el archivo. La salida estándar no se cierra. */
  close(): Promise<void>;
  readonly stats: SinkStats;
  /** Para anunciarlo al arrancar: `stdout` o la ruta del archivo. */
  readonly target: string;
}

export interface SinkOptions {
  /** Cómo se llama en los avisos: «registro de accesos», «registro de auditoría». */
  label: string;
  /** Dónde van los avisos (por omisión, stderr). */
  warn?: (message: string) => void;
  /** Bytes que pueden esperar sin escribirse antes de descartar líneas. Por omisión 1 MiB. */
  maxBuffer?: number;
}

export interface FileSinkOptions extends SinkOptions {
  /** Escribe cada línea al instante (`writeSync`) en vez de con un flujo. Para la auditoría: pocas líneas y ninguna debe quedarse en memoria. */
  sync?: boolean;
  /** Recibe la línea cuando no se pudo escribir en el archivo (la auditoría la manda a stderr para no perderla del todo). */
  fallback?: (line: string) => void;
  /** Espera entre reintentos tras un fallo (ms). Por omisión 5000. */
  retryMs?: number;
  /** El reloj en milisegundos (en las pruebas, uno falso). */
  now?: () => number;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const stderrWarn = (message: string): void => void process.stderr.write(`${message}\n`);
const errno = (error: unknown): string => (error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.message ?? 'error';

/** Un destino que ya es un flujo (la salida estándar, o uno de pruebas). No se cierra: no es nuestro. */
export class StreamSink implements LogSink {
  readonly stats: SinkStats = { written: 0, dropped: 0, errors: 0 };
  readonly target = 'stdout';
  private readonly warn: (message: string) => void;
  private readonly maxBuffer: number;
  private failing = false;

  constructor(
    private readonly stream: Writable,
    private readonly options: SinkOptions,
  ) {
    this.warn = options.warn ?? stderrWarn;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    // Sin este oyente, un EPIPE (el lector de la tubería se fue) sería una excepción sin capturar que mata el proceso.
    stream.on('error', (error) => {
      this.stats.errors += 1;
      if (!this.failing) {
        this.failing = true;
        this.warn(`aviso: no se puede escribir el ${options.label} en la salida estándar (${errno(error)}): se sigue sirviendo sin él.`);
      }
    });
  }

  write(line: string): void {
    if (this.failing || this.stream.writableLength > this.maxBuffer) {
      this.stats.dropped += 1;
      if (!this.failing && this.stats.dropped === 1) this.warn(`aviso: el ${this.options.label} va más lento que las peticiones: se descartan líneas hasta que alcance.`);
      return;
    }
    this.stream.write(`${line}\n`);
    this.stats.written += 1;
  }

  reopen(): void {}

  async close(): Promise<void> {}
}

/** Un archivo al que solo se añade. `open()` falla (con el error de Node) si no se puede abrir: así un servicio mal configurado no arranca. */
export class FileSink implements LogSink {
  readonly stats: SinkStats = { written: 0, dropped: 0, errors: 0 };
  private readonly warn: (message: string) => void;
  private readonly maxBuffer: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private fd: number | undefined;
  private stream: WriteStream | undefined;
  private failing = false;
  private nextTry = 0;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly options: FileSinkOptions,
  ) {
    this.warn = options.warn ?? stderrWarn;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.retryMs = options.retryMs ?? 5000;
    this.now = options.now ?? ((): number => Date.now());
  }

  get target(): string {
    return this.path;
  }

  /** Abre (o crea) el archivo con modo 0600. */
  open(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, 'a', 0o600);
    // Solo a un archivo normal se le toca el modo: `/dev/stdout`, una tubería o un terminal no son nuestros y no se les cambia el modo.
    if (process.platform !== 'win32' && fstatSync(fd).isFile()) {
      try {
        fchmodSync(fd, 0o600); // un archivo que ya existía puede tener otro modo
      } catch {
        // se avisa abajo si, aun así, otros usuarios pueden leerlo
      }
      const mode = fstatSync(fd).mode & 0o777;
      if (mode & 0o077) this.warn(`aviso: el ${this.options.label} (${this.path}) tiene modo ${mode.toString(8)} y no se pudo dejar en 600: lo pueden leer otros usuarios.`);
    }
    this.fd = fd;
    if (!this.options.sync) {
      const stream = createWriteStream(this.path, { fd, autoClose: true });
      stream.on('error', (error) => {
        if (this.stream === stream) this.fail(error);
      });
      this.stream = stream;
    }
  }

  write(line: string): void {
    if (this.closed) return;
    if (this.fd === undefined && !(this.now() >= this.nextTry && this.tryOpen())) {
      this.lose(line);
      return;
    }
    if (this.stream) {
      if (this.stream.writableLength > this.maxBuffer) {
        this.stats.dropped += 1;
        if (this.stats.dropped === 1) this.warn(`aviso: el ${this.options.label} va más lento que las peticiones: se descartan líneas hasta que alcance.`);
        return;
      }
      this.stream.write(`${line}\n`);
      this.stats.written += 1;
      return;
    }
    try {
      const data = Buffer.from(`${line}\n`, 'utf8');
      let done = 0;
      while (done < data.length) done += writeSync(this.fd!, data, done);
      this.stats.written += 1;
    } catch (error) {
      this.fail(error);
      this.lose(line);
    }
  }

  reopen(): void {
    if (this.closed) return;
    this.release();
    this.nextTry = 0;
    this.tryOpen();
  }

  async close(): Promise<void> {
    this.closed = true;
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      await new Promise<void>((resolve) => {
        if (stream.destroyed) return resolve();
        stream.once('close', () => resolve());
        stream.end();
      });
      this.fd = undefined;
      return;
    }
    this.release();
  }

  /** Una línea que no se pudo escribir: se cuenta y, si hay una salida de emergencia, va allí. */
  private lose(line: string): void {
    this.stats.dropped += 1;
    this.options.fallback?.(line);
  }

  private tryOpen(): boolean {
    try {
      this.open();
    } catch (error) {
      this.fail(error);
      return false;
    }
    if (this.failing) {
      this.failing = false;
      this.warn(`aviso: el ${this.options.label} (${this.path}) vuelve a escribirse.`);
    }
    return true;
  }

  private fail(error: unknown): void {
    this.stats.errors += 1;
    this.release();
    this.nextTry = this.now() + this.retryMs;
    if (!this.failing) {
      this.failing = true;
      this.warn(`aviso: no se puede escribir el ${this.options.label} (${this.path}: ${errno(error)}): el servicio sigue, pero esas líneas se pierden hasta que se pueda volver a escribir${this.options.fallback ? ' (van a stderr)' : ''}.`);
    }
  }

  /** Suelta el archivo actual sin esperar (para reabrir o tras un fallo). */
  private release(): void {
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      stream.removeAllListeners('error');
      stream.on('error', () => undefined);
      stream.end();
      this.fd = undefined;
      return;
    }
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // ya estaba cerrado
      }
      this.fd = undefined;
    }
  }
}

/**
 * Abre un destino de la línea de comandos: `-` es la salida estándar; cualquier otro valor, un archivo. Falla con el error de Node si el archivo
 * no se puede abrir. La auditoría escribe en el acto (`sync`) y manda a stderr lo que no pudo escribir; los accesos usan un flujo.
 */
export function openLogSink(target: string, kind: 'access' | 'audit', options: { warn?: (message: string) => void } = {}): LogSink {
  const label = kind === 'access' ? 'registro de accesos' : 'registro de auditoría';
  if (target === '-') return new StreamSink(process.stdout, { label, warn: options.warn });
  const sink = new FileSink(target, {
    label,
    warn: options.warn,
    sync: kind === 'audit',
    fallback: kind === 'audit' ? (line) => void process.stderr.write(`${line}\n`) : undefined,
  });
  sink.open();
  return sink;
}
