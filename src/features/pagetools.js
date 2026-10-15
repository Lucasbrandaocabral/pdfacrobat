// Remover páginas numa tela de miniaturas: clicar nas que vão sair (ou digitar
// os números) e tirar todas de uma vez. Desfazer traz de volta.
import { $, $$, UserError, debounce, parsePageRange, toast } from "../ui.js";
import { Perm } from "../pdf/security.js";
import * as ops from "../pdf/ops.js";
import { PageThumbs, pagesText, pickGrid } from "../thumbs.js";

let dialog = null;
let form = null;
let grid = null;
let s = null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function setup() {
  if (dialog) return;
  dialog = $("#remove-tool");
  form = $("form", dialog);
  grid = $("[data-grid]", dialog);
  $("[data-tool-close]", dialog).addEventListener("click", () => dialog.close());
  $("[data-go]", dialog).addEventListener("click", go);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.elements.pages.addEventListener("input", debounce(readField, 200));
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      readField();
    }
  });
  for (const button of $$("[data-pick]", dialog)) {
    button.addEventListener("click", () => {
      s.marked.clear();
      if (button.dataset.pick !== "none") {
        for (let i = button.dataset.pick === "odd" ? 0 : 1; i < s.total; i += 2) s.marked.add(i);
      }
      chosen();
    });
  }
  dialog.addEventListener("close", () => {
    s?.thumbs.dispose();
    grid.replaceChildren();
    s = null;
  });
}

/** Abre a tela com a página atual já marcada. */
export async function removePages(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  setup();
  const total = tab.doc.numPages;
  s = { app, tab, total, thumbs: new PageThumbs(tab.doc, grid), marked: new Set([tab.viewer.currentPageNumber - 1]), error: null };
  $("[data-doc]", dialog).textContent = `${tab.name} · ${plural(total, "página", "páginas")}`;
  dialog.showModal();
  s.sync = pickGrid(grid, s.thumbs, total, { chosen: s.marked, mark: "removed", badge: "trash", onChange: chosen });
  chosen();
  // Começa mostrando a página marcada.
  grid.querySelector(".page-card.removed")?.scrollIntoView({ block: "center" });
}

/** A seleção mudou pelas miniaturas ou pelos botões: atualiza o campo e o aviso. */
function chosen() {
  form.elements.pages.value = pagesText([...s.marked].sort((a, b) => a - b));
  s.error = null;
  s.sync();
  showInfo();
}

function readField() {
  if (!s) return;
  const text = form.elements.pages.value;
  s.error = null;
  s.marked.clear();
  if (text.trim()) {
    try {
      parsePageRange(text, s.total).forEach((i) => s.marked.add(i));
    } catch (err) {
      s.error = err.userMessage || err.message;
    }
  }
  s.sync();
  showInfo();
}

function showInfo() {
  const box = $(".tool-info", dialog);
  const n = s.marked.size;
  let text = "";
  let error = s.error;
  if (!error && n === s.total) error = "Não dá para remover todas as páginas: um PDF precisa de pelo menos uma.";
  if (!error) {
    text = n
      ? `${plural(n, "página vai sair", "páginas vão sair")}; o documento fica com ${plural(s.total - n, "página", "páginas")}. Dá para desfazer depois.`
      : "Clique nas páginas que vão sair do documento.";
  }
  box.textContent = error || text;
  box.classList.toggle("error", Boolean(error));
  $("[data-go]", dialog).disabled = Boolean(error) || !n;
  $("[data-go] span", dialog).textContent = n ? `Remover ${plural(n, "página", "páginas")}` : "Remover páginas";
}

async function go() {
  if (!s || !s.marked.size || s.error || s.marked.size >= s.total) return;
  const { app, tab, total } = s;
  const indices = [...s.marked].sort((a, b) => a - b);
  dialog.close();
  // Depois de remover, mostra a página que ficou no lugar da primeira removida.
  const page = Math.min(indices[0] + 1, total - indices.length);
  const done = await app.run("Removendo páginas…", async () => {
    await tab.edit((doc) => ops.deletePages(doc, indices), { keepView: false, page });
    return true;
  });
  if (done) toast(`${plural(indices.length, "página removida", "páginas removidas")}. Para trazer de volta, use Desfazer.`, { duration: 6000 });
}
