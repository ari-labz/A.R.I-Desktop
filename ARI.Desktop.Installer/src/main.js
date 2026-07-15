const { app, BrowserWindow, ipcMain, shell } = require("electron")
const https  = require("https")
const http   = require("http")
const fs     = require("fs")
const path   = require("path")
const os     = require("os")
const { execFile, spawn } = require("child_process")

const OWNER = "ari-labz"
const REPO  = "A.R.I-Desktop"

// The GitHub API needs a token only while the repo is private. Set this to false when the
// repo goes public — the installer then fetches releases anonymously and never asks for a token.
const REPO_PRIVATE = true

// App releases are tagged ARI_Desktop_v<ver> (pre-releases). The installer's own releases are
// ARI_Desktop_Installer_v<ver>, excluded because they don't start with this prefix.
const APP_PREFIX = "ARI_Desktop_v"
const verFromTag = tag => tag.slice(APP_PREFIX.length)

// ── Paths ─────────────────────────────────────────────────────────────────────
// Desktop versions live under {base}/desktop/{version}, alongside the server's {base}/server.

function getBaseDir() {
    if (process.platform === "win32")
        return path.join(process.env.LOCALAPPDATA || os.homedir(), "ARI")
    if (process.platform === "darwin")
        return path.join(os.homedir(), "Library", "Application Support", "ARI")
    return path.join(os.homedir(), ".local", "share", "ARI")
}

const baseDir     = getBaseDir()
const desktopDir  = path.join(baseDir, "desktop")
const tokenFile   = path.join(baseDir, "github_token.txt")
const currentFile = path.join(desktopDir, "current.txt")
// macOS launch point: the desktop app placed in /Applications.
const APP_IN_APPLICATIONS = "/Applications/A.R.I Desktop.app"
fs.mkdirSync(desktopDir, { recursive: true })

// ── Window ────────────────────────────────────────────────────────────────────

let win

app.whenReady().then(() => {
    win = new BrowserWindow({
        width: 460,
        height: 440,
        resizable: false,
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: "#1b2e38",
        icon: path.join(__dirname, "..", "assets", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
        },
    })
    win.loadFile(path.join(__dirname, "index.html"))
})

app.on("window-all-closed", () => app.quit())

// ── IPC: token ────────────────────────────────────────────────────────────────

ipcMain.handle("get-platform", () => process.platform)

ipcMain.handle("needs-token", () => REPO_PRIVATE)

ipcMain.handle("get-token", () => {
    // A token the user saved here wins over an ambient GITHUB_TOKEN env var, so re-entering a
    // valid token sticks even on a machine where the env var holds a stale/wrong one.
    if (fs.existsSync(tokenFile)) {
        const t = fs.readFileSync(tokenFile, "utf8").trim()
        if (t) return t
    }
    const env = process.env.GITHUB_TOKEN
    if (env?.trim()) return env.trim()
    return null
})

ipcMain.handle("save-token", (_, token) => {
    fs.writeFileSync(tokenFile, token.trim(), "utf8")
})

// ── IPC: releases ────────────────────────────────────────────────────────────────

ipcMain.handle("fetch-releases", async (_, token) => {
    const releases = await ghJson(token, `/repos/${OWNER}/${REPO}/releases?per_page=100`)
    if (!Array.isArray(releases) || releases.length === 0)
        throw new Error("No releases found on GitHub.")

    return releases
        .filter(r => !r.draft && r.tag_name.startsWith(APP_PREFIX))
        .sort((a, b) => compareVersions(verFromTag(b.tag_name), verFromTag(a.tag_name)))
        .map(r => ({
            tagName:    r.tag_name,
            version:    verFromTag(r.tag_name),
            prerelease: r.prerelease,
            assets:     r.assets.map(a => ({ id: a.id, name: a.name })),
        }))
})

// ── IPC: installed state ────────────────────────────────────────────────────────

ipcMain.handle("installed-info", () => {
    const version = installedVersion()
    return version ? { version } : null
})

function installedVersion() {
    if (fs.existsSync(currentFile)) {
        const v = fs.readFileSync(currentFile, "utf8").trim()
        if (v && fs.existsSync(path.join(desktopDir, v))) return v
    }
    const dirs = installedVersionDirs()
    return dirs.length ? dirs[0].name : null
}

function installedVersionDirs() {
    if (!fs.existsSync(desktopDir)) return []
    return fs.readdirSync(desktopDir)
        .map(n => ({ name: n, full: path.join(desktopDir, n) }))
        .filter(d => /^\d+\.\d+\.\d+/.test(d.name) && fs.statSync(d.full).isDirectory())
        .sort((a, b) => compareVersions(b.name, a.name))
}

