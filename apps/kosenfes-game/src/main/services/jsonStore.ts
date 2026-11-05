import { atomicWriteFile, readTextFileLimited } from '@autobeats/chart-format/node';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ZodType } from 'zod';

const MAX_JSON_BYTES = 20 * 1024 * 1024;

export interface JsonReadResult<T> {
  value: T;
  /** 壊れていて既定値へ戻した場合の日本語メッセージ */
  recovered?: string;
}

/**
 * zod で検証しながら JSON を読む。
 * 壊れている場合は `.corrupt-<ts>` へ退避して既定値を返す（クラッシュしない）。
 */
export async function readJsonFile<T>(filePath: string, schema: ZodType<T>, fallback: () => T): Promise<JsonReadResult<T>> {
  let text: string;
  try {
    text = await readTextFileLimited(filePath, MAX_JSON_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { value: fallback() };
    return { value: fallback(), recovered: `${path.basename(filePath)} を読み取れませんでした: ${(err as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    await quarantine(filePath);
    return { value: fallback(), recovered: `${path.basename(filePath)} が壊れていたため初期化しました（退避コピーを保存）。` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    await quarantine(filePath);
    return { value: fallback(), recovered: `${path.basename(filePath)} の形式が不正だったため初期化しました（退避コピーを保存）。` };
  }
  return { value: parsed.data };
}

async function quarantine(filePath: string): Promise<void> {
  const target = `${filePath}.corrupt-${Date.now()}`;
  await fsp.copyFile(filePath, target).catch(() => undefined);
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2) + '\n');
}
