import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';

function docker(argv: string[], timeout = 6000): string {
  return execFileSync('docker', argv, { timeout, maxBuffer: 8 * 1024 * 1024 }).toString();
}

// Docker health at a glance — is the daemon up, what's running, what's broken.
registerTool({
  name: 'docker_doctor',
  description: 'Check Docker health: whether the daemon is up, which containers are running, and any exited or unhealthy ones. Use when Mikkel asks about Docker or why a container is not working.',
  params: {},
  async run() {
    // Is Docker installed / the daemon reachable?
    try {
      docker(['info', '--format', '{{.ServerVersion}}']);
    } catch (e) {
      const msg = String(e);
      if (/ENOENT|not recognized|not found/i.test(msg)) {
        return { error: 'docker command not found — is Docker installed and on PATH?' };
      }
      return { error: 'Docker daemon not reachable — is Docker Desktop / the engine running?', detail: msg.slice(0, 200) };
    }

    const parseLines = (out: string) =>
      out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        try { return JSON.parse(l) as Record<string, string>; } catch { return null; }
      }).filter((x): x is Record<string, string> => x !== null);

    let all: Record<string, string>[] = [];
    try {
      // --format json emits one JSON object per line.
      all = parseLines(docker(['ps', '-a', '--no-trunc', '--format', 'json']));
    } catch (e) {
      return { error: 'could not list containers', detail: String(e).slice(0, 200) };
    }

    const summarize = (c: Record<string, string>) => ({
      name: c.Names ?? '',
      image: c.Image ?? '',
      state: c.State ?? '',
      status: c.Status ?? '',
    });

    const running = all.filter((c) => (c.State ?? '').toLowerCase() === 'running');
    const exited = all.filter((c) => (c.State ?? '').toLowerCase() === 'exited');
    const unhealthy = all.filter((c) => /unhealthy/i.test(c.Status ?? ''));

    return {
      daemon: 'up',
      totalContainers: all.length,
      runningCount: running.length,
      running: running.slice(0, 30).map(summarize),
      exitedCount: exited.length,
      exited: exited.slice(0, 20).map(summarize),
      unhealthyCount: unhealthy.length,
      unhealthy: unhealthy.slice(0, 20).map(summarize),
    };
  },
});
