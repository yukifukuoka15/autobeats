import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const python = process.env.AUTOBEATS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, [fileURLToPath(new URL('./build-youtube-runtime.py', import.meta.url))], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
