/**
 * The interface dictionary uses the Chinese text itself as the key. That is
 * what keeps Chinese mode byte-for-byte identical to the interface the smoke
 * run asserts on, so these cases hold both the translation and the wiring.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABEL,
  makeTranslator,
  translate,
  translatedKeys
} from '../src/lib/i18n'

function rootUp(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
const read = (p: string): string =>
  fs.readFileSync(path.join(rootUp(), p), 'utf-8').replace(/\r\n/g, '\n')

/** Every literal Chinese string passed to a translator in the renderer. */
function translatedLiterals(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf-8')
        const re = /\b(?:t|tr|translator)\(\s*'((?:[^'\\]|\\.)*)'/g
        let match: RegExpExecArray | null
        while ((match = re.exec(text))) out.push(match[1])
      }
    }
  }
  walk(path.join(rootUp(), 'src'))
  return out
}

describe('the translator', () => {
  it('defaults to Chinese and offers exactly the two languages', () => {
    expect(DEFAULT_LANGUAGE).toBe('zh')
    expect(LANGUAGES).toEqual(['zh', 'en'])
    expect(LANGUAGE_LABEL.zh).toBe('中文')
    expect(LANGUAGE_LABEL.en).toBe('English')
  })

  it('returns the Chinese text unchanged in Chinese mode', () => {
    for (const text of ['设置', '语言', '没有匹配的文献', '导入文件…']) {
      expect(translate('zh', text)).toBe(text)
    }
  })

  it('looks up English and leaves untranslated labels readable', () => {
    expect(translate('en', '设置')).toBe('Settings')
    expect(translate('en', '语言')).toBe('Language')
    expect(translate('en', '没有匹配的文献')).toBe('No matching papers')
    expect(translate('en', '一段还没翻的话')).toBe('一段还没翻的话')
  })

  it('fills placeholders without touching the rest of the sentence', () => {
    expect(translate('zh', '已选 {n} 条', { n: 3 })).toBe('已选 3 条')
    expect(translate('en', '已选 {n} 条', { n: 3 })).toBe('3 selected')
    expect(translate('en', '当前 {version}', { version: '0.1.121' }))
      .toBe('Current 0.1.121')
    // A missing variable must not silently turn into "undefined".
    expect(translate('en', '当前 {version}')).toBe('Current {version}')
  })

  it('the dictionary covers every literal translation call site', () => {
    const keys = new Set(translatedKeys())
    const literals = translatedLiterals().filter((s) => /[\u4e00-\u9fff]/.test(s))
    expect(literals.length).toBeGreaterThan(70)
    for (const text of literals) expect(keys.has(text), text).toBe(true)
  })

  it('the detector can see a missing key', () => {
    const keys = new Set(translatedKeys())
    expect(keys.has('设置')).toBe(true)
    expect(keys.has('一个不在字典里的词')).toBe(false)
  })

  it('a translator built for one language does not leak into another', () => {
    const zh = makeTranslator('zh')
    const en = makeTranslator('en')
    expect(zh('详情')).toBe('详情')
    expect(en('详情')).toBe('Details')
    expect(zh('详情')).toBe('详情')
  })
})

describe('the language setting is wired end to end', () => {
  it('is a declared, validated config key', () => {
    const policy = read('shared/pathPolicy.ts')
    expect(policy).toContain('language: true')
    expect(policy).toContain("'language',")
    expect(policy).toContain("if (key === 'language' && value !== 'zh' && value !== 'en') continue")
    expect(read('shared/types.ts')).toContain('language?: Language')
  })

  it('hydrates from disk and falls back to Chinese for an old config', () => {
    const hook = read('src/lib/hooks/useConfig.ts')
    expect(hook).toContain("setLanguage(c.language === 'en' ? 'en' : 'zh')")
    expect(hook).toContain('language,')
    expect(hook).toContain('setLanguage,')
  })

  it('puts both choices on the settings sheet and drives the whole window', () => {
    const settings = read('src/components/Settings.tsx')
    expect(settings).toContain('data-lang-row')
    expect(settings).toContain('data-lang="zh"')
    expect(settings).toContain('data-lang="en"')
    expect(settings).toContain('onLanguage(')
    const app = read('src/App.tsx')
    expect(app).toContain('I18nProvider translator={translator}')
    expect(app).toContain('makeTranslator(language)')
    expect(app).toContain('writeConfig({ language: next })')
  })

  it('translates the section name used by "go to settings" too', () => {
    const settings = read('src/components/Settings.tsx')
    expect(settings).toContain("=== t(focus)")
    expect(settings).toContain('[focus, t]')
  })
})
