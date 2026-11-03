import { createDefaultRegistry } from '../../src/cli/registry';
import { createSuiteServer } from '../../src/cli/serve';
import { parseFrameAncestors } from '../../src/cli/securityHeaders';

const argv = process.argv.slice(2);
let staticDir = 'dist/app';
let frameArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === '--frame-ancestors' && argv[i + 1]) frameArg = argv[++i];
  else if (!arg.startsWith('-')) staticDir = arg;
}
const frameAncestors = parseFrameAncestors(frameArg ?? process.env.IARK_FRAME_ANCESTORS);
const host = '127.0.0.1';
const server = createSuiteServer({ registry: createDefaultRegistry(), version: '0.0.0-test', staticDir, frameAncestors });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, resolve);
});
const port = (server.address() as { port: number }).port;
process.stderr.write(`escuchando en http://${host}:${port} (sitio: ${staticDir})\n`);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
