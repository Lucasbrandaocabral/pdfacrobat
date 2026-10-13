// Atualização automática a partir das versões publicadas no GitHub
// (electron-updater). O programa procura uma versão nova ao abrir e a cada
// 6 horas:
// - Windows e Linux: a versão nova é baixada em segundo plano e instalada ao
//   fechar o programa, ou na hora, pelo botão "Reiniciar e atualizar";
// - macOS: sem a assinatura paga da Apple o sistema recusa a instalação
//   automática, então o instalador (.dmg) é baixado e aberto para o usuário
//   arrastar o app para a pasta Aplicativos.
const { app, net, shell } = require("electron");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const FIRST_CHECK_DELAY = 10 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const RELEASES_URL = `${require("../package.json").homepage}/releases`;
const isMac = process.platform === "darwin";

// Estados que encerram uma verificação pedida pelo usuário.
const FINAL_STATES = new Set(["latest", "error", "unsupported", "available", "ready", "opened"]);
// Estados em que já existe uma versão nova encontrada.
const FOUND_STATES = new Set(["available", "downloading", "ready", "opened"]);

let updater = null;
let notify = () => {};
let status = { state: "idle" };
let latest = null; // informações da versão nova (arquivos e tag)
let following = false; // o usuário pediu a verificação e acompanha o andamento

function setStatus(next) {
  status = { ...next, manual: following };
  if (FINAL_STATES.has(next.state)) following = false;
  notify(status);
}

/** Registro em arquivo, para investigar falhas que acontecem sem ninguém ver. */
function fileLogger() {
  const file = path.join(app.getPath("logs"), "atualizacao.log");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024) fs.renameSync(file, `${file}.old`);
  } catch {
    // Sem registro: a atualização funciona do mesmo jeito.
  }
  const write = (level) => (message) => {
    const text = message instanceof Error ? message.stack || message.message : String(message);
    fs.appendFile(file, `${new Date().toISOString()} [${level}] ${text}\n`, () => {});
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** No pacote .deb o electron-builder grava o tipo de instalação. */
function isDebPackage() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim() === "deb";
  } catch {
    return false;
  }
}

function describeError(err, action) {
  const text = `${err?.code || ""} ${err?.message || err}`;
  let reason;
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text)) {
    reason = "Verifique a conexão com a internet e tente de novo.";
  } else if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/.test(text)) {
    reason = "A versão mais nova ainda está sendo preparada. Tente de novo em alguns minutos.";
  } else if (/ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS)/.test(text)) {
    reason = "Nenhuma versão publicada foi encontrada.";
  } else if (/sha512/i.test(text)) {
    reason = "O arquivo baixado veio corrompido. Tente de novo.";
  } else {
    reason = String(err?.message || err).split("\n")[0].slice(0, 200);
  }
  return `Não foi possível ${action}. ${reason}`;
}

function setup({ send }) {
  notify = send;
  ({ autoUpdater: updater } = require("electron-updater"));
  updater.logger = fileLogger();
  updater.autoDownload = !isMac;
  // No .deb a instalação pede a senha de administrador, então só acontece
  // quando o usuário clica em "Reiniciar e atualizar".
  updater.autoInstallOnAppQuit = !isMac && !isDebPackage();

  updater.on("checking-for-update", () => setStatus({ state: "checking" }));
  updater.on("update-not-available", () => setStatus({ state: "latest", version: app.getVersion() }));
  updater.on("update-available", (info) => {
    latest = info;
    setStatus(isMac ? { state: "available", version: info.version } : { state: "downloading", version: info.version, percent: 0 });
  });
  updater.on("download-progress", ({ percent }) => {
    const value = Math.floor(percent);
    if (status.state === "downloading" && value !== status.percent) setStatus({ ...status, percent: value });
  });
  updater.on("update-downloaded", (info) =>
    setStatus({ state: "ready", version: info.version, installOnQuit: updater.autoInstallOnAppQuit }),
  );
  updater.on("error", (err) => {
    const action =
      { downloading: "baixar a atualização", ready: "instalar a atualização" }[status.state] || "procurar atualizações";
    // Depois de uma falha no download ou na instalação a versão continua
    // conhecida: uma nova verificação tenta outra vez.
    setStatus({ state: "error", message: describeError(err, action) });
  });

  setTimeout(() => check(), FIRST_CHECK_DELAY);
  setInterval(() => check(), CHECK_INTERVAL);
}

