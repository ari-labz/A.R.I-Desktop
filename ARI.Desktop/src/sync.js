// ARI Project Sync — Desktop side.
// Handles push/pull of the .ariproject hidden git repo via git bundles over HTTP.
// The server-side counterpart is ProjectSyncController.cs.

const { execFile } = require("child_process")
const fs   = require("fs")
const os   = require("os")
const path = require("path")

// ── Git helpers ───────────────────────────────────────────────────────────────

function runGit(workTree, args) {
    const ariDir = path.join(workTree, ".ariproject")
    const fullArgs = ["--git-dir", ariDir, "--work-tree", workTree, ...args]
    return new Promise((resolve, reject) => {
        execFile("git", fullArgs, { cwd: workTree }, (err, stdout, stderr) => {
            const output = (stdout + stderr).trim()
            if (err) reject(new Error(output || err.message))
            else resolve(output)
        })
    })
}

function hasAriProject(localPath) {
    return fs.existsSync(path.join(localPath, ".ariproject"))
}

// Write .ariignore content into .ariproject/info/exclude so git add --all honours
// it natively. `git add` doesn't support --exclude-from; info/exclude is the
// correct per-repo mechanism for untracked exclude rules.
function syncExcludeFile(localPath) {
    const ariIgnore = path.join(localPath, ".ariignore")
    const infoDir   = path.join(localPath, ".ariproject", "info")
    const exclude   = path.join(infoDir, "exclude")
    if (!fs.existsSync(ariIgnore)) return
    fs.mkdirSync(infoDir, { recursive: true })
    fs.copyFileSync(ariIgnore, exclude)
}

async function initAriProject(localPath) {
    const ariDir = path.join(localPath, ".ariproject")
    if (fs.existsSync(ariDir)) return
    await runGit(localPath, ["init"])
    await runGit(localPath, ["commit", "--allow-empty", "-m", "Init"])
}

async function getHead(localPath) {
    try { return await runGit(localPath, ["rev-parse", "HEAD"]) }
    catch { return null }
}

// ── Commit local changes ──────────────────────────────────────────────────────

// Find all .git directories inside localPath (any depth), excluding .ariproject itself.
function findInnerGitDirs(dir, results = []) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return results }
    for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = path.join(dir, e.name)
        if (e.name === ".ariproject") continue
        if (e.name === ".git") { results.push(full); continue }
        // Don't recurse into excluded dirs (node_modules etc.) — saves time
        if (["node_modules", "bin", "obj", "dist", "devbuild"].includes(e.name)) continue
        findInnerGitDirs(full, results)
    }
    return results
}

