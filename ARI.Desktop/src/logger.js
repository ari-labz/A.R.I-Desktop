const fs   = require("fs")
const path = require("path")

let _logPath = null
let _stream  = null

function init(userDataDir) {
    // ARI_desktop.log mirrors the server's ARI.log so issue reports can attach both.
    _logPath = path.join(userDataDir, "ARI_desktop.log")
    // Truncate on each launch (mirrors ARI.log behaviour)
    _stream = fs.createWriteStream(_logPath, { flags: "w" })
    _stream.on("error", () => { /* nowhere to write — give up silently */ })
}

function _ts() {
    const d = new Date()
    const p = n => String(n).padStart(2, "0")
    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`
}

// Level token placed right after the timestamp, matching the server console format so both logs
// colour/read the same: [WARN] something went wrong, [ERROR] this module cannot run, [FATAL] the
// app cannot run. Info lines carry no token.
const LEVEL_TOKEN = { INF: "", WRN: "[WARN] ", ERR: "[ERROR] ", FTL: "[FATAL] " }

function _write(context, level, msg) {
    const line = `${_ts()} ${LEVEL_TOKEN[level]}[${context}] ${msg}\n`
    if (_stream) _stream.write(line)
    // Also mirror to console so DevTools / attached debugger can see it
    if (level === "ERR" || level === "FTL") console.error(line.trimEnd())
    else                                     console.log(line.trimEnd())
}

function makeLogger(context) {
    const withErr = (msg, err) => (err ? `${msg}\n  ${err?.stack ?? err}` : msg)
    return {
        info:  msg           => _write(context, "INF", msg),
        warn:  msg           => _write(context, "WRN", msg),
        error: (msg, err)    => _write(context, "ERR", withErr(msg, err)),
        fatal: (msg, err)    => _write(context, "FTL", withErr(msg, err)),
    }
}

function getLogPath() { return _logPath }

module.exports = { init, makeLogger, getLogPath }