// ── IPC: install + open ──────────────────────────────────────────────────────────

ipcMain.handle("download-and-install", async (event, token, release, options) => {
    const ver       = release.version
    const assetName = getAssetName(ver)
    const asset     = release.assets.find(a => a.name === assetName)
    if (!asset) {
        const names = release.assets.map(a => a.name).join(", ")
        throw new Error(`Asset "${assetName}" not in release. Available: ${names || "none"}`)
    }

    const zipPath    = path.join(os.tmpdir(), asset.name)
    const versionDir = path.join(desktopDir, ver)
    fs.mkdirSync(versionDir, { recursive: true })

    await downloadAsset(token, asset.id, zipPath, (pct, received, total) => {
        event.sender.send("download-progress", { pct, received, total })
    })

    event.sender.send("status", "Extracting…")
    await extract(zipPath, versionDir)
    fs.rmSync(zipPath, { force: true })
    if (process.platform !== "win32") setExecutableBit(versionDir)

    fs.writeFileSync(currentFile, ver, "utf8")
    cleanOldVersions(ver)

    if (options?.addShortcut) {
        event.sender.send("status", "Adding to Applications…")
        try { await addShortcut(versionDir) } catch (e) { /* best-effort */ }
    }
    if (options?.startApp) {
        event.sender.send("status", "Starting A·R·I Desktop…")
        try { launch(versionDir) } catch (e) { /* best-effort */ }
    }
    return { version: ver }
})

ipcMain.handle("open-app", (_, version) => {
    const dir = version ? path.join(desktopDir, version) : latestInstalledDir()
    if (!dir || !fs.existsSync(dir)) throw new Error("No installed version to open.")
    launch(dir)
})

function latestInstalledDir() {
    const v = installedVersion()
    return v ? path.join(desktopDir, v) : null
}

// The desktop Electron app inside a version dir. mac: the .app; win: the top-level .exe.
function findDesktopApp(versionDir) {
    if (process.platform === "darwin") {
        const app = fs.readdirSync(versionDir).find(f => f.endsWith(".app"))
        return app ? path.join(versionDir, app) : null
    }
    if (process.platform === "win32") {
        const exe = fs.readdirSync(versionDir).find(f => f.endsWith(".exe"))
        return exe ? path.join(versionDir, exe) : null
    }
    const bin = fs.readdirSync(versionDir, { withFileTypes: true })
        .find(e => e.isFile() && !path.extname(e.name))
    return bin ? path.join(versionDir, bin.name) : null
}

function launch(versionDir) {
    const appPath = findDesktopApp(versionDir)
    if (!appPath) throw new Error(`Could not find the A·R·I Desktop app in ${versionDir}`)
    if (process.platform === "darwin") spawn("open", [appPath], { detached: true }).unref()
    else spawn(appPath, [], { detached: true, stdio: "ignore" }).unref()
}

// ── Helpers: GitHub ─────────────────────────────────────────────────────────────

function ghHeaders(token, accept) {
    const headers = {
        "User-Agent":           "ARIDesktopInstaller/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        "Accept":               accept || "application/vnd.github+json",
    }
    if (token) headers["Authorization"] = `token ${token}`
    return headers
}

function ghJson(token, apiPath) {
    return new Promise((resolve, reject) => {
        https.get({ hostname: "api.github.com", path: apiPath, headers: ghHeaders(token) }, res => {
            let data = ""
            res.on("data", c => data += c)
            res.on("end", () => {
                if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error("TOKEN_INVALID"))
                if (res.statusCode === 404) return reject(new Error("NOT_FOUND"))
                if (res.statusCode !== 200) return reject(new Error(`GitHub API returned ${res.statusCode}`))
                try { resolve(JSON.parse(data)) }
                catch { reject(new Error("Failed to parse GitHub response.")) }
            })
        }).on("error", reject)
    })
}

