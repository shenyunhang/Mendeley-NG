import path from 'node:path'
import { pdfFontOptionsFromPath } from '../../shared/pdfFontOptions'

/**
 * Where the main process finds the font resources pdf.js needs.
 *
 * electron-vite puts the renderer's public assets in out/renderer, which from
 * out/main is ../renderer.  The packaged app unpacks them out of the asar
 * (build.asarUnpack), because Chromium cannot fetch files from inside an asar;
 * Node's fs reads the same path either way.  Every pdf.js call in the main
 * process goes through this so no call site hand-writes the directory.
 */
export function pdfFontOptions() {
  return pdfFontOptionsFromPath(path.join(__dirname, '..', 'renderer'))
}
