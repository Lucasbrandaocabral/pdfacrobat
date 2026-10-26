// Processo principal do Electron: janela, menus, diálogos de arquivo e
// integração com o sistema operacional (abrir PDFs com duplo clique).
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, session, shell } = require("electron");
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

/**
 * Arquivo de estado na pasta do usuário, lido ao abrir o programa e regravado
 * a cada mudança. Uma gravação por vez: as mudanças feitas durante uma
 * gravação (vários arquivos abertos de uma vez, por exemplo) saem juntas na
 * seguinte, em vez de uma escrita no disco para cada. E nada é gravado antes
 * de a leitura terminar, para não gravar por cima o que ainda não foi lido.
 */
function stateFile(name, serialize) {
  const file = () => path.join(app.getPath("userData"), name);
  let loading = Promise.resolve();
  let changed = false;
  let writing = false;
  return {
    load() {
      loading = fs
        .readFile(file(), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      return loading;
    },
    async save() {
      changed = true;
      if (writing) return;
      writing = true;
      await loading;
      while (changed) {
        changed = false;
        await fs.writeFile(file(), serialize()).catch(() => {});
      }
      writing = false;
    },
  };
}

// Pasta usada por último nos diálogos de abrir e salvar. Sem uma pasta
// indicada, os diálogos abrem sempre em Downloads (desde o Electron 43), então
// o programa guarda a última, inclusive entre uma vez e outra que é aberto.
let lastDir;
const lastDirState = stateFile("ultima-pasta.json", () => JSON.stringify({ dir: lastDir }));

async function loadLastDir() {
  const saved = await lastDirState.load();
  // Primeira vez ou arquivo ilegível: os diálogos abrem em Downloads. Uma
  // pasta usada enquanto o arquivo era lido vale mais que a guardada.
  lastDir ??= saved?.dir || undefined;
}

function rememberDir(dir) {
  if (!dir || dir === lastDir) return;
  lastDir = dir;
  lastDirState.save();
}

function findPdfArgs(argv) {
  return argv.slice(1).filter((a) => a.toLowerCase().endsWith(".pdf") && !a.startsWith("-"));
}

async function readFileForRenderer(filePath) {
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
}

// ---- Arquivos que a interface pode ler e gravar ----
// A interface só lê e grava arquivos que a pessoa escolheu: na janela de abrir
// ou de salvar, arrastando para a janela ou abrindo pelo sistema (duplo
// clique). A lista fica aqui, fora do alcance da interface, e é guardada entre
// uma vez e outra que o programa abre, para os recentes. Assim, nem um PDF que
// conseguisse rodar código na interface leria ou gravaria outros arquivos.
const MAX_CHOSEN = 300;
let chosen = new Set();
const chosenState = stateFile("arquivos-escolhidos.json", () => JSON.stringify([...chosen]));
// Pastas escolhidas nesta sessão para gravar vários arquivos.
const chosenDirs = new Set();

async function loadChosen() {
  const list = await chosenState.load();
  // Primeira vez ou arquivo ilegível: a lista começa vazia.
  if (!Array.isArray(list)) return;
  // Os escolhidos enquanto a lista era lida ficam no fim, como os mais recentes.
  const saved = new Set(list.filter((p) => typeof p === "string"));
  for (const full of chosen) {
    saved.delete(full);
    saved.add(full);
  }
  chosen = saved;
  trimChosen();
}

function trimChosen() {
  while (chosen.size > MAX_CHOSEN) chosen.delete(chosen.values().next().value);
}

/** Registra um arquivo escolhido pela pessoa e devolve o caminho absoluto. */
function choose(filePath) {
  const full = path.resolve(filePath);
  chosen.delete(full);
  chosen.add(full);
  trimChosen();
  chosenState.save();
  return full;
}

const isChosen = (filePath) => typeof filePath === "string" && filePath !== "" && chosen.has(path.resolve(filePath));

// Só a página do próprio app (app://pdfacrobat) fala com o processo principal.
function fromApp(event) {
  const url = event.senderFrame?.url || "";
  return url.startsWith("app://pdfacrobat/") || (!app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL) && url.startsWith(process.env.VITE_DEV_SERVER_URL));
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// Arquivos abertos pelo sistema com o programa já aberto: um de cada vez, na
// ordem em que chegaram (lidos ao mesmo tempo, disputariam o disco).
let opening = Promise.resolve();

function openInWindow(filePath) {
  opening = opening.then(() => openFromSystem(filePath)).catch(() => {});
}

async function openFromSystem(filePath) {
  if (!mainWindow) {
    pendingFiles.push(filePath);
    return;
  }
  try {
    send("open-file", await readFileForRenderer(choose(filePath)));
  } catch (err) {
    // O aviso aparece na janela do app, com a cara dele.
    send("notice", { kind: "error", title: "Não foi possível abrir o arquivo", message: `${path.basename(filePath)}: ${err.message}` });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createWindow() {
  // Janela nova (no Mac, depois de fechar a anterior pelo Dock): volta a perguntar antes de fechar com alterações.
  forceClose = false;
  isDirty = false;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 760,
    minHeight: 500,
    title: APP_NAME,
    // A mesma cor do fundo do app (claro ou escuro), para não piscar ao abrir.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#131316" : "#f4f4f6",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // O servidor de desenvolvimento só vale rodando do código-fonte, nunca no app instalado.
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else mainWindow.loadURL("app://pdfacrobat/index.html");

  // Links externos abrem no navegador padrão, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  // Com documentos alterados, quem pergunta se quer salvar é a interface do app
  // (Salvar / Não salvar / Cancelar); ela fecha a janela pelo "close-window".
  mainWindow.on("close", (event) => {
    if (forceClose || !isDirty) return;
    event.preventDefault();
    send("menu", "confirm-close");
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
        // No app instalado não há ferramentas do desenvolvedor (alguém poderia
        // pedir para colar um código ali e mexer nos arquivos pelo app).
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools", label: "Ferramentas do desenvolvedor" }]),
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
      ],
    },
    {
      label: "Ferramentas",
      submenu: [
        {
          label: "Preencher e assinar",
          submenu: [
            item("Adicionar texto", "tool:text"),
            item("Marca de seleção (✓)", "mark:check"),
            item("Cruz (✗)", "mark:cross"),
            item("Ponto (●)", "mark:dot"),
            item("Data de hoje", "mark:date"),
            sep,
            item("Assinar…", "sign"),
            item("Adicionar iniciais…", "sign-initials"),
            item("Assinatura digital com certificado…", "cert-sign"),
          ],
        },
        sep,
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
            item("Excluir páginas…", "delete-page"),
            item("Recortar páginas…", "crop"),
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
            sep,
            item("Tarjar informações…", "redact"),
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
        item("Reparar PDF…", "repair"),
        item("Reconhecer texto (OCR)…", "ocr"),
      ],
    },
    {
      label: "Ajuda",
      submenu: [
        item("Novidades", "news"),
        item("Verificar atualizações…", "check-updates"),
        sep,
        item("Sobre o PDF Acrobat", "about"),
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
    defaultPath: lastDir,
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: filters.filter(Boolean),
  });
  if (canceled || !filePaths.length) return [];
  rememberDir(path.dirname(filePaths[0]));
  // Um arquivo de cada vez: num HD, ler vários ao mesmo tempo faz o disco
  // pular de um para outro e demora mais do que em sequência.
  const files = [];
  for (const filePath of filePaths.map(choose)) files.push(await readFileForRenderer(filePath));
  return files;
});

ipcMain.handle("save-file", async (event, { data, filePath, suggestedName, saveAs, filter }) => {
  if (!fromApp(event)) return null;
  let target = filePath;
  const chosenFilter = filter || PDF_FILTER;
  // Gravar por cima sem perguntar só no arquivo que a pessoa escolheu; outro caminho passa pela janela de salvar.
  if (saveAs || !isChosen(target)) {
    const name = suggestedName || "documento.pdf";
    const { canceled, filePath: picked } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: target || (lastDir ? path.join(lastDir, name) : name),
      filters: [chosenFilter],
    });
    if (canceled || !picked) return null;
    const ext = `.${chosenFilter.extensions[0]}`;
    target = chosenFilter.extensions.some((e) => picked.toLowerCase().endsWith(`.${e}`)) ? picked : `${picked}${ext}`;
  }
  target = choose(target);
  await writeSafely(target, Buffer.from(data));
  rememberDir(path.dirname(target));
  return { name: path.basename(target), path: target };
});