async function commitLocalChanges(localPath) {
    // Keep info/exclude in sync with .ariignore before staging.
    syncExcludeFile(localPath)

    // git refuses to add a directory that contains .git as a regular directory — it treats it as
    // a submodule. Temporarily rename all inner .git dirs so they're invisible to git during add.
    const innerGitDirs = findInnerGitDirs(localPath)
    const hiddenGitDirs = innerGitDirs.map(g => g + "-ari-hidden")
    for (let i = 0; i < innerGitDirs.length; i++) {
        try { fs.renameSync(innerGitDirs[i], hiddenGitDirs[i]) } catch { /* already gone */ }
    }

    try {
        // Also remove any leftover submodule index entries so they don't shadow the real files.
        const lsOut = await runGit(localPath, ["ls-files", "--stage"]).catch(() => "")
        const submodulePaths = lsOut.split("\n")
            .filter(l => l.startsWith("160000"))
            .map(l => l.split("\t")[1]?.trim())
            .filter(Boolean)
        if (submodulePaths.length > 0)
            await runGit(localPath, ["rm", "--cached", "--", ...submodulePaths]).catch(() => {})

        // Untrack any files that are now ignored but were previously committed.
        const trackedIgnored = await runGit(localPath, ["ls-files", "--cached", "--ignored", "--exclude-standard"]).catch(() => "")
        if (trackedIgnored.trim()) {
            const paths = trackedIgnored.trim().split("\n").filter(Boolean)
            await runGit(localPath, ["rm", "--cached", "-r", "--", ...paths]).catch(() => {})
        }

        // Stage everything — excludes honoured via .ariproject/info/exclude.
        await runGit(localPath, ["add", "--all"])

        // Restore inner .git dirs now (before commit) so we can force-add them.
        // They must be renamed back first — git add -f won't work on the hidden names.
        for (let i = 0; i < hiddenGitDirs.length; i++) {
            try { fs.renameSync(hiddenGitDirs[i], innerGitDirs[i]) } catch { /* already restored */ }
        }

        // Force-add the .git directories so ARI can see repo metadata and run git commands.
        // -f bypasses info/exclude; we explicitly exclude only .git-ari-hidden in .ariignore.
        for (const gitDir of innerGitDirs) {
            const rel = path.relative(localPath, gitDir)
            await runGit(localPath, ["add", "-f", rel]).catch(() => {})
        }

        // Check if there is anything staged
        const status = await runGit(localPath, ["status", "--porcelain"])
        if (!status) return null  // nothing to commit

        const stamp = new Date().toISOString().replace("T", " ").slice(0, 16)
        await runGit(localPath, ["commit", "-m", `Sync ${stamp}`])
        return await getHead(localPath)
    } finally {
        // Ensure .git dirs are always restored even if something above threw.
        for (let i = 0; i < hiddenGitDirs.length; i++) {
            try { fs.renameSync(hiddenGitDirs[i], innerGitDirs[i]) } catch { /* already restored */ }
        }
    }
}

// ── Bundle operations ─────────────────────────────────────────────────────────

async function createBundle(localPath, serverSha) {
    const tmp = path.join(os.tmpdir(), `ari-push-${Date.now()}.bundle`)
    const rangeArgs = serverSha ? [`${serverSha}..HEAD`] : ["--all"]
    await runGit(localPath, ["bundle", "create", tmp, ...rangeArgs])
    return tmp
}

async function applyBundle(localPath, bundlePath) {
    // Fetch into a scratch ref — git refuses to fetch into the currently checked-out branch.
    await runGit(localPath, ["fetch", bundlePath, "HEAD:refs/heads/ari/incoming"])
    // Point HEAD at main (idempotent; needed on first sync where no branch exists yet).
    await runGit(localPath, ["symbolic-ref", "HEAD", "refs/heads/main"])
    // Fast-forward main to the incoming tip and sync the working tree.
    await runGit(localPath, ["reset", "--hard", "refs/heads/ari/incoming"])
    await runGit(localPath, ["branch", "-D", "ari/incoming"]).catch(() => {})
}

// ── Pull helper (shared by first-sync and normal behind-path) ────────────────

async function pullFromServer({ localPath, projectId, endpoint, token, clientSha }) {
    const pullUrl = `${endpoint}/projects/${projectId}/sync/pull${clientSha ? `?clientSha=${clientSha}` : ""}`
    const pullRes = await fetch(pullUrl, { headers: { Authorization: `Bearer ${token}` } })
    if (!pullRes.ok) throw new Error(`Pull failed: ${pullRes.status}`)
    const arrayBuf = await pullRes.arrayBuffer()
    const tmpBundle = path.join(os.tmpdir(), `ari-pull-${Date.now()}.bundle`)
    try {
        fs.writeFileSync(tmpBundle, Buffer.from(arrayBuf))
        await applyBundle(localPath, tmpBundle)
        syncExcludeFile(localPath)
        const serverSha = await getHead(localPath)
        return { state: "pulled", serverSha }
    } finally {
        if (fs.existsSync(tmpBundle)) fs.unlinkSync(tmpBundle)
    }
}

// ── High-level sync ───────────────────────────────────────────────────────────

