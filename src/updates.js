// Aviso de atualização dos apps desktop e Android. No desktop a versão nova é
// procurada pelo processo principal (electron/updater.cjs); no Android, nas
// Releases do GitHub (platform.js). Aqui aparecem o cartão com o andamento e
// os botões e o resultado da verificação pedida pelo menu Ajuda.
import { $, setBusy, toast } from "./ui.js";
import { isAndroid, isDesktop, updates } from "./platform.js";

const VIEWS = {
  checking: () => ({ title: "Procurando atualizações…", progress: null }),
  downloading: ({ version, percent = 0 }) => ({
    title: `Baixando a versão ${version}…`,
    text: `${percent}%`,
    progress: percent,
  }),
  available: ({ version }) => ({
    title: "Nova versão disponível",
    text: `A versão ${version} do PDF Acrobat já pode ser baixada.`,
    action: "Baixar",
  }),
  ready: ({ version, installOnQuit }) => ({
    title: "Atualização pronta",
    text: installOnQuit
      ? `A versão ${version} será instalada quando você fechar o programa.`
      : `A versão ${version} está pronta para ser instalada.`,
    action: "Reiniciar e atualizar",
  }),
  opened: () =>
    isAndroid
      ? {
          title: "Baixando a versão nova",
          text: "Salve os documentos abertos. Quando o download terminar, toque no arquivo baixado para instalar a atualização.",
        }
      : {
          title: "Instalador aberto",
          text: "Feche o PDF Acrobat e, na janela do instalador, arraste o app para a pasta Aplicativos, substituindo a versão antiga.",
          action: "Fechar o programa",
        },
};

// Avisos que aparecem mesmo sem o usuário ter pedido a verificação.
const NOTICES = new Set(["available", "ready", "opened"]);

/**
 * `closeDocuments` fecha os documentos abertos, pedindo para salvar os que
 * têm alterações; resolve false se o usuário cancelar. Retorna a função que
 * procura atualizações a pedido do usuário (menu Ajuda).
 */
export function setupUpdates({ closeDocuments }) {
  if (!isDesktop && !isAndroid) return () => {};
  const bar = $("#update-bar");
  const action = $(".update-action", bar);
  const progress = $(".update-progress", bar);
  let current = null;
  let dismissed = null;

  const keyOf = (status) => `${status.state}:${status.version}`;

  function show(status) {
    const view = VIEWS[status.state](status);
    $(".update-title", bar).textContent = view.title;
    $(".update-text", bar).textContent = view.text || "";
    progress.hidden = view.progress === undefined;
    if (view.progress === null) progress.removeAttribute("value");
    else if (view.progress !== undefined) progress.value = view.progress;
    action.hidden = !view.action;
    action.textContent = view.action || "";
    bar.hidden = false;
  }

  function render(status) {
    if (!status) return;
    current = status;
    if (status.state === "error") setBusy(false);
    if (VIEWS[status.state]) {
      if (dismissed !== keyOf(status) && (status.manual || NOTICES.has(status.state))) show(status);
      return;
    }
    // Fim de uma verificação: latest, unsupported ou error.
    if (!status.manual) return;
    bar.hidden = true;
    if (status.state === "latest") toast(`Você já está usando a versão mais recente (${status.version}).`);
    else toast(status.message, { duration: 7000 });
  }

  action.addEventListener("click", async () => {
    if (current?.state === "available") {
      updates.download();
      return;
    }
    if (!(await closeDocuments())) return;
    setBusy(current?.state === "opened" ? "Fechando…" : "Instalando a atualização…");
    updates.install();
  });

  $(".update-close", bar).addEventListener("click", () => {
    bar.hidden = true;
    if (current) dismissed = keyOf(current);
  });

  updates.onStatus(render);
  updates.getStatus().then((status) => status && NOTICES.has(status.state) && render(status));
  updates.autoCheck?.();

  return () => {
    dismissed = null;
    updates.check();
  };
}
