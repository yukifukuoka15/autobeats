import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export function youtubeUrl(text: string): string {
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0].replace(/[).,、。]+$/, ''));
      if (hosts.has(url.hostname) && !url.username && !url.password && !url.port) return url.href;
    } catch { /* 次の URL を調べる */ }
  }
  throw new Error('YouTube の URL を入力してください。');
}

export async function downloadYoutube(text: string, scriptDir: string, outputDir: string, runtimeDir?: string): Promise<string> {
  const url = youtubeUrl(text);
  const script = path.join(scriptDir, 'import_audio.py');
  const binary = runtimeDir ? path.join(runtimeDir, process.platform === 'win32' ? 'import_audio.exe' : 'import_audio') : undefined;
  if (binary && !existsSync(binary)) throw new Error('YouTube用ランタイムが見つかりません。最新版を再インストールしてください。');
  const command = binary || process.env.AUTOBEATS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const args = binary ? [url, outputDir] : [script, url, outputDir];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, args,
      { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(error.killed ? '取得がタイムアウトしました。再試行してください。' : `YouTube から取得できません。ネット接続と動画の公開状態を確認してください。\n${stderr.slice(-1500) || error.message}`));
        else resolve(stdout);
      });
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}') as { file?: string };
  if (!result.file || path.basename(result.file) !== result.file || !result.file.endsWith('.mp3')) throw new Error('取得した音声の情報が不正です。');
  const file = path.join(outputDir, result.file);
  if (!(await fs.stat(file)).isFile()) throw new Error('音声ファイルが見つかりません。');
  return file;
}
