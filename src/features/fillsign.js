// "Preencher e assinar": assinatura e iniciais (criadas na hora ou salvas
// neste aparelho), o menu do botão Assinar e o aviso de campos de formulário.
import { $, el, toast } from "../ui.js";
import { icon } from "../icons.js";
import * as platform from "../platform.js";
import { forgetSaved, fromSaved, getSaved, initialsOf, openSignatureDialog } from "../signature.js";

const TEXT = {
  signature: { title: "Assinatura", use: "Usar a assinatura salva", forget: "Apagar a assinatura salva", add: "Adicionar assinatura…", other: "Criar outra assinatura…" },
  initials: { title: "Iniciais", use: "Usar as iniciais salvas", forget: "Apagar as iniciais salvas", add: "Adicionar iniciais…", other: "Criar outras iniciais…" },
};

/** Assina com a assinatura (ou as iniciais) salva; se não houver, cria uma. */
export async function sign(app, kind = "signature") {
  if (!app.manager.active?.doc) return toast("Abra um documento primeiro.");
  const saved = getSaved(kind);
  if (saved) return app.tools.startSignature(fromSaved(kind, saved));
  return create(app, kind);
}

/** Cria uma assinatura (ou iniciais) nova e começa a posicioná-la na página. */
export async function create(app, kind = "signature") {
  if (!app.manager.active?.doc) return toast("Abra um documento primeiro.");
  const name = platform.savedUserName() || "";
  const signature = await openSignatureDialog({ kind, text: kind === "initials" ? initialsOf(name) : name });
  if (signature) await app.tools.startSignature(signature);
}

/** Monta o menu do botão Assinar: o que está salvo e as opções de criar. */
export function renderMenu() {
  const menu = $("#sign-menu");
  const section = (kind) => {
    const saved = getSaved(kind);
    const text = TEXT[kind];
    const items = [el("div", { class: "menu-title", text: text.title })];
    if (saved) {
      items.push(
        el("div", { class: "sig-saved" }, [
          el("button", { role: "menuitem", class: "sig-saved-use", title: text.use, dataset: { signUse: kind } }, [
            el("img", { src: saved.dataUrl, alt: text.use }),
          ]),
          el("button", { class: "btn icon-only small", title: text.forget, "aria-label": text.forget, dataset: { signForget: kind }, html: icon("trash") }),
        ]),
      );
    }
    items.push(
      el("button", { role: "menuitem", dataset: { signNew: kind }, html: `${icon(kind === "initials" ? "initials" : "sign")}<span>${saved ? text.other : text.add}</span>` }),
    );
    return items;
  };
  menu.replaceChildren(...section("signature"), el("div", { class: "menu-separator" }), ...section("initials"));
}

/** Liga os cliques do menu do botão Assinar. `close` fecha os menus abertos. */
export function setupMenu(app, close) {
  $("#sign-menu").addEventListener("click", (e) => {
    const forget = e.target.closest("[data-sign-forget]");
    if (forget) {
      e.stopPropagation();
      forgetSaved(forget.dataset.signForget);
      renderMenu();
      return;
    }
    const use = e.target.closest("[data-sign-use]");
    const add = e.target.closest("[data-sign-new]");
    if (!use && !add) return;
    close();
    if (use) sign(app, use.dataset.signUse);
    else create(app, add.dataset.signNew);
  });
}

/** Mostra o aviso quando o documento tem campos de formulário para preencher. */
export async function updateFormsHint(tab) {
  const hint = $("#fill-forms-hint");
  let hasFields = false;
  try {
    const fields = tab?.doc ? await tab.doc.getFieldObjects() : null;
    hasFields = Boolean(fields && Object.keys(fields).length);
  } catch {
    // Sem informação de campos: esconde o aviso.
  }
  hint.hidden = !hasFields;
}
