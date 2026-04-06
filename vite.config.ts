import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

function getBuildVersionLabel(): string {
  try {
    const raw = readFileSync(join(root, 'build-version.json'), 'utf8');
    const { major, minor, build } = JSON.parse(raw) as {
      major?: number;
      minor?: number;
      build?: number;
    };
    if (
      typeof major !== 'number' ||
      typeof minor !== 'number' ||
      typeof build !== 'number'
    ) {
      return 'v?.?.?';
    }
    return `v${major}.${minor}.${build}`;
  } catch {
    return 'v?.?.?';
  }
}

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    assetsDir: '',
  },
  define: {
    __APP_VERSION__: JSON.stringify(getBuildVersionLabel()),
  },
  plugins: [
    {
      name: 'inject-build-version',
      transformIndexHtml(html) {
        return html.replace(/%BUILD_VERSION%/g, getBuildVersionLabel());
      },
    },
  ],
});

