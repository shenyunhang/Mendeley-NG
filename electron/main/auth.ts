/**
 * The authorization-code flow, done inside the app.
 *
 * Getting a token used to be three pieces of manual carrying: copy a URL out
 * of a terminal into a browser, copy the `code` out of the address bar back
 * into the terminal, then go and find the file the script wrote.  Two of
 * those three are pure carrying, and the third is only work because the file
 * is not where the app looks.
 *
 * What cannot be avoided is the registration.  Mendeley offers three flows
 * and none of them fits a desktop app that wants to keep working tomorrow:
 * there is no PKCE, so the code flow needs a client_secret; and the implicit
 * flow returns no refresh token at all — an access token lasts about an hour
 * and then the reader has to authorise again.  So the steps that remain are
 * "register an application" and "type the two values in".
 *
 * The redirect lands on http://localhost:8080/, and nothing is listening
 * there.  The navigation is cancelled before it is made, so the reader never
 * sees the "this site cannot be reached" page that used to be the part of the
 * instructions people got stuck on.
 */
import { BrowserWindow } from 'electron'
import { OAUTH_REDIRECT } from '../../shared/types'
import { exchangeCode, saveToken, type Token } from './mendeley'
import { resetClient } from './library'
import { getWin } from './window'

const AUTH_URL = 'https://api.mendeley.com/oauth/authorize'

export type AuthResult = { ok: true } | { ok: false; error: string }

/** Only this origin is ours.  Mendeley navigates its own login pages while
 *  signing in and every one of those has to be left alone. */
const REDIRECT_ORIGIN = new URL(OAUTH_REDIRECT).origin

export function authorizeUrl(clientId: string): string {
  return (
    `${AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    '&response_type=code&scope=all'
  )
}

export async function authorize(
  clientId: string,
  clientSecret: string
): Promise<AuthResult> {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!id || !secret) return { ok: false, error: 'client_id 和 client_secret 都要填' }

  const parent = getWin()
  const win = new BrowserWindow({
    width: 940,
    height: 720,
    title: '授权 Mendeley',
    autoHideMenuBar: true,
    // parented so it stays in front of the library and closes with it; a
    // window that can drift behind the app it belongs to reads as a hang
    ...(parent ? { parent } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // this window loads a page written by somebody else
      sandbox: true
    }
  })

  return new Promise<AuthResult>((resolve) => {
    let settled = false
    /** Three ways out and only one of them succeeds; the first one wins and
     *  the window goes away whichever it is. */
    const finish = (r: AuthResult) => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.close()
      resolve(r)
    }

    const swap = async (code: string): Promise<AuthResult> => {
      try {
        const tok = await exchangeCode(code, id, secret, OAUTH_REDIRECT)
        if (!tok.access_token) {
          return { ok: false, error: '换到的 token 里没有 access_token' }
        }
        resetClient(saveToken(tok), tok as Token)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    }

    const onNavigation = (e: { preventDefault: () => void }, url: string) => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return
      }
      if (u.origin !== REDIRECT_ORIGIN) return
      e.preventDefault()
      const code = u.searchParams.get('code')
      if (!code) {
        finish({
          ok: false,
          error:
            u.searchParams.get('error_description') ??
            u.searchParams.get('error') ??
            'Mendeley 没有返回 code'
        })
        return
      }
      void swap(code).then(finish)
    }

    // A 302 from the authorize endpoint comes through will-redirect; a page
    // that navigates itself comes through will-navigate.  Listening to only
    // one of them is the kind of thing that works for a year and then does
    // not, so both are handled by the same function.
    win.webContents.on('will-navigate', onNavigation)
    win.webContents.on('will-redirect', onNavigation)

    // institutional single sign-on opens a popup; refusing it would make
    // signing in impossible on exactly the accounts that need it
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true }
    }))

    win.on('closed', () => finish({ ok: false, error: '取消了授权' }))

    win.loadURL(authorizeUrl(id)).catch((e) => finish({ ok: false, error: String(e) }))
  })
}