async function syncProject({ localPath, projectId, endpoint, token }) {
    // First sync: no local .ariproject yet — pull the full server history and use that as the
    // shared root. This gives both sides a common ancestor SHA so rev-list works going forward.
    if (!hasAriProject(localPath)) {
        await runGit(localPath, ["init"])
        return pullFromServer({ localPath, projectId, endpoint, token, clientSha: null })
    }

    // Commit any uncommitted local changes before comparing with server.
    // This ensures local edits are always reflected in the ahead/behind count.
    await commitLocalChanges(localPath)

    const clientSha = await getHead(localPath)

    // Ask server for status
    const statusUrl = `${endpoint}/projects/${projectId}/sync/status${clientSha ? `?clientSha=${clientSha}` : ""}`
    const statusRes = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!statusRes.ok) throw new Error(`Status check failed: ${statusRes.status}`)
    const { serverSha, ahead, behind, hasContent } = await statusRes.json()

    // Server has no content — treat as a push-only first sync (skip pull, just push everything).
    if (!hasContent) {
        await commitLocalChanges(localPath)
        const allBundle = await createBundle(localPath, null)
        try {
            const bundleData = fs.readFileSync(allBundle)
            const pushRes = await fetch(`${endpoint}/projects/${projectId}/sync/push`, {
                method:  "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
                body: bundleData,
            })
            if (!pushRes.ok) {
                const err = await pushRes.json().catch(() => ({}))
                throw new Error(err.error ?? `Push failed: ${pushRes.status}`)
            }
            const { serverSha: newSha } = await pushRes.json()
            return { state: "pushed", serverSha: newSha }
        } finally {
            if (fs.existsSync(allBundle)) fs.unlinkSync(allBundle)
        }
    }

    if (ahead === 0 && behind === 0) return { state: "up-to-date", serverSha }

    let tmpBundle = null
    try {
        if (ahead > 0) {
            tmpBundle = await createBundle(localPath, serverSha)
            const bundleData = fs.readFileSync(tmpBundle)
            const pushRes = await fetch(`${endpoint}/projects/${projectId}/sync/push`, {
                method:  "POST",
                headers: {
                    Authorization:  `Bearer ${token}`,
                    "Content-Type": "application/octet-stream",
                },
                body: bundleData,
            })
            if (!pushRes.ok) {
                const err = await pushRes.json().catch(() => ({}))
                throw new Error(err.error ?? `Push failed: ${pushRes.status}`)
            }
            const { serverSha: newSha } = await pushRes.json()
            return { state: "pushed", serverSha: newSha }
        }

        if (behind > 0) {
            return pullFromServer({ localPath, projectId, endpoint, token, clientSha })
        }

        // ahead > 0 && behind > 0 → diverged
        return { state: "conflict", ahead, behind, serverSha }
    } finally {
        if (tmpBundle && fs.existsSync(tmpBundle)) fs.unlinkSync(tmpBundle)
    }
}

async function getStatus({ localPath, projectId, endpoint, token }) {
    if (!hasAriProject(localPath)) return { state: "uninitialized" }

    const clientSha = await getHead(localPath)
    const url = `${endpoint}/projects/${projectId}/sync/status${clientSha ? `?clientSha=${clientSha}` : ""}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return { state: "error", message: `HTTP ${res.status}` }

    const { serverSha, ahead, behind, hasContent } = await res.json()

    // Server has no tracked files — nothing has ever been pushed, regardless of local state.
    if (!hasContent) return { state: "uninitialized", serverSha, clientSha }

    if (ahead > 0 && behind > 0) return { state: "conflict", ahead, behind, serverSha, clientSha }
    if (ahead > 0)  return { state: "ahead",    ahead,  serverSha, clientSha }
    if (behind > 0) return { state: "behind",   behind, serverSha, clientSha }
    // SHAs match — but local working tree may have uncommitted files not yet on server.
    syncExcludeFile(localPath)
    const dirty = await runGit(localPath, ["status", "--porcelain"]).catch(() => "")
    if (dirty) return { state: "dirty", serverSha, clientSha }
    return { state: "up-to-date", serverSha, clientSha }
}

module.exports = { syncProject, getStatus, initAriProject, hasAriProject }
