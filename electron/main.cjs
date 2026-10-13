// Processo principal do Electron: janela, menus, diálogos de arquivo e
// integração com o sistema operacional (abrir PDFs com duplo clique).
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Ao instalar uma atualização do AppImage, o atualizador executa a versão
// nova só para concluir a instalação: ela deve sair sem abrir a janela.
if (process.env.APPIMAGE_EXIT_AFTER_INSTALL === "true") process.exit(0);

const updater = require("./updater.cjs");

const APP_NAME = "PDF Acrobat";
const PDF_FILTER = { name: "Documentos PDF", extensions: ["pdf"] };
const DIST_DIR = path.join(__dirname, "..", "dist");

// A interface é servida por um protocolo próprio (app://) em vez de file://,
// para que módulos ES, workers e fetch() funcionem normalmente.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol() {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.normalize(path.join(DIST_DIR, decodeURIComponent(pathname)));
    if (!filePath.startsWith(DIST_DIR + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

let mainWindow = null;
let isDirty = false;
let forceClose = false;
let pendingFiles = findPdfArgs(process.argv);

function findPdfArgs(argv) {
  return argv.slice(1).filter((a) => a.toLowerCase().endsWith(".pdf") && !a.startsWith("-"));
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
    pendingFiles.push(filePath);
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
    width: 1320,
    height: 880,
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

  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else mainWindow.loadURL("app://pdfacrobat/index.html");

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
      detail: "Há documentos com alterações não salvas. Se você não salvar, elas serão perdidas.",
    });
    if (response === 0) {
      send("menu", "save-all-and-close");
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
  const sep = { type: "separator" };

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Arquivo",
      submenu: [
        item("Abrir…", "open", "CmdOrCtrl+O"),
        item("Criar PDF a partir de imagens…", "create-from-images"),
        item("Combinar arquivos…", "combine"),
        item("Comparar arquivos…", "compare"),
        sep,
        item("Salvar", "save", "CmdOrCtrl+S"),
        item("Salvar como…", "save-as", "CmdOrCtrl+Shift+S"),
        item("Fechar documento", "close-tab", "CmdOrCtrl+W"),
        sep,
        item("Imprimir…", "print", "CmdOrCtrl+P"),
        item("Propriedades do documento", "properties", "CmdOrCtrl+D"),
        sep,
        isMac ? { role: "close", label: "Fechar janela" } : { role: "quit", label: "Sair" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        item("Desfazer", "undo", "CmdOrCtrl+Z"),
        item("Refazer", "redo", "CmdOrCtrl+Y"),
        sep,
        { role: "copy", label: "Copiar" },
        { role: "selectAll", label: "Selecionar tudo" },
        sep,
        item("Localizar…", "find", "CmdOrCtrl+F"),
        sep,
        item("Nome do autor dos comentários…", "author-name"),
      ],
    },
    {
      label: "Exibir",
      submenu: [
        item("Mais zoom", "zoom-in", "CmdOrCtrl+="),
        item("Menos zoom", "zoom-out", "CmdOrCtrl+-"),
        item("Ajustar à largura", "fit-width"),
        item("Página inteira", "fit-page"),
        sep,
        item("Painel lateral", "toggle-sidebar", "F4"),
        item("Próximo documento", "next-tab", "Ctrl+Tab"),
        item("Documento anterior", "prev-tab", "Ctrl+Shift+Tab"),
        sep,
        { role: "togglefullscreen", label: "Tela cheia" },
        { role: "toggleDevTools", label: "Ferramentas do desenvolvedor" },
      ],
    },
    {
      label: "Comentar",
      submenu: [
        item("Destacar texto", "tool:highlight", "H"),
        item("Sublinhar texto", "tool:underline", "U"),
        item("Tachar texto", "tool:strike", "K"),
        item("Nota", "tool:note", "N"),
        item("Adicionar texto", "tool:text", "T"),
        item("Desenhar", "tool:ink", "D"),
        sep,
        item("Retângulo", "shape:rect"),
        item("Elipse", "shape:ellipse"),
        item("Linha", "shape:line"),
        item("Seta", "shape:arrow"),
        item("Carimbo…", "tool:stamp"),
        sep,
        item("Assinar (desenho ou nome)", "tool:sign"),
      ],
    },
    {
      label: "Ferramentas",
      submenu: [
        item("Editar texto e imagens", "tool:edit", "E"),
        item("Adicionar imagem", "tool:image"),
        item("Marca d'água…", "watermark"),
        item("Cabeçalho, rodapé e numeração…", "header-footer"),
        sep,
        {
          label: "Páginas",
          submenu: [
            item("Girar para a direita", "rotate-cw"),
            item("Girar para a esquerda", "rotate-ccw"),
            item("Excluir página", "delete-page"),
            item("Inserir página em branco", "blank-page"),
            item("Inserir arquivo…", "insert-files"),
            item("Extrair páginas…", "extract"),
            item("Dividir documento…", "split"),
          ],
        },
        {
          label: "Proteger",
          submenu: [
            item("Proteger com senha…", "protect"),
            item("Remover senha", "unprotect"),
            item("Assinatura digital com certificado…", "cert-sign"),
          ],
        },
        {
          label: "Converter",
          submenu: [
            item("Em imagens (PNG/JPG)…", "export-images"),
            item("Em texto (.txt)", "export-text"),
            item("Em Word (.docx)", "export-word"),
          ],
        },
        sep,
        item("Comprimir PDF…", "compress"),
        item("Reconhecer texto (OCR)…", "ocr"),
      ],
    },
    {
      label: "Ajuda",
      submenu: [
        item("Verificar atualizações…", "check-updates"),
        sep,
        {
          label: "Sobre o PDF Acrobat",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              title: APP_NAME,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                "Leitor e editor de PDF.\nRenderização: PDF.js (Mozilla) · Edição: pdf-lib · OCR: Tesseract · Interface: Electron (Chromium).",
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 2; ; n++) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base} (${n})${ext}`);
    } catch {
      return candidate;
    }
  }
}

// ---- IPC: chamado pela interface via preload.cjs ----

ipcMain.handle("open-dialog", async (_e, { multiple = false, filters = [PDF_FILTER] } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: filters.filter(Boolean),
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(readFileForRenderer));
});

ipcMain.handle("save-file", async (_e, { data, filePath, suggestedName, saveAs, filter }) => {
  let target = filePath;
  const chosenFilter = filter || PDF_FILTER;
  if (saveAs || !target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: target || suggestedName || "documento.pdf",
      filters: [chosenFilter],
    });
    if (canceled || !chosen) return null;
    const ext = `.${chosenFilter.extensions[0]}`;
    target = chosenFilter.extensions.some((e) => chosen.toLowerCase().endsWith(`.${e}`)) ? chosen : `${chosen}${ext}`;
  }
  await fs.writeFile(target, Buffer.from(data));
  return { name: path.basename(target), path: target };
});

ipcMain.handle("pick-directory", async (_e, { title } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("write-files", async (_e, { dir, files }) => {
  const written = [];
  for (const file of files) {
    const target = await uniquePath(dir, path.basename(file.name));
    await fs.writeFile(target, Buffer.from(file.data));
    written.push(target);
  }
  return written;
});

ipcMain.handle("read-path", (_e, filePath) => readFileForRenderer(filePath));

ipcMain.handle("get-user-name", () => {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
});

ipcMain.on("add-recent", (_e, filePath) => {
  if (filePath) app.addRecentDocument(filePath);
});

ipcMain.handle("get-initial-file", async () => {
  const files = pendingFiles;
  pendingFiles = [];
  const loaded = [];
  for (const file of files) {
    try {
      loaded.push(await readFileForRenderer(file));
    } catch {
      // Arquivo inexistente ou sem permissão: ignora.
    }
  }
  return loaded;
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

ipcMain.handle("update-status", () => updater.getStatus());
ipcMain.on("update-check", () => updater.check({ manual: true }));
ipcMain.on("update-download", () => updater.downloadInstaller());
ipcMain.on("update-install", () => updater.install());

// ---- Ciclo de vida ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const files = findPdfArgs(argv);
    if (files.length) files.forEach(openInWindow);
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
    updater.setup({ send: (status) => send("update-status", status) });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
