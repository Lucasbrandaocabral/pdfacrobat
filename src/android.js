// Só no app Android: o botão "voltar" do sistema fecha primeiro o que estiver
// por cima (janela, menu, edição, painel lateral) e, sem nada aberto, deixa o
// app em segundo plano com os documentos como estão.
import { App } from "@capacitor/app";
import { $$ } from "./ui.js";

export function setupAndroid(app) {
  App.addListener("backButton", () => {
    const dialog = document.querySelector("dialog[open]");
    if (dialog) return dialog.close("cancel");
    const menus = $$(".menu:not([hidden])");
    if (menus.length) return menus.forEach((menu) => (menu.hidden = true));
    const tools = app.tools;
    if (tools.pending) return tools.resolvePending(null);
    if (tools.editing) return tools.clearEdit();
    if (tools.tool !== "select") return tools.apply("select");
    // No celular o painel de miniaturas cobre boa parte da tela.
    if (app.sidebar.visible && window.innerWidth < 700) return app.sidebar.toggle(false);
    App.minimizeApp();
  });
}
