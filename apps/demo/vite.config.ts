import { defineConfig } from 'vite';

// Relative asset paths: the built folder works from any host or sub-folder.
export default defineConfig({
  base: './',
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
