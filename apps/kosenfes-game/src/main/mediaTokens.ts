import { randomBytes } from 'node:crypto';

/** トークン → ライブラリ内の絶対パス。renderer にはトークンだけを渡す */
export class MediaTokenRegistry {
  private readonly map = new Map<string, string>();

  register(absolutePath: string): string {
    for (const [t, p] of this.map) if (p === absolutePath) return t;
    const token = randomBytes(16).toString('hex');
    this.map.set(token, absolutePath);
    return token;
  }

  resolve(token: string): string | undefined {
    return /^[0-9a-f]{32}$/.test(token) ? this.map.get(token) : undefined;
  }

  revoke(token: string): void {
    this.map.delete(token);
  }
}
