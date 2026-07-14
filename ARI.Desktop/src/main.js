// ── Bootstrap: install deps before requiring anything from node_modules ───────
const fs   = require("fs")
const path = require("path")

const appDir      = path.join(__dirname, "..")
const needsInstall = !fs.existsSync(path.join(appDir, "node_modules", "electron-store"))

if (needsInstall) {
    const { execSync } = require("child_process")
    const bunPath = process.platform === "win32"
        ? path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe")
        : path.join(process.env.HOME ?? "", ".bun", "bin", "bun")
    const installer = fs.existsSync(bunPath) ? `"${bunPath}"` : "npm"
    console.log("[ARI.Desktop] Installing dependencies…")
    execSync(`${installer} install`, { cwd: appDir, stdio: "inherit" })
    console.log("[ARI.Desktop] Dependencies ready.")
}

// ── Main ──────────────────────────────────────────────────────────────────────
const { app, BrowserWindow, ipcMain, dialog } = require("electron")
const Store = require("electron-store")
const { readFile, writeFile, getFileTree, listDirectory, searchFiles, editFile, runCommand, findFiles, deleteFile, moveFile } = require("./fs")

// Commands the code agent may run without asking. The user can extend this at runtime via the
// "Whitelist" option on the command-confirmation prompt. Entries match a command if it equals the
// entry or begins with the entry followed by a space (so "dotnet build" covers "dotnet build -c Release").
// git is intentionally excluded — every git command requires explicit confirmation (it's the
// user's safety net) and is enforced as non-whitelistable in the renderer.
const DEFAULT_COMMAND_ALLOWLIST = [
    "dotnet build", "dotnet test", "dotnet restore", "dotnet format",
    "npm run build", "npm run test", "npm test", "npm run lint",
]
const { init: initLogger, makeLogger, getLogPath } = require("./logger")

const store = new Store()
const isDev = process.env.NODE_ENV === "development"

let win
let splash
let picker
let pickerResolve = null
let currentEndpoint = null
let appReadyResolve
const appReady = new Promise(resolve => { appReadyResolve = resolve })

// Initialise logger as early as possible so we capture everything
initLogger(app.getPath("userData"))
const log = makeLogger("ARI.Desktop")

log.info(`ARI client starting  (electron ${process.versions.electron}, node ${process.versions.node})`)
log.info(`Platform: ${process.platform} ${process.arch}`)
log.info(`Log file: ${getLogPath()}`)
log.info(`User data: ${app.getPath("userData")}`)
log.info(`isDev: ${isDev}`)

// ── Global error capture ──────────────────────────────────────────────────────
process.on("uncaughtException", err => {
    log.error("Uncaught exception in main process", err)
})
process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection in main process", reason instanceof Error ? reason : new Error(String(reason)))
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function createSplash() {
    log.info("Creating splash window")
    splash = new BrowserWindow({
        width:  400,
        height: 220,
        frame:  false,
        center: true,
        resizable:       false,
        alwaysOnTop:     true,
        backgroundColor: "#223742",
        webPreferences:  { nodeIntegration: false },
    })
    splash.loadFile(path.join(__dirname, "splash.html"))
    splash.webContents.on("did-fail-load", (_e, code, desc) => {
        log.error(`Splash failed to load: ${desc} (${code})`)
    })
}

const WAIT_TIMEOUT_MS = 60_000

async function waitForAri(endpoint) {
    log.info(`Waiting for ARI server at ${endpoint}/threads (timeout ${WAIT_TIMEOUT_MS / 1000}s) …`)
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    let attempt = 0
    while (true) {
        attempt++
        try {
            const res = await fetch(`${endpoint}/threads`)
            log.info(`Health check attempt ${attempt}: HTTP ${res.status}`)
            if (res.status < 500) {
                // Any non-5xx means the ARI server (or its auth layer) responded — it's up
                log.info("ARI server is ready")
                return
            }
            // 5xx — could be Cloudflare 530 (origin offline), 502, 503, etc. — keep waiting
            log.info(`HTTP ${res.status} — origin not yet reachable, retrying…`)
        } catch (err) {
            if (attempt === 1 || attempt % 5 === 0)
                log.info(`Health check attempt ${attempt}: connection refused — ARI not up yet`)
        }

        if (Date.now() >= deadline) {
            log.warn(`ARI server did not become reachable after ${WAIT_TIMEOUT_MS / 1000}s — loading anyway`)
            return
        }
        await new Promise(r => setTimeout(r, 1000))
    }
}

