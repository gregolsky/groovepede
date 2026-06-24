import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(() => ({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '/',
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/index.html'),
        faq:  resolve(import.meta.dirname, 'src/faq.html'),
      },
    },
  },
}));
