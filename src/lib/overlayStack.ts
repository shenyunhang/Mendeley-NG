/**
 * Which floating layer one Escape press is allowed to close.
 *
 * The order is part of the behaviour, not a preference. The settings sheet
 * covers the whole window, and a toolbar card underneath it has to still be
 * there when the sheet is gone; closing two layers for one press makes the key
 * do twice what it was asked, which is most jarring exactly when the reader
 * cannot see what is underneath. The reading view and the multi-selection come
 * after all of these and stay with the app, because they are not floating
 * layers at all.
 *
 * Pure rule: no React, no DOM, no events. The hook owns the state and the
 * keyboard event; this only answers which layer is on top.
 */
export type OverlayLayer = 'settings' | 'columns' | 'sort' | 'filters'

export interface OverlayLayers {
  settings: boolean
  columns: boolean
  sort: boolean
  filters: boolean
}

/** Nothing is floating; an Escape press belongs to the app, not to this stack. */
export const NO_OVERLAYS: OverlayLayers = {
  settings: false,
  columns: false,
  sort: false,
  filters: false
}

/** The single layer a press may close, or null when the stack is empty. */
export function topOverlay(layers: OverlayLayers): OverlayLayer | null {
  if (layers.settings) return 'settings'
  if (layers.columns) return 'columns'
  if (layers.sort) return 'sort'
  if (layers.filters) return 'filters'
  return null
}
