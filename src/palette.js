// Busca de comandos (Ctrl+K): digitar o nome de uma ferramenta ("tarjar",
// "dividir", "senha") e ir direto a ela, sem procurar nas categorias. A lista
// vem dos próprios botões da barra, então nada novo precisa ser cadastrado.
import { $, $$, el } from "./ui.js";

const plain = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Os comandos: os botões das categorias e os da barra de cima. */
function commands() {
  const list = [];
  const add = (button, group, panel) => {
    if (button.classList.contains("caret")) return;
    const label = button.textContent.trim() || (button.title || "").replace(/\s*\(.*\)\s*$/, "");
    if (!label) return;
    const title = button.title && button.title !== label ? button.title : "";
    list.push({ button, panel, label, group, key: plain(`${label} ${title} ${group}`) });
  };
  for (const panel of $$(".tools[data-panel]")) {
    const group = $(`[data-category="${panel.dataset.panel}"]`)?.textContent.trim() || "";
    for (const button of $$("[data-action], [data-tool]", panel)) add(button, group, panel.dataset.panel);
  }
  for (const button of $$(".topbar [data-action]")) add(button, "", null);
  return list;
}

/** `setCategory(name)` mostra uma categoria da barra. Devolve a função que abre a busca. */
export function setupPalette({ setCategory }) {
  const dialog = $("#palette-dialog");
  const input = $("input", dialog);
  const results = $(".palette-list", dialog);
  let shown = [];
  let active = 0;

  const paint = () => {
    results.replaceChildren(
      ...shown.map((command, i) =>
        el(
          "button",
          { class: `palette-item${i === active ? " active" : ""}`, type: "button", role: "option", "aria-selected": String(i === active), onclick: () => run(command) },
          [el("span", { class: "palette-label", text: command.label }), el("span", { class: "palette-group", text: command.group })],
        ),
      ),
    );
    if (!shown.length) results.append(el("p", { class: "muted small palette-empty", text: "Nenhum comando com esse nome." }));
    results.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const filter = () => {
    const words = plain(input.value).split(/\s+/).filter(Boolean);
    const inName = (command) => Number(words.some((word) => plain(command.label).includes(word)));
    shown = commands()
      // Sem documento aberto, os botões que precisam de um ficam de fora.
      .filter((command) => !command.button.disabled && !command.button.closest("[data-needs-doc][hidden], [data-needs-doc].disabled"))
      .filter((command) => words.every((word) => command.key.includes(word)))
      // Primeiro os que têm a palavra no nome.
      .sort((a, b) => inName(b) - inName(a))
      .slice(0, 40);
    active = 0;
    paint();
  };

  function run(command) {
    dialog.close();
    if (command.panel) setCategory(command.panel);
    command.button.click();
  }

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) run(shown[active]);
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  return () => {
    if (dialog.open) return;
    input.value = "";
    dialog.showModal();
    filter();
    input.focus();
  };
}
