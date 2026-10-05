const { execSync } = require("child_process")
const fs           = require("fs")
const path         = require("path")
const { version }  = require("./package.json")

const repoRoot   = path.join(__dirname, "..")
const buildsDir  = path.join(repoRoot, "Builds")
const versionDir = path.join(buildsDir, `v${version}`)
const tmpDir     = path.join(versionDir, ".tmp")
const eb         = path.join(__dirname, "node_modules", ".bin", "electron-builder")

fs.mkdirSync(versionDir, { recursive: true })
fs.mkdirSync(tmpDir,     { recursive: true })

// ── Electron builds ───────────────────────────────────────────────────────────

// BUILD_PLATFORM (space/comma list) restricts which OS artifacts are built, so CI can split mac
// onto a macOS runner and win+linux onto a Linux runner. Unset = all (local default).
const wantedPlats = (process.env.BUILD_PLATFORM || "mac win linux").split(/[\s,]+/).filter(Boolean)

const platforms = [
    { plat: "win",   flag: "--win   --x64", zip: `ARI_Desktop_v${version}_win.zip`   },
    { plat: "linux", flag: "--linux --x64", zip: `ARI_Desktop_v${version}_linux.zip` },
    { plat: "mac",   flag: "--mac",         zip: `ARI_Desktop_v${version}_mac.zip`   },
].filter(p => wantedPlats.includes(p.plat))

for (const { flag, zip } of platforms) {
    console.log(`\n── Building ARI ${zip}\n`)
    execSync(`bunx electron-builder ${flag} --config.directories.output="${tmpDir}"`, {
        stdio: "inherit",
        cwd:   __dirname,
    })
    // Move just the zip to versionDir, discard everything else
    const built = fs.readdirSync(tmpDir).find(f => f.endsWith(".zip"))
    if (!built) throw new Error(`No zip found after building ${zip}`)
    fs.renameSync(path.join(tmpDir, built), path.join(versionDir, zip))
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n✓ All builds complete → Builds/v${version}/`)
fs.readdirSync(versionDir).forEach(f => console.log(`  ${f}`))