function downloadAsset(token, assetId, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: "api.github.com",
            path: `/repos/${OWNER}/${REPO}/releases/assets/${assetId}`,
            headers: ghHeaders(token, "application/octet-stream"),
        }
        function doGet(url, redirectCount = 0) {
            if (redirectCount > 5) return reject(new Error("Too many redirects"))
            const mod     = url?.startsWith("http://") ? http : https
            const reqOpts = url ? new URL(url) : opts
            mod.get(reqOpts, res => {
                if ([301, 302, 307, 308].includes(res.statusCode))
                    return doGet(res.headers.location, redirectCount + 1)
                if (res.statusCode !== 200)
                    return reject(new Error(`Download failed: ${res.statusCode}`))
                const total  = parseInt(res.headers["content-length"] || "0", 10)
                let received = 0
                const dest   = fs.createWriteStream(destPath)
                res.on("data", chunk => {
                    received += chunk.length
                    dest.write(chunk)
                    if (total > 0) onProgress(Math.floor(received * 100 / total), received, total)
                })
                res.on("end",   () => { dest.end(); resolve() })
                res.on("error", e  => { dest.destroy(); reject(e) })
            }).on("error", reject)
        }
        doGet(null)
    })
}

// ── Helpers: filesystem / versions ───────────────────────────────────────────────

// Compare "v0.4.0" vs "v0.3.4" numerically. Returns >0 if a is newer.
function compareVersions(a, b) {
    const parse = t => String(t).replace(/^v/i, "").split(/[.\-+]/).map(n => parseInt(n, 10) || 0)
    const pa = parse(a), pb = parse(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d !== 0) return d
    }
    return 0
}

function getAssetName(version) {
    if (process.platform === "win32")  return `ARI_Desktop_v${version}_win.zip`
    if (process.platform === "darwin") return `ARI_Desktop_v${version}_mac.zip`
    return `ARI_Desktop_v${version}_linux.zip`
}

function extract(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (process.platform === "win32") {
            const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
            execFile("powershell.exe", ["-NoProfile", "-Command", ps], err => err ? reject(err) : resolve())
        } else {
            execFile("unzip", ["-o", zipPath, "-d", destDir], err => err ? reject(err) : resolve())
        }
    })
}

function setExecutableBit(dir) {
    for (const f of walkFiles(dir)) {
        if (!path.extname(f)) {
            try { fs.chmodSync(f, 0o755) } catch {}
        }
    }
}

function cleanOldVersions(keepVersion) {
    // Keep the 3 newest installed versions so downgrade stays fast.
    const dirs = installedVersionDirs()
    for (const d of dirs.slice(3)) {
        if (d.name === keepVersion) continue
        try { fs.rmSync(d.full, { recursive: true, force: true }) } catch {}
    }
}

function* walkFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walkFiles(full)
        else yield full
    }
}

// ── Helpers: OS shortcuts ────────────────────────────────────────────────────────

async function addShortcut(versionDir) {
    if (process.platform === "darwin")      await placeMacApp(versionDir)
    else if (process.platform === "win32")  addToStartMenu(createWinLauncher())
}

// macOS: copy the desktop app into /Applications (one admin authorization).
function placeMacApp(versionDir) {
    const bundled = findDesktopApp(versionDir)
    if (!bundled) return Promise.resolve()
    return new Promise(resolve => {
        const shell = `rm -rf '${APP_IN_APPLICATIONS}' && cp -R '${bundled}' '${APP_IN_APPLICATIONS}'`
        const osa   = `do shell script "${shell.replace(/"/g, '\\"')}" with administrator privileges`
        execFile("osascript", ["-e", osa], () => resolve())
    })
}

// Windows: a .cmd that opens the active desktop version (resolved via current.txt, so it survives
// updates/downgrades) plus a Start Menu shortcut pointing at it, named "A.R.I Desktop".
function createWinLauncher() {
    const cmd = path.join(baseDir, "ari-desktop-launch.cmd")
    fs.writeFileSync(cmd,
        `@echo off\r\n` +
        `set "BASE=${desktopDir}"\r\n` +
        `set /p VER=<"%BASE%\\current.txt"\r\n` +
        `for %%f in ("%BASE%\\%VER%\\*.exe") do start "" "%%f"\r\n`)
    return cmd
}

function addToStartMenu(target) {
    const programs = path.join(process.env.APPDATA || os.homedir(), "Microsoft", "Windows", "Start Menu", "Programs")
    const lnk = path.join(programs, "A.R.I Desktop.lnk")
    const ps = [
        `$WS = New-Object -ComObject WScript.Shell;`,
        `$s = $WS.CreateShortcut('${lnk}');`,
        `$s.TargetPath = '${target}';`,
        `$s.WorkingDirectory = '${path.dirname(target)}';`,
        `$s.Save()`,
    ].join(" ")
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], (err, _stdout, stderr) => {
        if (err || (stderr && stderr.trim())) {
            try { fs.appendFileSync(path.join(baseDir, "installer.log"), `[start-menu] target=${target} err=${err?.message || ""} stderr=${stderr || ""}\n`) } catch {}
        }
    })
}
