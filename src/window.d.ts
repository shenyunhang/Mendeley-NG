import type { Api } from './global'

/**
 * Global ambient declarations only.  They are separate from `global.d.ts` so
 * the main-process TypeScript project can import the IPC contract without
 * pulling `Window` (a DOM type) into a project that deliberately has no DOM
 * library.  That separation is what lets the preload script be type-checked
 * against the very same interface the renderer sees.
 */
declare global {
  interface Window {
    api: Api
  }
}

/** Vite turns an imported asset into the URL it was emitted at. */
declare module '*.svg' {
  const src: string
  export default src
}
