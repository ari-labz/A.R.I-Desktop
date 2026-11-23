// Keeps projects in sync without anyone pressing a button. A few seconds after a file in a watched project changes, it syncs; and
// once a minute it asks the server whether Ari changed anything there and pulls if so. Which projects are watched is saved, so it
// carries on after a restart. Only the projects of the server the app is connected to are watched.

const fs   = require("fs")
const path = require("path")
const { syncProject, getStatus } = require("./sync")

const SETTLE_MS = 4000      // wait this long after the last change, so a burst of saves is one sync
const POLL_MS   = 60_000    // how often to ask the server about changes made there
const QUIET_MS  = 2000      // changes this soon after a sync are the sync's own writes
const SKIP      = new Set([".ariproject", ".git", ".git-ari-hidden", "node_modules", "bin", "obj", "dist", "devbuild"])

/**
 * @param store       the app's settings store (the watched list is kept under "autoSync")
 * @param log         logger
 * @param endpoint    () => the server the app is connected to
 * @param auth        () => Promise of the headers that sign a sync request in
 * @param notify      (projectId, result) => tells the window what the latest sync did
 */
function createAutoSync({ store, log, endpoint, auth, notify }) {
    const live = new Map()   // projectId -> { localPath, watcher, timer, running, again, quietUntil }
    let poll = null

    const saved = () => store.get("autoSync", [])
    const mine  = () => saved().filter(w => w.endpoint === endpoint())

    async function run(projectId) {
        const p = live.get(projectId)
        if (!p) return
        if (p.running) { p.again = true; return }
        p.running = true
        try {
            const result = await syncProject({ localPath: p.localPath, projectId, endpoint: endpoint(), auth: await auth() })
            log.info(`autosync ${projectId}: ${result.state}`)
            notify(projectId, result)
        } catch (e) {
            log.warn(`autosync ${projectId} failed: ${e.message}`)
            notify(projectId, { state: "error", message: e.message })
        } finally {
            p.running = false
            p.quietUntil = Date.now() + QUIET_MS
            if (p.again) { p.again = false; schedule(projectId) }
        }
    }

    function schedule(projectId) {
        const p = live.get(projectId)
        if (!p) return
        clearTimeout(p.timer)
        p.timer = setTimeout(() => run(projectId), SETTLE_MS)
    }

    function watch(projectId, localPath) {
        unwatch(projectId)
        const p = { localPath, watcher: null, timer: null, running: false, again: false, quietUntil: 0 }
        live.set(projectId, p)
        try {
            p.watcher = fs.watch(localPath, { recursive: true }, (_event, file) => {
                if (!file || p.running || Date.now() < p.quietUntil) return
                if (String(file).split(/[\\/]/).some(part => SKIP.has(part))) return
                schedule(projectId)
            })
            p.watcher.on("error", e => log.warn(`autosync ${projectId}: watching stopped: ${e.message}`))
            log.info(`autosync ${projectId}: watching ${localPath}`)
        } catch (e) {
            log.warn(`autosync ${projectId}: can't watch ${localPath}: ${e.message}`)
        }
    }

    function unwatch(projectId) {
        const p = live.get(projectId)
        if (!p) return
        clearTimeout(p.timer)
        try { p.watcher?.close() } catch { /* already closed */ }
        live.delete(projectId)
    }

    // Ari may have changed a project on the server (in a chat outside the desktop app): pull when the server is ahead, and catch
    // any local change the watcher missed.
    async function checkServer() {
        for (const [projectId, p] of live) {
            if (p.running) continue
            try {
                const status = await getStatus({ localPath: p.localPath, projectId, endpoint: endpoint(), auth: await auth() })
                if (["ahead", "behind", "dirty", "conflict"].includes(status.state)) run(projectId)
            } catch (e) {
                log.warn(`autosync ${projectId}: status check failed: ${e.message}`)
            }
        }
    }

    return {
        /** Watches every saved project of the connected server (call after connecting, or reconnecting elsewhere). */
        start() {
            for (const id of [...live.keys()]) unwatch(id)
            for (const w of mine()) if (fs.existsSync(w.localPath)) watch(w.projectId, w.localPath)
            clearInterval(poll)
            poll = setInterval(checkServer, POLL_MS)
        },
        /** Turns automatic sync on or off for one project, and remembers it. */
        set(projectId, localPath, on) {
            const rest = saved().filter(w => !(w.endpoint === endpoint() && w.projectId === projectId))
            if (on && localPath) {
                store.set("autoSync", [...rest, { endpoint: endpoint(), projectId, localPath }])
                watch(projectId, localPath)
                run(projectId)
            } else {
                store.set("autoSync", rest)
                unwatch(projectId)
            }
        },
        isOn: projectId => live.has(projectId),
    }
}

module.exports = { createAutoSync }
