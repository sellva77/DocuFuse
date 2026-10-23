import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import fs from 'node:fs';

const projectRoot = fs.existsSync(process.cwd()) ? fs.realpathSync.native(path.resolve(process.cwd())) : process.cwd();

export default defineConfig({
  root: projectRoot,
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/main.js',
        onstart(args) {
          args.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'pdf-parse'],
            },
          },
        },
      },
      {
        entry: 'src/preload/preload.js',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    watch: {
      ignored: ['**/release/**', '**/dist-electron/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