/** Procura uma versão nova. `manual`: pedido pelo menu, mostra o andamento. */
function check({ manual = false } = {}) {
  if (!updater) return;
  if (manual) following = true;
  if (FOUND_STATES.has(status.state)) {
    // Uma versão nova já foi encontrada: só mostra de novo onde ela está.
    if (manual) setStatus(status);
    return;
  }
  updater
    .checkForUpdates()
    .then((result) => {
      if (result === null && manual) {
        setStatus({ state: "unsupported", message: "A atualização automática só funciona no programa instalado." });
      }
      // Falhas no download chegam pelo evento "error".
      result?.downloadPromise?.catch(() => {});
    })
    .catch(() => {});
}

/** macOS: baixa o instalador da versão nova e o abre. */
async function downloadInstaller() {
  if (status.state !== "available" || !latest) return;
  const { version, tag, files = [] } = latest;
  const arm = process.arch === "arm64" || app.runningUnderARM64Translation;
  const dmgs = files.filter((f) => f.url.endsWith(".dmg"));
  const file = dmgs.find((f) => f.url.includes("arm64") === arm) || dmgs[0];
  if (!file || !tag) {
    shell.openExternal(`${RELEASES_URL}/latest`);
    return;
  }
  following = true;
  setStatus({ state: "downloading", version, percent: 0 });
  try {
    const target = path.join(app.getPath("downloads"), path.basename(file.url));
    await download(`${RELEASES_URL}/download/${tag}/${file.url}`, target, file, (percent) => {
      if (percent !== status.percent) setStatus({ state: "downloading", version, percent });
    });
    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
    setStatus({ state: "opened", version });
  } catch (err) {
    setStatus({ state: "error", message: describeError(err, "baixar a atualização") });
    status = { state: "available", version };
  }
}

/** Baixa `url` para `target`, conferindo o SHA-512 publicado. */
async function download(url, target, expected, onProgress) {
  const response = await net.fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || expected.size || 0;
  const partial = `${target}.download`;
  const hash = createHash("sha512");
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          received += chunk.length;
          if (total) onProgress(Math.min(100, Math.floor((received / total) * 100)));
          done(null, chunk);
        },
      }),
      fs.createWriteStream(partial),
    );
    if (expected.sha512 && hash.digest("base64") !== expected.sha512) throw new Error("sha512 checksum mismatch");
    await fs.promises.rename(partial, target);
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
}

/**
 * Instala a versão baixada e reinicia o programa. A interface já tratou os
 * documentos com alterações não salvas antes de pedir.
 */
function install() {
  // macOS: fecha o programa para o usuário trocar o app pelo novo.
  if (status.state === "opened") return app.quit();
  if (status.state !== "ready") return;
  following = true; // uma falha na instalação é mostrada ao usuário
  const appImage = process.env.APPIMAGE;
  let newAppImage = appImage;
  let failed = false;
  const onRenamed = (file) => (newAppImage = file);
  const onError = () => (failed = true);
  updater.on("appimage-filename-updated", onRenamed);
  updater.on("error", onError);
  // No AppImage o arquivo é trocado agora; nos demais o próprio instalador
  // reabre o programa depois de instalar.
  updater.quitAndInstall(true, !appImage);
  updater.off("appimage-filename-updated", onRenamed);
  updater.off("error", onError);
  if (appImage && !failed) openWhenClosed(newAppImage);
}

/**
 * Abre o AppImage novo assim que este processo terminar (por até 1 minuto).
 * Quem espera é um shell de fora do AppImage, que continua de pé quando o
 * AppImage antigo é desmontado; esperar evita que a versão nova encontre a
 * antiga ainda aberta e desista (o programa só abre uma instância).
 */
function openWhenClosed(file) {
  const wait = 'i=0; while kill -0 "$0" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.3; i=$((i+1)); done';
  // O shell herda arquivos e conexões abertos por este processo, entre eles o
  // que mantém o AppImage antigo montado; o bash os fecha antes de abrir o novo.
  const closeInherited = 'for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd<&-"; done';
  const bash = fs.existsSync("/bin/bash");
  const script = bash ? `${wait}; ${closeInherited}; exec "$@"` : `${wait}; exec "$@"`;
  spawn(bash ? "/bin/bash" : "/bin/sh", ["-c", script, String(process.pid), file, ...process.argv.slice(1)], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

module.exports = {
  setup,
  check,
  downloadInstaller,
  install,
  getStatus: () => status,
};