/**
 * Grava num arquivo temporário ao lado e só então troca o arquivo: se o app
 * fechar ou faltar espaço no meio, o documento antigo continua inteiro. O novo
 * fica com as permissões do antigo; um atalho (link) continua apontando para
 * o mesmo arquivo.
 */
async function writeSafely(target, data) {
  const real = await fs.realpath(target).catch(() => target);
  const mode = await fs
    .stat(real)
    .then((s) => s.mode & 0o777)
    .catch(() => null);
  const temp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, data);
    if (mode !== null) await fs.chmod(temp, mode);
    await fs.rename(temp, real);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

ipcMain.handle("pick-directory", async (_e, { title } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: lastDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths.length) return null;
  rememberDir(filePaths[0]);
  chosenDirs.add(path.resolve(filePaths[0]));
  return filePaths[0];
});

ipcMain.handle("write-files", async (event, { dir, files }) => {
  // Só na pasta que a pessoa acabou de escolher.
  if (!fromApp(event) || typeof dir !== "string" || !chosenDirs.has(path.resolve(dir))) throw new Error("Pasta não escolhida.");
  const written = [];
  for (const file of files) {
    const target = await uniquePath(dir, path.basename(file.name));
    await fs.writeFile(target, Buffer.from(file.data));
    written.push(target);
  }
  return written;
});

