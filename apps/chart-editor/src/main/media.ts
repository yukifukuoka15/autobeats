import { net, protocol } from 'electron';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MEDIA_SCHEME = 'autobeats-media';

/** トークン → 検証済み絶対パス。renderer には絶対パスを渡さない */
const registry = new Map<string, string>();

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

export function registerAudioPath(absPath: string): string {
  for (const [token, p] of registry) if (p === absPath) return token;
  const token = randomBytes(16).toString('hex');
  registry.set(token, absPath);
  return token;
}

export function resolveAudioToken(token: string): string | null {
  return registry.get(token) ?? null;
}

export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'audio') return new Response('not found', { status: 404 });
      const token = url.pathname.replace(/^\//, '');
      const abs = registry.get(token);
      if (!abs) return new Response('not found', { status: 404 });
      // renderer は file:// オリジンなので CORS ヘッダーを付けて返す（配信対象はトークン登録済みファイルのみ）
      const res = await net.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
}
