import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  READ_ON_DOUBLE_CLICK_ATTRIBUTE,
  READ_ON_DOUBLE_CLICK_PROPS,
  paperForDoubleClick,
  type ClosestElement
} from '../src/lib/doubleClickRead'

/**
 * A small stand-in for the part of Element the rule uses. It walks real
 * parents, because a double click usually lands on a cell or a hit line and
 * the document id lives on the row above it.
 */
type FakeElement = ClosestElement & {
  parent: FakeElement | null
  attrs: Record<string, string>
}

function matches(node: FakeElement, selector: string): boolean {
  if (selector === '.pane-right') {
    return (node.attrs.class ?? '').split(' ').includes('pane-right')
  }
  const attribute = /^\[([\w-]+)\]$/.exec(selector)
  return attribute ? Object.prototype.hasOwnProperty.call(node.attrs, attribute[1]) : false
}

function element(attrs: Record<string, string> = {}, parent: FakeElement | null = null): FakeElement {
  const node: FakeElement = {
    attrs,
    parent,
    closest(selector: string) {
      let current: FakeElement | null = node
      while (current) {
        if (matches(current, selector)) return current
        current = current.parent
      }
      return null
    },
    getAttribute(name: string) {
      return attrs[name] ?? null
    }
  }
  return node
}

function readRow(id: string, className: string): FakeElement {
  return element({
    'data-id': id,
    class: className,
    [READ_ON_DOUBLE_CLICK_ATTRIBUTE]: 'true'
  })
}

describe('paperForDoubleClick', () => {
  it('keeps the attribute name the rows are marked with', () => {
    expect(READ_ON_DOUBLE_CLICK_ATTRIBUTE).toBe('data-read-on-double-click')
    expect(READ_ON_DOUBLE_CLICK_PROPS).toEqual({ 'data-read-on-double-click': 'true' })
  })

  it('a double click on a table cell reads the paper owning the row', () => {
    const row = readRow('paper-table', 'row sel')
    expect(paperForDoubleClick(element({ class: 'cell' }, row))).toEqual({
      id: 'paper-table',
      read: true
    })
    expect(paperForDoubleClick(row)).toEqual({ id: 'paper-table', read: true })
  })

  it('a double click on a reference hit reads the paper owning that group', () => {
    const row = readRow('paper-reference', 'ft-row')
    const hit = element({ class: 'ft-hit' }, row)
    expect(paperForDoubleClick(hit)).toEqual({ id: 'paper-reference', read: true })
  })

  it('a search result card still only pins its tab', () => {
    const row = element({ 'data-id': 'paper-search', class: 'res-row' })
    expect(paperForDoubleClick(row)).toEqual({ id: 'paper-search', read: false })
  })

  it('trash and notes rows still only pin their tabs', () => {
    for (const className of ['trash-row', 'note-row']) {
      const row = element({ 'data-id': 'paper-other', class: className })
      expect(paperForDoubleClick(row), className).toEqual({ id: 'paper-other', read: false })
    }
  })

  it('the right pane is left to the tab bar', () => {
    const pane = element({ class: 'pane pane-right' })
    const tab = element({ 'data-id': 'paper-tab', class: 'paper-tab' }, pane)
    expect(paperForDoubleClick(tab)).toBeNull()
  })

  it('a column resize handle and an empty id name no paper', () => {
    expect(paperForDoubleClick(element({ class: 'col-resize' }))).toBeNull()
    expect(paperForDoubleClick(null)).toBeNull()
    expect(paperForDoubleClick(element({ 'data-id': '' }))).toBeNull()
  })
})

/** A rule that is never marked on a row is a rule that never fires. */
describe('the double click is wired to the two catalogues', () => {
  const root = (() => {
    let dir = process.cwd()
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      dir = path.dirname(dir)
    }
    return process.cwd()
  })()
  const read = (p: string): string =>
    fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n')

  it('both the table row and the references row carry the marker', () => {
    for (const file of ['src/components/DocTable.tsx', 'src/components/RefsView.tsx']) {
      expect(read(file), file).toContain('{...READ_ON_DOUBLE_CLICK_PROPS}')
    }
  })

  it('the capture handler pins and then opens the reading view', () => {
    const app = read('src/App.tsx')
    expect(app).toContain('paperForDoubleClick(target)')
    expect(app).toContain('pinOpenPaper(hit.id)')
    expect(app).toContain("if (hit.read) setView({ kind: 'reader' })")
  })
})
