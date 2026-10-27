import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import path from 'node:path'
import type { DeckEvents, MenuCommand } from '../shared/ipc'
import { RUNNING_STATUSES, STATUS_META } from '../shared/constants'
import { isSafeExternalUrl } from '../shared/urls'
import { openDatabase } from './db/database'
import { Deck } from './deck'
import { registerIpc } from './ipc'
import { initLog, log } from './log'
import { cleanLaunchers, dbPath, runtimeDir } from './paths'
import { shellEnv } from './ssh/shellEnv'

const isDev = !app.isPackaged
const rendererUrl = process.env.ELECTRON_RENDERER_URL

app.setName('Claude Deck')
app.setPath('userData', process.env.CLAUDE_DECK_USER_DATA || path.join(app.getPath('appData'), 'Claude Deck'))

let win: BrowserWindow | null = null
let tray: Tray | null = null
let deck: Deck
let quitting = false
let shutdownDone = false
let trayTimer: NodeJS.Timeout | null = null

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

function send<E extends keyof DeckEvents>(event: E, payload: DeckEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send('deck:event', event, payload)
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function command(c: MenuCommand): void {
  showWindow()
  send('menu', { command: c })
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  if (!win || win.isDestroyed() || e.sender.id !== win.webContents.id) return false
  if (e.senderFrame !== win.webContents.mainFrame) return false
  const url = e.senderFrame?.url ?? ''
  if (isDev && rendererUrl) return url.startsWith(rendererUrl)
  return url.startsWith('file://') && url.includes('/renderer/index.html')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Claude Deck',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev || process.env.CDECK_DEVTOOLS === '1',
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (ev, url) => {
    if (url !== win?.webContents.getURL()) ev.preventDefault()
  })
  win.on('close', (ev) => {
    // Closing the window keeps Claude Deck (and the menu-bar launcher) running; ⌘Q quits.
    if (!quitting) {
      ev.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
  if (isDev && rendererUrl) void win.loadURL(rendererUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Claude Deck',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project / Session…', accelerator: 'CmdOrCtrl+N', click: () => command('new-session') },
        { label: 'Import Existing Sessions…', accelerator: 'CmdOrCtrl+Shift+I', click: () => command('import-sessions') },
        { label: 'Link Conversation…', accelerator: 'CmdOrCtrl+L', click: () => command('link-conversation') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh Status', accelerator: 'CmdOrCtrl+R', click: () => command('refresh') },
        { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => command('command-palette') },
        { label: 'Filter Projects', accelerator: 'CmdOrCtrl+F', click: () => command('focus-search') },
        { label: 'Toggle Cards / List', accelerator: 'CmdOrCtrl+Shift+L', click: () => command('toggle-view') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? ([{ type: 'separator' }, { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function openFromTray(runtimeId: string): Promise<void> {
  try {
    const res = await deck.opener.openClaude({ runtimeId })
    if (!res.opened) {
      showWindow()
      send('open-request', { runtimeId })
    }
  } catch (err) {
    log.warn('tray open failed', { error: String(err) })
    showWindow()
    send('open-request', { runtimeId })
  }
}

function updateTray(): void {
  if (trayTimer) return
  trayTimer = setTimeout(() => {
    trayTimer = null
    const settings = deck.settings()
    if (!settings.trayEnabled) {
      tray?.destroy()
      tray = null
      return
    }
    if (!tray) {
      const img = nativeImage.createFromPath(path.join(resourcesDir(), 'tray', 'trayTemplate.png'))
      img.setTemplateImage(true)
      tray = new Tray(img)
      tray.setToolTip('Claude Deck')
    }
    const state = deck.buildState()
    const accounts = new Map(state.accounts.map((a) => [a.id, a]))
    const projects = new Map(state.projects.map((p) => [p.id, p]))
    const items: MenuItemConstructorOptions[] = []
    for (const h of state.hosts) {
      const live = state.live.hosts[h.id]
      const label = live?.reachable === false ? 'unreachable' : h.lastConnectionStatus === 'online' ? 'connected' : h.lastConnectionStatus
      items.push({ label: `${h.displayName} — ${label}`, enabled: false })
    }
    const running = state.runtimes.filter((r) => !r.archived && RUNNING_STATUSES.includes(r.observedStatus) && !projects.get(r.projectId)?.archived)
    if (running.length) {
      items.push({ type: 'separator' }, { label: 'Open Claude', enabled: false })
      for (const r of running.slice(0, 20)) {
        const p = projects.get(r.projectId)
        const a = r.accountId ? accounts.get(r.accountId) : null
        const meta = STATUS_META[r.observedStatus]
        items.push({
          label: `${p?.displayName ?? r.tmuxSessionName} · ${a?.displayName ?? 'account?'}`,
          sublabel: meta.short,
          click: () => void openFromTray(r.id),
        })
      }
    }
    items.push(
      { type: 'separator' },
      { label: 'Show Claude Deck', click: () => showWindow() },
      { label: 'New Session…', click: () => command('new-session') },
      { label: 'Refresh Status', click: () => void deck.monitor.refreshAll() },
      { type: 'separator' },
      { label: 'Quit Claude Deck', click: () => app.quit() },
    )
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }, 1000)
}

async function init(): Promise<void> {
  initLog(app.getPath('logs'), isDev)
  log.info('starting Claude Deck', { version: app.getVersion() })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  if (isDev && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(path.join(resourcesDir(), 'icon.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }

  void shellEnv()
  const db = openDatabase(dbPath())
  cleanLaunchers()
  deck = new Deck(db, runtimeDir())
  deck.getWindow = () => win
  deck.setSink((event, payload) => send(event, payload))
  deck.setNotifier((title, body, runtimeId) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.on('click', () => {
      showWindow()
      if (runtimeId) send('focus-runtime', { runtimeId })
    })
    n.show()
  })
  // Keep the native vibrancy material (sidebar) in sync with the app's theme setting.
  nativeTheme.themeSource = deck.settings().theme
  deck.onState((s) => {
    if (nativeTheme.themeSource !== s.settings.theme) nativeTheme.themeSource = s.settings.theme
    updateTray()
  })
  registerIpc(deck, isTrustedSender)
  buildMenu()
  createWindow()
  deck.start()
  updateTray()

  powerMonitor.on('suspend', () => {
    log.info('system suspend: pausing refresh')
    deck.monitor.pause()
  })
  powerMonitor.on('resume', () => {
    log.info('system resume: reconnecting')
    void deck.hosts.resetAll().finally(() => deck.monitor.resume())
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('activate', () => showWindow())
  app.on('window-all-closed', () => {
    /* keep running on macOS; sessions on the VM are never affected by the app's lifecycle */
  })
  app.on('before-quit', (e) => {
    quitting = true
    if (shutdownDone || !deck) return
    e.preventDefault()
    // Only local resources are released (timers, SSH multiplexer). Nothing on the VM is stopped.
    void Promise.race([deck.shutdown(), new Promise((r) => setTimeout(r, 3000))]).finally(() => {
      shutdownDone = true
      app.quit()
    })
  })
  void app.whenReady().then(init)
}
