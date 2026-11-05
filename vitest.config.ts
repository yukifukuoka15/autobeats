import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'chart-format', root: 'packages/chart-format', include: ['test/**/*.test.ts'], environment: 'node' },
      },
      {
        test: { name: 'audio-analysis', root: 'packages/audio-analysis', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 60000 },
      },
      {
        test: { name: 'chart-editor', root: 'apps/chart-editor', include: ['test/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        test: { name: 'kosenfes-game', root: 'apps/kosenfes-game', include: ['test/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'integration',
          root: '.',
          include: ['test/integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120000,
        },
      },
    ],
  },
});
