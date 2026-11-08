import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('shared') } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
        // The smoke suite is loaded with a dynamic import so it stays out of
        // the production startup path.  Keep its chunk beside index.js rather
        // than in a chunks/ subdirectory: the main process resolves the
        // preload, the renderer html and the project root with __dirname, and
        // an extra directory level would move every one of those paths.
        output: { chunkFileNames: '[name]-[hash].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    }
  }
})
