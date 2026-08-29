import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` emits dist/index.html: one self-contained file (Three.js,
// the shader code and house.svg all inlined) that opens straight from
// file:// with no server or network.
export default defineConfig({
  plugins: [viteSingleFile()],
});
