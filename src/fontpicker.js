// Escolha da fonte do texto: as fontes do catálogo, pesquisáveis e por
// categoria, cada uma escrita com ela mesma (carregada só quando aparece na
// lista), mais a fonte original do PDF quando dá para usá-la.
import { el } from "./ui.js";
import { CATEGORIES, FONTS, cssFamily, fontById, loadFontFace, recentFonts } from "./fonts.js";

let open = null;

const simplify = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function fontPickerOpen() {
  return Boolean(open);
}

export function closeFontPicker() {
  if (!open) return;
  const { picker, observer, onOutside, onClose } = open;
  open = null;
  observer.disconnect();
  document.removeEventListener("pointerdown", onOutside, true);
  picker.remove();
  onClose?.();
}

/**
 * Abre a lista junto de `anchor`. `current`: id da fonte escolhida (ou
 * "original"); `original`: { label, family } da fonte do PDF, se ela puder ser
 * usada; `onPick(id)` recebe a escolha; `onClose()` é chamado ao fechar.
 */
export function openFontPicker({ anchor, current, original, onPick, onClose }) {
  closeFontPicker();
  const search = el("input", {
    class: "font-search",
    type: "search",
    placeholder: "Pesquisar fonte",
    "aria-label": "Pesquisar fonte",
    autocomplete: "off",
    spellcheck: "false",
  });
  const cats = el("div", { class: "font-cats" });
  const list = el("div", { class: "font-list", role: "listbox", "aria-label": "Fontes" });
  const picker = el("div", { class: "font-picker", role: "dialog", "aria-label": "Escolher fonte" }, [search, cats, list]);
  let category = "all";

  // Cada fonte é carregada quando aparece na lista.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !entry.target.dataset.font) continue;
        observer.unobserve(entry.target);
        loadFontFace(entry.target.dataset.font).catch(() => {});
      }
    },
    { root: list, rootMargin: "120px 0px" },
  );

  const option = (id, label, family, note) => {
    const button = el(
      "button",
      {
        class: `font-option${id === current ? " selected" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": String(id === current),
        dataset: { id, ...(id === "original" ? {} : { font: id }) },
        onclick: () => {
          closeFontPicker();
          onPick(id);
        },
      },
      [el("span", { class: "font-sample", text: label, style: `font-family: ${family}, system-ui, sans-serif` }), note ? el("small", { text: note }) : null],
    );
    if (id !== "original") observer.observe(button);
    return button;
  };

  const render = () => {
    observer.disconnect();
    const query = simplify(search.value.trim());
    const matches = (font) => (category === "all" || font.category === category) && (!query || simplify(font.family).includes(query));
    const items = [];
    const heading = (text) => items.push(el("div", { class: "font-heading", text }));
    if (original && !query && category === "all") {
      heading("Do documento");
      items.push(option("original", original.label, original.family, "fonte original do PDF"));
    }
    const recent = recentFonts().map(fontById);
    if (recent.length && !query && category === "all") {
      heading("Usadas recentemente");
      for (const font of recent) items.push(option(font.id, font.family, cssFamily(font.id)));
    }
    const found = FONTS.filter(matches).sort((a, b) => a.family.localeCompare(b.family));
    if (!query && category === "all") heading("Todas as fontes");
    for (const font of found) items.push(option(font.id, font.family, cssFamily(font.id)));
    if (!found.length) items.push(el("div", { class: "font-empty", text: "Nenhuma fonte com esse nome." }));
    list.replaceChildren(...items);
  };

  const chip = (key, label) =>
    el("button", {
      class: `chip${key === category ? " active" : ""}`,
      type: "button",
      text: label,
      "aria-pressed": String(key === category),
      onclick: (e) => {
        category = key;
        cats.querySelectorAll(".chip").forEach((c) => {
          c.classList.toggle("active", c === e.currentTarget);
          c.setAttribute("aria-pressed", String(c === e.currentTarget));
        });
        render();
        list.scrollTop = 0;
      },
    });
  cats.append(chip("all", "Todas"), ...Object.entries(CATEGORIES).map(([key, label]) => chip(key, label)));
  search.addEventListener("input", () => {
    render();
    list.scrollTop = 0;
  });

  picker.addEventListener("keydown", (e) => {
    const options = [...list.querySelectorAll(".font-option")];
    const index = options.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFontPicker();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? index + 1 : index - 1;
      if (next < 0) search.focus();
      else options[Math.min(next, options.length - 1)]?.focus();
    } else if (e.key === "Enter" && document.activeElement === search) {
      e.preventDefault();
      options[0]?.click();
    }
    // As teclas da lista não chegam aos atalhos do programa.
    e.stopPropagation();
  });

  const onOutside = (e) => {
    if (!picker.contains(e.target) && !anchor.contains(e.target)) closeFontPicker();
  };
  document.addEventListener("pointerdown", onOutside, true);
  open = { picker, observer, onOutside, onClose };

  render();
  document.body.append(picker);
  // Abaixo do botão (acima, se não couber); em telas estreitas, a lista fica presa à parte de baixo pelo CSS.
  const r = anchor.getBoundingClientRect();
  const height = picker.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  const top = below >= height || below >= r.top ? r.bottom + 4 : Math.max(8, r.top - 4 - height);
  picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${top}px`;
  list.querySelector(".selected")?.scrollIntoView({ block: "center" });
  // No toque, abrir o teclado só para pesquisar atrapalha: o foco fica na fonte escolhida.
  if (matchMedia("(pointer: coarse)").matches) (list.querySelector(".selected") || list.querySelector(".font-option"))?.focus({ preventScroll: true });
  else search.focus();
}
