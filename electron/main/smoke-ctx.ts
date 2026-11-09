import type { BrowserWindow } from 'electron'
export type Expect = (name: string, ok: boolean, detail: unknown) => void
export interface SmokeCtx {
  expect: Expect
  log: (...a: unknown[]) => void
  fails: string[]
  w: BrowserWindow
}
