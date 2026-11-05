import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PackageFs } from './package';

/** Node.js 用 PackageFs 実装 */
export const nodePackageFs: PackageFs = {
  realpath: (p) => fsp.realpath(p),
  async stat(p) {
    const s = await fsp.stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  },
  async readTextFile(p, maxBytes) {
    const s = await fsp.stat(p);
    if (s.size > maxBytes) throw new Error('too large');
    return fsp.readFile(p, 'utf8');
  },
  sha256File: (p) => sha256File(p),
  join: (...parts) => path.join(...parts),
  isInside: (parent, child) => isInsideDir(parent, child),
};

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Buffer(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 一時ファイルへ書いてから rename する atomic write。
 * 書き込み途中でクラッシュしても元ファイルが壊れない。
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** サイズ上限付きでテキストファイルを読む */
export async function readTextFileLimited(filePath: string, maxBytes: number): Promise<string> {
  const s = await fsp.stat(filePath);
  if (!s.isFile()) throw new Error('通常のファイルではありません');
  if (s.size > maxBytes) throw new Error(`ファイルが大きすぎます（${s.size} bytes）`);
  return fsp.readFile(filePath, 'utf8');
}

/** 同名ファイルがあるときに "name (2).ext" 形式で空き名を探す */
export async function findAvailablePath(desired: string): Promise<string> {
  const exists = async (p: string) => fsp.access(p).then(() => true, () => false);
  if (!(await exists(desired))) return desired;
  const dir = path.dirname(desired);
  const ext = path.extname(desired);
  const base = path.basename(desired, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('空きファイル名を確保できません');
}
