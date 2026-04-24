import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  base: command === 'build' ? '/groovepede/' : '/',
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
}));
