import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * main / preload / renderer をすべて単一バンドルにする。
 * ワークスペースパッケージ（@autobeats/*）と zod はバンドルに含め、
 * パッケージ後に node_modules を同梱しなくても動くようにする。
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
    resolve: { alias: { '@main': resolve(__dirname, 'src/main') } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
    worker: { format: 'es' },
  },
});
