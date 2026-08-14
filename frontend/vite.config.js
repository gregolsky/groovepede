import { defineConfig } from 'vite';
import { resolve } from 'path';

// Swap → optional: prevents font-swap CLS on large lists. The SW caches woff2
// on first visit, so custom fonts appear from the second visit onward (zero CLS).
const fontDisplayOptional = {
  name: 'font-display-optional',
  transform(code, id) {
    if (id.includes('@fontsource')) {
      return { code: code.replace(/font-display\s*:\s*swap/g, 'font-display:optional'), map: null };
    }
  },
};

export default defineConfig(() => ({
  plugins: [fontDisplayOptional],
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
