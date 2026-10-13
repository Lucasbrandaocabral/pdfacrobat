// Processo principal do Electron: janela, menus, diálogos de arquivo e
// integração com o sistema operacional (abrir PDFs com duplo clique).
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_NAME = "PDF Acrobat";
const PDF_FILTER = { name: "Documentos PDF", extensions: ["pdf"] };
const IMAGE_FILTER = { name: "Imagens", extensions: ["png", "jpg", "jpeg"] };

const DIST_DIR = path.join(__dirname, "..", "dist");

// A interface é servida por um protocolo próprio (app://) em vez de file://,
// para que módulos ES, o worker do PDF.js e fetch() funcionem normalmente.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol() {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.normalize(path.join(DIST_DIR, decodeURIComponent(pathname)));
    if (!filePath.startsWith(DIST_DIR)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

let mainWindow = null;
let isDirty = false;
let forceClose = false;
let pendingFile = findPdfArg(process.argv);

function findPdfArg(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith(".pdf") && !a.startsWith("-")) || null;
}

async function readFileForRenderer(filePath) {
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

async function openInWindow(filePath) {
  if (!mainWindow) {
    pendingFile = filePath;
    return;
  }
  try {
    send("open-file", await readFileForRenderer(filePath));
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `Não foi possível abrir o arquivo:\n${err.message}`);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 500,
    title: APP_NAME,
    backgroundColor: "#f3f3f3",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadURL("app://pdfacrobat/index.html");
  }

  // Links externos abrem no navegador padrão, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.on("close", async (event) => {
    if (forceClose || !isDirty) return;
    event.preventDefault();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Salvar", "Não salvar", "Cancelar"],
      defaultId: 0,
      cancelId: 2,
      title: APP_NAME,
      message: "Deseja salvar as alterações antes de fechar?",
      detail: "Se você não salvar, as alterações serão perdidas.",
    });
    if (response === 0) {
      send("menu", "save-and-close");
    } else if (response === 1) {
      forceClose = true;
      mainWindow.close();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  buildMenu();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  // Os atalhos são tratados pela própria interface; aqui eles só aparecem no menu.
  const item = (label, action, accelerator) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send("menu", action),
  });

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Arquivo",
      submenu: [
        item("Abrir…", "open", "CmdOrCtrl+O"),
        item("Criar PDF a partir de imagens…", "create-from-images"),
        item("Combinar arquivos…", "combine"),
        { type: "separator" },
        item("Salvar", "save", "CmdOrCtrl+S"),
        item("Salvar como…", "save-as", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        item("Imprimir…", "print", "CmdOrCtrl+P"),
        item("Propriedades do documento", "properties", "CmdOrCtrl+D"),
        { type: "separator" },
        isMac ? { role: "close", label: "Fechar janela" } : { role: "quit", label: "Sair" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { role: "copy", label: "Copiar" },
        { role: "selectAll", label: "Selecionar tudo" },
        { type: "separator" },
        item("Localizar…", "find", "CmdOrCtrl+F"),
      ],
    },
    {
      label: "Exibir",
      submenu: [
        item("Mais zoom", "zoom-in", "CmdOrCtrl+="),
        item("Menos zoom", "zoom-out", "CmdOrCtrl+-"),
        item("Ajustar à largura", "fit-width"),
        item("Página inteira", "fit-page"),
        { type: "separator" },
        item("Mostrar/ocultar miniaturas", "toggle-sidebar"),
        { type: "separator" },
        { role: "togglefullscreen", label: "Tela cheia" },
        { role: "toggleDevTools", label: "Ferramentas do desenvolvedor" },
      ],
    },
    {
      label: "Ajuda",
      submenu: [
        {
          label: "Sobre o PDF Acrobat",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              title: APP_NAME,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                "Leitor e editor de PDF.\nRenderização: PDF.js (Mozilla) · Edição: pdf-lib · Interface: Electron (Chromium).",
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: chamado pela interface via preload.cjs ----

ipcMain.handle("open-dialog", async (_e, { multiple = false, images = false } = {}) => {
  const filters = images ? [IMAGE_FILTER] : [PDF_FILTER, IMAGE_FILTER];
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: multiple || images ? [{ name: "PDF e imagens", extensions: ["pdf", "png", "jpg", "jpeg"] }, ...filters] : [PDF_FILTER],
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(readFileForRenderer));
});

ipcMain.handle("save-file", async (_e, { data, filePath, suggestedName, saveAs }) => {
  let target = filePath;
  if (saveAs || !target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: target || suggestedName || "documento.pdf",
      filters: [PDF_FILTER],
    });
    if (canceled || !chosen) return null;
    target = chosen.toLowerCase().endsWith(".pdf") ? chosen : `${chosen}.pdf`;
  }
  await fs.writeFile(target, Buffer.from(data));
  return { name: path.basename(target), path: target };
});

ipcMain.handle("read-path", (_e, filePath) => readFileForRenderer(filePath));

ipcMain.handle("get-initial-file", async () => {
  if (!pendingFile) return null;
  const file = pendingFile;
  pendingFile = null;
  try {
    return await readFileForRenderer(file);
  } catch {
    return null;
  }
});

ipcMain.on("set-state", (_e, { dirty, title }) => {
  isDirty = !!dirty;
  if (mainWindow) {
    mainWindow.setTitle(title || APP_NAME);
    mainWindow.setDocumentEdited?.(isDirty);
  }
});

ipcMain.on("close-window", () => {
  forceClose = true;
  mainWindow?.close();
});

// ---- Ciclo de vida ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const file = findPdfArg(argv);
    if (file) openInWindow(file);
    else if (mainWindow) mainWindow.focus();
  });

  // macOS: arquivo aberto pelo Finder.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openInWindow(filePath);
  });

  app.whenReady().then(() => {
    app.setName(APP_NAME);
    registerAppProtocol();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
