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
  listPrinters: () => ipcRenderer.invoke("list-printers"),
  printPdf: (options) => ipcRenderer.invoke("print-pdf", options),
  addRecent: (filePath) => ipcRenderer.send("add-recent", filePath),
  // O caminho vem do próprio Electron, só para arquivos de verdade (arrastados ou
  // escolhidos); o processo principal passa a permitir ler e gravar esse arquivo.
  getPathForFile: (file) => {
    let filePath = null;
    try {
      filePath = webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
    if (filePath) ipcRenderer.send("choose-dropped", filePath);
    return filePath;
  },
  setState: (state) => ipcRenderer.send("set-state", state),
  closeWindow: () => ipcRenderer.send("close-window"),
  onMenu: (callback) => ipcRenderer.on("menu", (_e, action) => callback(action)),
  onOpenFile: (callback) => ipcRenderer.on("open-file", (_e, file) => callback(file)),
  onNotice: (callback) => ipcRenderer.on("notice", (_e, notice) => callback(notice)),
  getUpdateStatus: () => ipcRenderer.invoke("update-status"),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_e, status) => callback(status)),
  checkForUpdates: () => ipcRenderer.send("update-check"),
  downloadUpdate: () => ipcRenderer.send("update-download"),
  installUpdate: () => ipcRenderer.send("update-install"),
});
