// Reports the Authenticode signature of the built installer.
//
// Signing is the only thing that stops Windows SmartScreen from warning on
// every install, and it is also the easiest thing to lose without noticing:
// electron-builder skips it silently when no certificate is in the
// environment, and the installer still builds and still runs.  So the build
// asks Windows what it thinks instead of trusting that signing happened.
//
// Set REQUIRE_SIGNATURE=1 to make an unsigned installer a failure.  CI does
// that only when it was handed a certificate, so a fork without one still
// builds.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.resolve('dist')

let files = []
try {
  files = fs
    .readdirSync(dist)
    .filter((f) => f.endsWith('.exe'))
    .map((f) => path.join(dist, f))
} catch {
  console.error('no dist/ directory; run `npm run dist` first')
  process.exit(1)
}

if (!files.length) {
  console.error('no .exe in dist/; run `npm run dist` first')
  process.exit(1)
}

const ps = (script) =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' }
  )

let unsigned = 0
for (const f of files) {
  const out = ps(
    `$s = Get-AuthenticodeSignature -LiteralPath '${f.replace(/'/g, "''")}'; ` +
      'Write-Output ($s.Status.ToString()); ' +
      'Write-Output ($s.SignerCertificate.Subject); ' +
      'Write-Output ($s.TimeStamperCertificate.Subject)'
  )
    .trim()
    .split(/\r?\n/)

  const [status, signer, timestamper] = [out[0] ?? '?', out[1] ?? '', out[2] ?? '']
  const signed = status === 'Valid'
  if (!signed) unsigned++
  console.log(
    `${path.basename(f)}\n  status    ${status}\n  signer    ${signer || '(none)'}` +
      `\n  timestamp ${timestamper || '(none)'}`
  )
}

if (unsigned) {
  const msg =
    `${unsigned} of ${files.length} installer(s) are not signed. Windows will ` +
    'show a SmartScreen warning. Build with CSC_LINK and CSC_KEY_PASSWORD in ' +
    'the environment to sign; see the README.'
  if (process.env.REQUIRE_SIGNATURE === '1') {
    console.error('\n' + msg)
    process.exit(1)
  }
  console.warn('\nwarning: ' + msg)
}
