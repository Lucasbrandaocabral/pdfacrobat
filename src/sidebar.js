// Painel lateral: miniaturas (com reordenação por arrastar), marcadores do PDF
// e lista de comentários.
import { pdfjsLib } from "./pdfjs.js";
import { $, $$, askText, confirmAction, el, toast } from "./ui.js";
import { icon } from "./icons.js";
import { ANNOTATION_LABELS, deleteAnnotation, setAnnotationContents } from "./pdf/annotations.js";
import { Perm } from "./pdf/security.js";

const THUMB_WIDTH = 140;

export class Sidebar {
  /**
   * `actions.movePage(tab, from, to)` reordena páginas e `actions.guard(tab,
   * flag, what)` confirma permissões antes de alterar comentários.
   */
  constructor(manager, actions) {
    this.manager = manager;
    this.actions = actions;
    this.root = $("#sidebar");
    this.panel = "thumbs";
    this.observer = null;
    this.dragFrom = null;
    this.buildToken = 0;

    $$("[data-panel-tab]", this.root).forEach((button) =>
      button.addEventListener("click", () => this.setPanel(button.dataset.panelTab)),
    );
    manager.on("activate", () => this.refresh());
    manager.on("loaded", (tab) => tab.active && this.refresh());
    manager.on("pagechange", (tab, page) => tab.active && this.highlightThumb(page));
  }

  get visible() {
    return !this.root.hidden;
  }

  toggle(force = !this.visible) {
    this.root.hidden = !force;
    $("#btn-sidebar").classList.toggle("active", force);
    try {
      localStorage.setItem("sidebar", force ? this.panel : "");
    } catch {
      // Preferência só nesta sessão.
    }
    this.manager.active?.refreshLayout();
    if (force) this.refresh();
  }

  setPanel(name) {
    this.panel = name;
    $$("[data-panel-tab]", this.root).forEach((b) => b.classList.toggle("active", b.dataset.panelTab === name));
    for (const id of ["thumbs", "outline", "comments"]) $(`#panel-${id}`).hidden = id !== name;
    if (!this.visible) this.toggle(true);
    else this.refresh();
  }

  refresh() {
    const tab = this.manager.active;
    if (!this.visible || !tab?.doc) return;
    const token = ++this.buildToken;
    if (this.panel === "thumbs") this.buildThumbnails(tab);
    else if (this.panel === "outline") this.buildOutline(tab, token);
    else this.buildComments(tab, token);
  }

  // ---- Miniaturas ----

