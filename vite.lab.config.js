// Build do FX Lab (editor de extensões) para a página do GitHub Pages: docs/lab/
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'lab',
  base: './',
  publicDir: false,
  build: { outDir: '../docs/lab', emptyOutDir: true, target: 'es2022' },
  server: { port: 5188 },
});