async function createWindow(endpoint) {
    log.info(`Endpoint: ${endpoint}`)

    createSplash()
    // Splash is up, so there's always a window — safe to tear down the picker now.
    if (picker && !picker.isDestroyed()) { picker.destroy(); picker = null }
    await waitForAri(endpoint)

    log.info("Creating main window")
    win = new BrowserWindow({
        width:       1280,
        height:      800,
        minWidth:    800,
        minHeight:   600,
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 12, y: 16 },
        icon: path.join(__dirname, "../assets/icon.png"),
        show: false,
        webPreferences: {
            preload:          path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration:  false,
        },
    })

    // ── Renderer process diagnostics ──────────────────────────────────────────
    const wlog = makeLogger("ARI.Renderer")

    win.webContents.on("did-start-loading",  () => wlog.info(`Loading ${endpoint} …`))
    win.webContents.on("did-finish-load",    () => wlog.info("Page loaded successfully"))
    win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
        wlog.error(`Page failed to load: ${desc} (${code}) — ${url}`)
        // Remembered server unreachable → drop back to the picker so another can be chosen.
        // -3 is ERR_ABORTED (normal during navigation), not a real failure.
        if (isMainFrame && code !== -3 && !isDev) {
            wlog.warn("Main frame failed to load — returning to server picker")
            returnToPicker()
        }
    })
    win.webContents.on("render-process-gone", (_e, details) => {
        wlog.error(`Renderer process gone: reason=${details.reason}  exitCode=${details.exitCode}`)
    })
    win.webContents.on("unresponsive", () => wlog.warn("Renderer process is unresponsive"))
    win.webContents.on("responsive",   () => wlog.info("Renderer process is responsive again"))
    win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        // level: 0=verbose 1=info 2=warning 3=error
        if (level >= 2) {
            const label = level === 3 ? "console.error" : "console.warn"
            wlog.warn(`[${label}] ${message}  (${sourceId}:${line})`)
        }
    })

    log.info(`Loading URL: ${endpoint}`)
    win.loadURL(endpoint)

    // Show window and dismiss splash only once the React app signals it's fully ready
    appReady.then(() => {
        log.info("App signalled ready — showing main window and closing splash")
        win.show()
        if (splash && !splash.isDestroyed()) {
            splash.destroy()
            splash = null
        }
    })

    // Fallback: show after 15 s if the app never signals ready
    setTimeout(() => {
        log.warn("App never signalled ready after 15 s — showing window anyway (fallback)")
        appReadyResolve()
    }, 15_000)
}

// ── Server picker (choose which ARI server to connect to) ─────────────────────

function genServerId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function loadServers() {
    let servers = store.get("servers", null)
    if (!Array.isArray(servers)) servers = []
    if (servers.length === 0) {
        // Migrate the legacy single endpoint into the new multi-server list.
        const legacy = store.get("endpoint", "") || "https://a-r-i.ai"
        servers = [{ id: genServerId(), name: "My Server", url: legacy }]
    }
    // In dev, always offer the local server as a one-click pick.
    if (isDev && !servers.some(s => s.url === "http://localhost:5074")) {
        servers.unshift({ id: genServerId(), name: "Local dev", url: "http://localhost:5074" })
    }
    store.set("servers", servers)
    return servers
}

// A remembered last server → straight through; otherwise show the picker.
function chooseEndpoint() {
    const servers = loadServers()
    if (store.get("rememberLast", false)) {
        const last = servers.find(s => s.id === store.get("lastServerId", null))
        if (last) { log.info(`Auto-connecting to remembered server: ${last.url}`); return Promise.resolve(last.url) }
    }
    return showPicker()
}

function showPicker() {
    log.info("Showing server picker")
    return new Promise(resolve => {
        pickerResolve = resolve
        picker = new BrowserWindow({
            width: 460, height: 480, resizable: false,
            titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 16 },
            backgroundColor: "#1b2e38",
            icon: path.join(__dirname, "../assets/icon.png"),
            webPreferences: {
                preload: path.join(__dirname, "picker-preload.js"),
                contextIsolation: true,
            },
        })
        picker.loadFile(path.join(__dirname, "picker.html"))
        picker.on("closed", () => {
            // Closed without connecting → nothing to fall back to; quit.
            if (pickerResolve) { log.info("Picker closed without a selection — quitting"); app.quit() }
            picker = null
        })
    })
}

// Called when a remembered server is unreachable — forget it and re-show the picker.
async function returnToPicker() {
    store.set("rememberLast", false)
    if (win && !win.isDestroyed()) { win.destroy(); win = null }
    currentEndpoint = await showPicker()
    createWindow(currentEndpoint)
}

ipcMain.handle("servers:list", () => loadServers())
ipcMain.handle("servers:save", (_e, servers) => { store.set("servers", servers); return true })
ipcMain.handle("servers:connect", (_e, { id, url, remember }) => {
    log.info(`servers:connect → ${url} (remember=${!!remember})`)
    store.set("lastServerId", id)
    store.set("rememberLast", !!remember)
    const resolve = pickerResolve
    pickerResolve = null
    if (picker && !picker.isDestroyed()) picker.hide()
    resolve?.(url)
})

app.whenReady().then(async () => {
    log.info("Electron app ready")
    currentEndpoint = await chooseEndpoint()
    createWindow(currentEndpoint)
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().filter(w => w !== splash && w !== picker).length === 0) {
            log.info("Re-creating window on activate")
            createWindow(currentEndpoint)
        }
    })
})

app.on("window-all-closed", () => {
    log.info("All windows closed")
    if (process.platform !== "darwin") {
        log.info("Quitting (non-macOS)")
        app.quit()
    }
})