  buildThumbnails(tab) {
    const list = $("#thumbnails");
    list.replaceChildren();
    this.observer?.disconnect();
    const doc = tab.doc;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          this.renderThumbnail(tab, doc, entry.target);
        }
      },
      { root: $("#panel-thumbs"), rootMargin: "300px" },
    );
    for (let n = 1; n <= doc.numPages; n++) {
      const item = el(
        "button",
        { class: "thumb", draggable: "true", title: `Página ${n}`, dataset: { page: n } },
        [el("div", { class: "thumb-image" }), el("span", { class: "thumb-label", text: String(n) })],
      );
      item.addEventListener("click", () => (tab.viewer.currentPageNumber = n));
      this.bindDrag(tab, item, n);
      list.append(item);
      this.observer.observe(item);
    }
    this.highlightThumb(tab.viewer.currentPageNumber || 1);
  }

  bindDrag(tab, item, n) {
    item.addEventListener("dragstart", (e) => {
      this.dragFrom = n - 1;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(n));
    });
    item.addEventListener("dragover", (e) => {
      if (this.dragFrom === null) return;
      e.preventDefault();
      const after = e.offsetY > item.offsetHeight / 2;
      item.classList.toggle("drop-before", !after);
      item.classList.toggle("drop-after", after);
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
    item.addEventListener("drop", (e) => {
      if (this.dragFrom === null) return;
      e.preventDefault();
      e.stopPropagation();
      const after = item.classList.contains("drop-after");
      item.classList.remove("drop-before", "drop-after");
      let to = n - 1 + (after ? 1 : 0);
      if (to > this.dragFrom) to -= 1;
      const from = this.dragFrom;
      this.dragFrom = null;
      if (from !== to) this.actions.movePage(tab, from, to);
    });
    item.addEventListener("dragend", () => (this.dragFrom = null));
  }

  async renderThumbnail(tab, doc, item) {
    try {
      const page = await doc.getPage(Number(item.dataset.page));
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      if (doc === tab.doc) item.querySelector(".thumb-image").replaceChildren(canvas);
    } catch {
      // Documento substituído durante a renderização.
    }
  }

  highlightThumb(n) {
    const list = $("#thumbnails");
    list.querySelector(".thumb.active")?.classList.remove("active");
    const item = list.querySelector(`.thumb[data-page="${n}"]`);
    if (!item) return;
    item.classList.add("active");
    if (this.visible && this.panel === "thumbs") item.scrollIntoView({ block: "nearest" });
  }

  // ---- Marcadores ----

  async buildOutline(tab, token) {
    const box = $("#outline");
    const outline = await tab.doc.getOutline().catch(() => null);
    if (token !== this.buildToken) return;
    if (!outline?.length) {
      box.replaceChildren(el("p", { class: "empty-panel", text: "Este documento não tem marcadores." }));
      return;
    }
    const build = (items, depth) =>
      el(
        "ul",
        {},
        items.map((item) => {
          const children = item.items?.length ? build(item.items, depth + 1) : null;
          if (children && depth > 0) children.hidden = true;
          const toggle = children
            ? el("button", {
                class: "outline-toggle",
                text: depth > 0 ? "▶" : "▼",
                "aria-label": "Expandir",
                onclick: (e) => {
                  children.hidden = !children.hidden;
                  e.currentTarget.textContent = children.hidden ? "▶" : "▼";
                },
              })
            : el("span", { class: "outline-toggle" });
          const link = el("button", {
            class: "outline-link",
            text: item.title || "(sem título)",
            style: `${item.bold ? "font-weight:600;" : ""}${item.italic ? "font-style:italic;" : ""}`,
            onclick: () => {
              if (item.dest) tab.linkService.goToDestination(item.dest);
              else if (item.url) window.open(item.url, "_blank", "noopener");
            },
          });
          return el("li", {}, [el("div", { class: "outline-item" }, [toggle, link]), children]);
        }),
      );
    box.replaceChildren(build(outline, 0));
  }

  // ---- Comentários ----

  async buildComments(tab, token) {
    const box = $("#comments");
    if (tab.doc.annotationStorage.size > 0) {
      // Grava primeiro as anotações feitas com as ferramentas do visualizador,
      // para que apareçam na lista (a lista é refeita ao recarregar).
      box.replaceChildren(el("p", { class: "empty-panel", text: "Atualizando…" }));
      await tab.commitEditors();
      return;
    }
    box.replaceChildren(el("p", { class: "empty-panel", text: "Carregando comentários…" }));
    const groups = [];
    for (let n = 1; n <= tab.doc.numPages; n++) {
      const page = await tab.doc.getPage(n);
      const annotations = (await page.getAnnotations()).filter((a) => ANNOTATION_LABELS[a.subtype]);
      if (token !== this.buildToken) return;
      if (annotations.length) groups.push({ n, annotations });
    }
    if (!groups.length) {
      box.replaceChildren(
        el("p", {
          class: "empty-panel",
          text: "Nenhum comentário. Use as ferramentas da categoria Comentar para destacar, sublinhar, anotar e desenhar.",
        }),
      );
      return;
    }
    const nodes = [];
    for (const { n, annotations } of groups) {
      nodes.push(el("div", { class: "comment-page", text: `Página ${n}` }));
      for (const a of annotations) nodes.push(this.commentCard(tab, n, a));
    }
    box.replaceChildren(...nodes);
  }

  commentCard(tab, pageNumber, a) {
    const color = a.color ? `rgb(${a.color[0]}, ${a.color[1]}, ${a.color[2]})` : "var(--accent)";
    const contents = a.contentsObj?.str || (Array.isArray(a.textContent) ? a.textContent.join(" ") : "") || "";
    const date = a.modificationDate ? pdfjsLib.PDFDateString.toDateObject(a.modificationDate) : null;
    const author = a.titleObj?.str || "";
    const target = { id: a.id, subtype: a.subtype, rect: a.rect };
    const pageIndex = pageNumber - 1;

    const editButton =
      a.subtype !== "FreeText"
        ? el("button", {
            class: "btn icon-only",
            title: "Editar comentário",
            html: icon("editText"),
            onclick: async (e) => {
              e.stopPropagation();
              if (!(await this.actions.guard(tab, Perm.ANNOTATE, "alterar comentários"))) return;
              const value = await askText({ title: "Comentário", label: ANNOTATION_LABELS[a.subtype], value: contents, multiline: true, ok: "Salvar" });
              if (value === null) return;
              await this.actions.run("Salvando comentário…", () => tab.edit((doc) => setAnnotationContents(doc, pageIndex, target, value)));
            },
          })
        : null;
    const deleteButton = el("button", {
      class: "btn icon-only",
      title: "Excluir",
      html: icon("trash"),
      onclick: async (e) => {
        e.stopPropagation();
        if (!(await this.actions.guard(tab, Perm.ANNOTATE, "alterar comentários"))) return;
        const ok = await confirmAction({ title: "Excluir comentário", message: `Excluir este ${ANNOTATION_LABELS[a.subtype].toLowerCase()} da página ${pageNumber}?`, ok: "Excluir", danger: true });
        if (!ok) return;
        await this.actions.run("Excluindo…", async () => {
          const removed = await tab.edit((doc) => deleteAnnotation(doc, pageIndex, target));
          if (!removed) toast("Não foi possível localizar este comentário no arquivo.");
        });
      },
    });

    return el(
      "div",
      {
        class: "comment-card",
        style: `--swatch: ${color}`,
        tabindex: "0",
        onclick: () =>
          tab.viewer.scrollPageIntoView({
            pageNumber,
            destArray: [null, { name: "XYZ" }, a.rect[0] - 20, a.rect[3] + 40, null],
            allowNegativeOffset: true,
          }),
      },
      [
        el("div", { class: "comment-head" }, [
          el("b", { text: ANNOTATION_LABELS[a.subtype] }),
          el("div", { class: "comment-actions" }, [editButton, deleteButton]),
        ]),
        contents ? el("div", { class: "comment-text", text: contents }) : null,
        author || date
          ? el("div", { class: "comment-meta", text: [author, date?.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })].filter(Boolean).join(" · ") })
          : null,
      ],
    );
  }
}