ipcMain.handle("read-path", async (event, filePath) => {
  if (!fromApp(event) || typeof filePath !== "string") return null;
  if (isChosen(filePath)) return readFileForRenderer(path.resolve(filePath));
  // Fora da lista (um recente de antes desta versão, por exemplo): a pessoa
  // confirma o arquivo na janela de abrir, que já vem nele.
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    defaultPath: filePath,
    properties: ["openFile"],
    filters: [PDF_FILTER],
  });
  if (canceled || !filePaths.length) return null;
  rememberDir(path.dirname(filePaths[0]));
  return readFileForRenderer(choose(filePaths[0]));
});

// Arquivo arrastado para a janela (ou escolhido num campo de arquivo): o preload
// só manda o caminho que o próprio Electron deu para o arquivo de verdade.
ipcMain.on("choose-dropped", (event, filePath) => {
  if (fromApp(event) && typeof filePath === "string" && filePath) choose(filePath);
});

ipcMain.handle("get-user-name", () => {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
});

ipcMain.on("add-recent", (_e, filePath) => {
  if (isChosen(filePath)) app.addRecentDocument(path.resolve(filePath));
});

ipcMain.handle("get-initial-file", async () => {
  const files = pendingFiles;
  pendingFiles = [];
  const loaded = [];
  for (const file of files) {
    try {
      loaded.push(await readFileForRenderer(choose(file)));
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

// ---- Impressão direta ----
// A interface monta as folhas num PDF; ele abre numa janela escondida, no
// visualizador de PDF do Chromium, e vai direto para a impressora escolhida,
// sem a janela de impressão do sistema. Assim a impressão sai vetorial.

// Bit de printer-type que o CUPS (Linux e macOS) usa para a impressora padrão.
const CUPS_DEFAULT_PRINTER = 0x20000;

ipcMain.handle("list-printers", async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    isDefault: (Number(p.options?.["printer-type"]) & CUPS_DEFAULT_PRINTER) !== 0,
  }));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Antes de o visualizador terminar de abrir o documento, a impressão sai em branco.
const PDF_VIEWER_STATE = `(() => {
  const viewer = document.querySelector("pdf-viewer");
  return viewer ? ("loadState_" in viewer ? String(viewer.loadState_) : "unknown") : "";
})()`;

async function waitForPdfViewer(contents) {
  const start = Date.now();
  let unknownSince = 0;
  while (Date.now() - start < 60_000) {
    const frame = contents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("chrome-extension://"));
    const state = frame ? await frame.executeJavaScript(PDF_VIEWER_STATE).catch(() => "") : "";
    if (state === "success") return;
    if (state === "failed") throw new Error("O visualizador de PDF não abriu as folhas.");
    // Visualizador de outra versão do Chromium, sem esse estado: dá um tempo e segue.
    if (state === "unknown") {
      unknownSince ||= Date.now();
      if (Date.now() - unknownSince > 3000) return;
    }
    await wait(50);
  }
  throw new Error("O visualizador de PDF demorou demais para abrir as folhas.");
}

const PAGE_SIZES = new Set(["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Legal", "Letter", "Tabloid"]);

function printOptions(o) {
  const options = {
    silent: true,
    printBackground: true,
    margins: { marginType: "none" },
    copies: Math.min(999, Math.max(1, Math.round(Number(o.copies) || 1))),
    collate: o.collate !== false,
    color: o.color !== false,
    landscape: Boolean(o.landscape),
    duplexMode: ["simplex", "shortEdge", "longEdge"].includes(o.duplexMode) ? o.duplexMode : "simplex",
  };
  if (typeof o.deviceName === "string" && o.deviceName) options.deviceName = o.deviceName;
  // Papel com nome conhecido ou medidas em mícrons.
  if (PAGE_SIZES.has(o.pageSize)) options.pageSize = o.pageSize;
  else if (o.pageSize?.width > 0 && o.pageSize?.height > 0) options.pageSize = { width: Math.round(o.pageSize.width), height: Math.round(o.pageSize.height) };
  return options;
}

// O nome do arquivo vira o nome do trabalho na fila da impressora.
function jobFileName(name) {
  const clean = String(name || "documento").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(-120);
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
}

ipcMain.handle("print-pdf", async (_e, request) => {
  const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "pdfacrobat-impressao-"));
  const file = path.join(dir, jobFileName(request.name));
  await fs.writeFile(file, Buffer.from(request.data));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    await win.loadFile(file);
    await waitForPdfViewer(win.webContents);
    return await new Promise((resolve) => {
      win.webContents.print(printOptions(request), (ok, reason) => resolve({ ok, reason: reason || "" }));
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    win.destroy();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle("update-status", () => updater.getStatus());
ipcMain.on("update-check", () => updater.check({ manual: true }));
ipcMain.on("update-download", () => updater.downloadInstaller());
ipcMain.on("update-install", () => updater.install());

// ---- Ciclo de vida ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, workingDirectory) => {
    // Caminho relativo é da pasta de onde a outra instância foi aberta.
    const files = findPdfArgs(argv).map((file) => path.resolve(workingDirectory || "", file));
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
    loadLastDir();
    loadChosen();
    // O app não usa câmera, microfone, localização nem notificações: nenhuma página pode pedir.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
