const $ = id => document.getElementById(id)

let servers  = []
let selected = null   // selected server id
let editing  = null   // id being edited, or null when adding

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function render() {
    const list = $("server-list")
    list.innerHTML = ""
    if (servers.length === 0) {
        list.innerHTML = `<div class="empty">No servers yet — add one below.</div>`
    }
    for (const s of servers) {
        const row = document.createElement("div")
        row.className = "server-row" + (s.id === selected ? " active" : "")
        row.innerHTML =
            `<div class="server-info">
                <div class="server-name">${escapeHtml(s.name || "Untitled")}</div>
                <div class="server-url">${escapeHtml(s.url)}</div>
             </div>
             <div class="server-actions">
                <button class="icon-btn" data-edit="${s.id}" title="Edit">✎</button>
                <button class="icon-btn" data-del="${s.id}" title="Remove">✕</button>
             </div>`
        row.querySelector(".server-info").addEventListener("click", () => selectServer(s.id))
        row.querySelector(`[data-edit="${s.id}"]`).addEventListener("click", e => { e.stopPropagation(); openForm(s.id) })
        row.querySelector(`[data-del="${s.id}"]`).addEventListener("click", e => { e.stopPropagation(); removeServer(s.id) })
        list.appendChild(row)
    }
    $("btn-connect").disabled = !selected
}

function selectServer(id) {
    selected = id
    render()
}

// ── Add / edit form ──────────────────────────────────────────────────────────

function openForm(id) {
    editing = id ?? null
    const s = id ? servers.find(x => x.id === id) : null
    $("f-name").value = s?.name ?? ""
    $("f-url").value  = s?.url ?? ""
    $("form").classList.remove("hidden")
    $("btn-add").classList.add("hidden")
    $("f-name").focus()
}

function closeForm() {
    $("form").classList.add("hidden")
    $("btn-add").classList.remove("hidden")
    editing = null
}

async function saveForm() {
    const name = $("f-name").value.trim()
    let   url  = $("f-url").value.trim()
    if (!url) { $("f-url").focus(); return }
    if (!/^https?:\/\//i.test(url)) url = "http://" + url   // default to http for bare IPs

    if (editing) {
        const s = servers.find(x => x.id === editing)
        if (s) { s.name = name || s.name; s.url = url }
    } else {
        const s = { id: genId(), name: name || url, url }
        servers.push(s)
        selected = s.id
    }
    await window.picker.save(servers)
    closeForm()
    render()
}

async function removeServer(id) {
    servers = servers.filter(s => s.id !== id)
    if (selected === id) selected = null
    await window.picker.save(servers)
    render()
}

// ── Wiring ───────────────────────────────────────────────────────────────────

$("btn-add").addEventListener("click", () => openForm(null))
$("f-save").addEventListener("click", saveForm)
$("f-cancel").addEventListener("click", closeForm)
$("f-url").addEventListener("keydown", e => { if (e.key === "Enter") saveForm() })

$("btn-connect").addEventListener("click", () => {
    const s = servers.find(x => x.id === selected)
    if (!s) return
    window.picker.connect({ id: s.id, url: s.url, remember: $("remember").checked })
})

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

async function init() {
    servers = await window.picker.list()
    if (servers.length === 1) selected = servers[0].id   // preselect the only server
    render()
}

init()
