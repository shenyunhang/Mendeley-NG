import { Menu } from 'electron'

/**
 * The menu bar is hidden (autoHideMenuBar) but not removed: Electron's role
 * accelerators -- copy, paste, select all, reload, dev tools -- live on the
 * application menu, so `setApplicationMenu(null)` would quietly take them
 * away from every text box in the reader.  Labels are Chinese rather than
 * Electron's English defaults because Alt can still reveal the bar.
 */
export function installAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [{ role: 'quit', label: '退出' }]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' }
        ]
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' }
        ]
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'close', label: '关闭' }
        ]
      }
    ])
  )
}
