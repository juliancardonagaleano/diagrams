import type { TraceRemoteModule } from '../contract';

const remote: TraceRemoteModule = {
  routes: { remoteId: 'mfe-trace', shellMountPath: '/trace' },
  async mount() {
    document.title = 'DIAgrams · Trazabilidad';
    const root = document.getElementById('root');
    if (root) {
      const shell = await import('../../trace-app/shell.html?raw');
      root.outerHTML = shell.default;
    }
    await import('../../trace-app/main.ts');
    return { unmount: () => undefined };
  },
};

export default remote;
