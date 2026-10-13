// Ponte segura entre a interface (sem acesso ao Node) e o processo principal.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("pdfApi", {
  openDialog: (options) => ipcRenderer.invoke("open-dialog", options),
  saveFile: (options) => ipcRenderer.invoke("save-file", options),
  pickDirectory: (options) => ipcRenderer.invoke("pick-directory", options),
  writeFiles: (options) => ipcRenderer.invoke("write-files", options),
  readPath: (filePath) => ipcRenderer.invoke("read-path", filePath),
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
  getUserName: () => ipcRenderer.invoke("get-user-name"),
  addRecent: (filePath) => ipcRenderer.send("add-recent", filePath),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  setState: (state) => ipcRenderer.send("set-state", state),
  closeWindow: () => ipcRenderer.send("close-window"),
  onMenu: (callback) => ipcRenderer.on("menu", (_e, action) => callback(action)),
  onOpenFile: (callback) => ipcRenderer.on("open-file", (_e, file) => callback(file)),
  getUpdateStatus: () => ipcRenderer.invoke("update-status"),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_e, status) => callback(status)),
  checkForUpdates: () => ipcRenderer.send("update-check"),
  downloadUpdate: () => ipcRenderer.send("update-download"),
  installUpdate: () => ipcRenderer.send("update-install"),
});
