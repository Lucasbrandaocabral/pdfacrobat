// Botão direito na página, fora da ferramenta de editar (lá o menu é o dos
// objetos, em objectsel.js): com texto selecionado, copiar, destacar,
// sublinhar, tachar, localizar e substituir; em qualquer ponto, nota ou
// texto ali, editar, girar a página, imprimir e zoom. No programa de
// computador não há outro menu: sem este, o botão direito não fazia nada.
import { $, popupMenu, toast } from "./ui.js";
import { icon } from "./icons.js";
import { Perm } from "./pdf/security.js";

/**
 * `app`: o app (manager, tools, guard). `actions`: { run(name) (ações da barra),
 * find(text) (localizar no documento), setCategory(name), pasteImageAt(hit)
 * (cola a imagem copiada no ponto) }.
 */
export function setupContextMenu(app, { run, find, setCategory, pasteImageAt }) {
  const area = $("#viewer-area");
  area.addEventListener("contextmenu", (e) => {
    const tab = app.manager.active;
    const tools = app.tools;
    // Na ferramenta de editar, o menu é o dos objetos; nos campos e caixas, o do sistema.
    if (!tab?.doc || tools.tool === "edit" || tools.pending || tools.editing) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], .text-box, .image-box, .float-bar, .annotationEditorLayer .selectedEditor")) return;
    const hit = tools.pageHit(e);
    if (!hit) return;
    e.preventDefault();

    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const text = range && !selection.isCollapsed && tab.container.contains(range.commonAncestorContainer) ? selection.toString().replace(/\s+/g, " ").trim() : "";
    const item = (name, label, onclick, hint = "") => ({ icon: icon(name), label, hint, onclick });
    const mark = (kind) => async () => {
      if (!(await app.guard(tab, Perm.ANNOTATE, "comentar"))) return;
      await tools.markSelection(kind);
    };
    const short = text.length > 24 ? `${text.slice(0, 22)}…` : text;

    const items = [];
    if (text) {
      items.push(
        item("copy", "Copiar", () => {
          // Passa pela mesma regra do Ctrl+C (documentos que não permitem copiar).
          if (!document.execCommand("copy")) toast("Não foi possível copiar o texto.");
        }, "Ctrl+C"),
        item("highlight", "Destacar", mark("Highlight")),
        item("underline", "Sublinhar", mark("Underline")),
        item("strike", "Tachar", mark("StrikeOut")),
        "-",
        item("search", `Localizar “${short}”`, () => find(text)),
        item("replace", "Substituir no documento…", () => run("replace-text"), "Ctrl+H"),
        "-",
      );
    }
    items.push(
      item("image", "Colar imagem aqui", () => pasteImageAt(hit), "Ctrl+V"),
      item("note", "Adicionar nota aqui", async () => {
        if (!(await app.guard(tab, Perm.ANNOTATE, "comentar"))) return;
        await tools.addNote(hit);
      }),
      item("addText", "Adicionar texto aqui", async () => {
        setCategory("edit");
        await tools.select("addtext");
        if (tools.tool === "addtext") await tools.addTextAt(hit);
      }),
      item("editText", "Editar texto e imagens", () => {
        setCategory("edit");
        tools.select("edit");
      }),
      "-",
      item("rotateCw", "Girar esta página ↻", () => {
        tab.viewer.currentPageNumber = hit.pageNumber;
        run("rotate-cw");
      }),
      item("print", "Imprimir", () => run("print"), "Ctrl+P"),
      item("zoomIn", "Mais zoom", () => run("zoom-in"), "Ctrl +"),
      item("zoomOut", "Menos zoom", () => run("zoom-out"), "Ctrl −"),
      "-",
      item("command", "Buscar um comando…", () => run("commands"), "Ctrl+K"),
    );
    popupMenu(items, { x: e.clientX, y: e.clientY });
  });
}
