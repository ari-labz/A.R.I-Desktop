const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("picker", {
    list:    ()        => ipcRenderer.invoke("servers:list"),
    save:    (servers) => ipcRenderer.invoke("servers:save", servers),
    connect: (payload) => ipcRenderer.invoke("servers:connect", payload),
})