// ── IPC: filesystem ───────────────────────────────────────
ipcMain.handle("fs:read", (_e, root, filePath) => {
    log.info(`fs:read  root=${root}  path=${filePath}`)
    return readFile(root, filePath)
})

ipcMain.handle("fs:write", (_e, root, filePath, content) => {
    log.info(`fs:write  root=${root}  path=${filePath}  bytes=${content?.length ?? 0}`)
    return writeFile(root, filePath, content)
})

ipcMain.handle("fs:pick-folder", async () => {
    log.info("fs:pick-folder  opening dialog")
    const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title:      "Select project folder",
    })
    if (result.canceled) { log.info("fs:pick-folder  cancelled"); return null }
    log.info(`fs:pick-folder  selected: ${result.filePaths[0]}`)
    return result.filePaths[0]
})

ipcMain.handle("fs:tree", (_e, root) => {
    log.info(`fs:tree  root=${root}`)
    return getFileTree(root)
})

ipcMain.handle("fs:list-dir", (_e, root, dirPath) => {
    log.info(`fs:list-dir  root=${root}  path=${dirPath ?? "."}`)
    return listDirectory(root, dirPath)
})

ipcMain.handle("fs:search", (_e, root, pattern, searchPath, glob, ignoreCase) => {
    log.info(`fs:search  root=${root}  pattern=${pattern}  path=${searchPath ?? "."}  glob=${glob ?? "*"}  ic=${!!ignoreCase}`)
    return searchFiles(root, pattern, searchPath, glob, ignoreCase)
})

ipcMain.handle("fs:edit", (_e, root, filePath, newString, options) => {
    const n = options && Array.isArray(options.edits) ? options.edits.length : 1
    log.info(`fs:edit  root=${root}  path=${filePath}  edits=${n}`)
    return editFile(root, filePath, newString, options)
})

ipcMain.handle("fs:run", (_e, root, command) => {
    log.info(`fs:run  root=${root}  command=${command}`)
    return runCommand(root, command)
})

ipcMain.handle("fs:find", (_e, root, pattern, searchPath) => {
    log.info(`fs:find  root=${root}  pattern=${pattern}`)
    return findFiles(root, pattern, searchPath)
})

ipcMain.handle("fs:delete", (_e, root, filePath) => {
    log.info(`fs:delete  root=${root}  path=${filePath}`)
    return deleteFile(root, filePath)
})

ipcMain.handle("fs:move", (_e, root, source, destination) => {
    log.info(`fs:move  root=${root}  ${source} -> ${destination}`)
    return moveFile(root, source, destination)
})

// ── IPC: command allowlist (persisted per-machine) ────────────────────────────
ipcMain.handle("cmd:get-allowlist", () => {
    const list = store.get("commandAllowlist", DEFAULT_COMMAND_ALLOWLIST)
    return Array.isArray(list) ? list : DEFAULT_COMMAND_ALLOWLIST
})
ipcMain.handle("cmd:set-allowlist", (_e, list) => {
    if (Array.isArray(list)) {
        store.set("commandAllowlist", list)
        log.info(`cmd:set-allowlist → ${list.length} entr${list.length === 1 ? "y" : "ies"}`)
    }
})

// ── IPC: config ───────────────────────────────────────────
ipcMain.handle("cfg:get-endpoint", () => {
    const ep = store.get("endpoint", "")
    log.info(`cfg:get-endpoint → "${ep}"`)
    return ep
})
ipcMain.handle("cfg:set-endpoint", (_e, url) => {
    log.info(`cfg:set-endpoint → "${url}"`)
    store.set("endpoint", url)
})

// ── IPC: project local paths (stored per-machine, not on server) ──────────────
ipcMain.handle("project:get-path", (_e, projectId) => {
    const path = store.get(`projectPaths.${projectId}`, null)
    log.info(`project:get-path  id=${projectId} → ${path ?? "null"}`)
    return path
})
ipcMain.handle("project:set-path", (_e, projectId, path) => {
    if (path === null || path === undefined) {
        store.delete(`projectPaths.${projectId}`)
        log.info(`project:set-path  id=${projectId} → cleared`)
    } else {
        store.set(`projectPaths.${projectId}`, path)
        log.info(`project:set-path  id=${projectId} → ${path}`)
    }
})

// ── IPC: window controls ──────────────────────────────────
ipcMain.handle("window:close", () => {
    log.info("IPC window:close received")
    win?.close()
})

ipcMain.handle("window:minimize", () => {
    log.info("IPC window:minimize received")
    win?.minimize()
})

ipcMain.handle("window:maximize", () => {
    if (!win) return
    if (win.isMaximized()) { log.info("IPC window:maximize — restoring"); win.unmaximize() }
    else                   { log.info("IPC window:maximize — maximizing"); win.maximize() }
})

ipcMain.handle("app:ready", () => {
    log.info("IPC app:ready received")
    appReadyResolve()
})

ipcMain.handle("app:version", () => app.getVersion())

ipcMain.handle("window:move-by", (_e, dx, dy) => {
    const [x, y] = win.getPosition()
    win.setPosition(x + Math.round(dx), y + Math.round(dy))
})
