// Miniaturas das páginas para as telas de páginas (dividir, remover): cada
// página é desenhada uma vez, só quando aparece na tela, e a imagem serve para
// todas as cópias dela na grade.
import { el } from "./ui.js";
import { icon } from "./icons.js";

export class PageThumbs {
  /** `pdf`: documento do PDF.js; `root`: o elemento que rola a grade. */
  constructor(pdf, root, { width = 150 } = {}) {
    this.pdf = pdf;
    this.width = width;
    this.urls = new Map();
    this.waiting = new Map();
    this.queue = [];
    this.busy = false;
    this.disposed = false;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          this.request(Number(entry.target.dataset.index));
        }
      },
      { root, rootMargin: "400px" },
    );
  }

  /** Imagem da página `index` (contando do 0). */
  image(index) {
    const img = el("img", { class: "page-thumb", alt: `Página ${index + 1}`, draggable: "false", dataset: { index } });
    const url = this.urls.get(index);
    if (url) img.src = url;
    else {
      if (!this.waiting.has(index)) this.waiting.set(index, new Set());
      this.waiting.get(index).add(img);
      this.observer.observe(img);
    }
    return img;
  }

  /** Antes de refazer a grade: as imagens antigas saem da espera. */
  forget() {
    this.observer.disconnect();
    this.waiting.clear();
  }

  request(index) {
    if (this.urls.has(index) || this.queue.includes(index)) return;
    this.queue.push(index);
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.disposed) {
      const index = this.queue.shift();
      try {
        const url = await this.render(index);
        if (this.disposed) {
          URL.revokeObjectURL(url);
          break;
        }
        this.urls.set(index, url);
        for (const img of this.waiting.get(index) || []) {
          img.src = url;
          this.observer.unobserve(img);
        }
        this.waiting.delete(index);
      } catch {
        // Página que não desenha: fica a moldura vazia.
      }
    }
    this.busy = false;
  }

  async render(index) {
    const page = await this.pdf.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (this.width / base.width) * ratio });
    const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return URL.createObjectURL(blob);
  }

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.waiting.clear();
    this.queue = [];
  }
}

/** Cartão de uma página na grade: a miniatura e o número. */
export function pageCard(thumbs, index, { onClick = null, title = null } = {}) {
  const props = { class: "page-card", dataset: { index }, title: title || `Página ${index + 1}` };
  const children = [el("div", { class: "page-card-image" }, thumbs.image(index)), el("span", { class: "page-card-number", text: String(index + 1) })];
  if (!onClick) return el("div", props, children);
  return el("button", { ...props, type: "button", onclick: onClick }, children);
}

/**
 * Grade com todas as páginas para escolher clicando (Shift + clique pega a
 * sequência desde o último clique). `chosen` é o Set de índices escolhidos;
 * `mark` a classe e `badge` o ícone da página escolhida. Devolve a função que
 * atualiza a grade quando `chosen` muda por fora.
 */
export function pickGrid(grid, thumbs, total, { chosen, mark, badge, onChange }) {
  let last = null;
  thumbs.forget();
  const cards = Array.from({ length: total }, (_, i) => {
    const card = pageCard(thumbs, i, {
      onClick: (event) => {
        if (event.shiftKey && last !== null) {
          for (let k = Math.min(last, i); k <= Math.max(last, i); k++) chosen.add(k);
        } else if (chosen.has(i)) chosen.delete(i);
        else chosen.add(i);
        last = i;
        sync();
        onChange();
      },
    });
    card.append(el("span", { class: "page-card-badge", html: icon(badge) }));
    return card;
  });
  const sync = () =>
    cards.forEach((card, i) => {
      card.classList.toggle(mark, chosen.has(i));
      card.setAttribute("aria-pressed", String(chosen.has(i)));
    });
  grid.classList.add("pick");
  grid.replaceChildren(...cards);
  sync();
  return sync;
}

/** "1-3, 7, 9-10" a partir dos índices (contando do 0), na ordem dada. */
export function pagesText(pages) {
  const parts = [];
  for (let k = 0; k < pages.length; ) {
    let end = k;
    while (end + 1 < pages.length && pages[end + 1] === pages[end] + 1) end++;
    parts.push(end > k ? `${pages[k] + 1}-${pages[end] + 1}` : `${pages[k] + 1}`);
    k = end + 1;
  }
  return parts.join(", ");
}
