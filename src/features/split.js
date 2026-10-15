// Dividir PDF numa tela própria, como no iLovePDF: as miniaturas aparecem
// agrupadas em cada arquivo que vai ser criado, e o painel ao lado escolhe como
// dividir: por intervalos (personalizados, fixos ou o modo inteligente, que
// acha onde começa cada documento), por páginas (todas ou só as escolhidas) ou
// pelo tamanho máximo de cada arquivo. Extrair páginas usa a mesma tela, na aba
// Páginas.
import { $, $$, UserError, baseName, debounce, el, formValues, formatBytes, parsePageRange, setBusy, toast } from "../ui.js";
import { icon } from "../icons.js";
import { Perm } from "../pdf/security.js";
import * as ops from "../pdf/ops.js";
import * as platform from "../platform.js";
import { PageThumbs, pageCard, pagesText, pickGrid } from "../thumbs.js";
import * as plans from "../pdf/split.js";

const STORAGE_KEY = "dividir";
// Opções lembradas de uma vez para a outra.
const REMEMBERED = ["every", "smartBy", "smartNames", "mergeRanges", "mergePages", "maxSize", "unit"];

let dialog = null;
let form = null;
let grid = null;
let s = null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const outputsText = (n) => (n === 1 ? "1 PDF será criado" : `${n} PDFs serão criados`);

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(session) {
  const values = formValues(form);
  const prefs = { view: session.view, rangeMode: session.rangeMode, pagesMode: session.pagesMode };
  for (const key of REMEMBERED) prefs[key] = values[key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Sem armazenamento: as opções valem só desta vez.
  }
}

function setup() {
  if (dialog) return;
  dialog = $("#split-tool");
  form = $("form", dialog);
  grid = $("[data-grid]", dialog);
  $("[data-tool-close]", dialog).addEventListener("click", () => dialog.close());
  for (const button of $$("[data-tab]", dialog)) button.addEventListener("click", () => change({ view: button.dataset.tab }));
  for (const button of $$('[data-modes="range"] [data-mode]', dialog)) button.addEventListener("click", () => change({ rangeMode: button.dataset.mode }));
  for (const button of $$('[data-modes="pages"] [data-mode]', dialog)) button.addEventListener("click", () => change({ pagesMode: button.dataset.mode }));
  $(".range-add", dialog).addEventListener("click", addRange);
  $("[data-go]", dialog).addEventListener("click", go);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
  // Enter num campo só atualiza a divisão.
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      refresh();
    }
  });
  dialog.addEventListener("close", finish);
}

/**
 * Abre a tela de dividir o documento ativo. `view`: aba inicial ("ranges",
 * "pages" ou "size"); `pages`: páginas já escolhidas (abre em Selecionar).
 */
export async function split(app, { view = null, pages = null } = {}) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.ASSEMBLE, "dividir o documento"))) return;
  setup();
  const prefs = loadPrefs();
  const total = tab.doc.numPages;
  s = {
    app,
    tab,
    total,
    thumbs: new PageThumbs(tab.doc, grid),
    view: view || prefs.view || "ranges",
    rangeMode: prefs.rangeMode || "fixed",
    pagesMode: pages ? "select" : prefs.pagesMode || "all",
    ranges: [{ from: 1, to: total }],
    selected: new Set(pages || []),
    pagesError: null,
    analysis: { outline: null, texts: null, titles: null, blanks: null },
    analyzing: false,
    progress: "",
    sizes: null,
    plan: null,
    gridKey: null,
    resync: null,
  };
  const f = form.elements;
  f.every.value = prefs.every || 1;
  f.smartBy.value = prefs.smartBy || "auto";
  f.smartNames.checked = prefs.smartNames ?? true;
  f.keyword.value = "";
  f.mergeRanges.checked = Boolean(prefs.mergeRanges);
  f.mergePages.checked = prefs.mergePages ?? true;
  f.removeAfter.checked = false;
  f.maxSize.value = prefs.maxSize || 5;
  f.unit.value = prefs.unit === "KB" ? "KB" : "MB";
  f.prefix.value = baseName(tab.name);
  f.pages.value = pagesText([...s.selected].sort((a, b) => a - b));
  $("[data-doc]", dialog).textContent = `${tab.name} · ${plural(total, "página", "páginas")}`;
  renderRanges();
  dialog.showModal();
  refresh();
}

/** Extrair páginas: a mesma tela, na aba Páginas, com a página atual escolhida. */
export function extract(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  return split(app, { view: "pages", pages: [tab.viewer.currentPageNumber - 1] });
}

function finish() {
  if (!s) return;
  savePrefs(s);
  s.thumbs.dispose();
  grid.replaceChildren();
  s = null;
}

function change(patch) {
  Object.assign(s, patch);
  refresh();
}

// ---- Intervalos personalizados ----

function renderRanges() {
  const list = $(".range-list", dialog);
  list.replaceChildren(
    ...s.ranges.map((range, k) =>
      el("div", { class: "range-row" }, [
        el("strong", { text: `Intervalo ${k + 1}` }),
        el("label", { class: "panel-row" }, [
          "da página",
          el("input", { type: "number", min: 1, max: s.total, value: range.from, dataset: { range: k, end: "from" }, "aria-label": `Primeira página do intervalo ${k + 1}` }),
        ]),
        el("label", { class: "panel-row" }, [
          "até",
          el("input", { type: "number", min: 1, max: s.total, value: range.to, dataset: { range: k, end: "to" }, "aria-label": `Última página do intervalo ${k + 1}` }),
        ]),
        s.ranges.length > 1
          ? el("button", {
              type: "button",
              class: "btn icon-only small",
              title: "Tirar este intervalo",
              "aria-label": `Tirar o intervalo ${k + 1}`,
              html: icon("close"),
              onclick: () => {
                s.ranges.splice(k, 1);
                renderRanges();
                refresh();
              },
            })
          : null,
      ]),
    ),
  );
}

function addRange() {
  const last = s.ranges[s.ranges.length - 1];
  const from = Math.min(s.total, (Number(last?.to) || 0) + 1);
  s.ranges.push({ from, to: s.total });
  renderRanges();
  refresh();
  $(".range-list .range-row:last-child input", dialog)?.focus();
}

// ---- Opções ----

const scheduleRefresh = debounce(() => refresh(), 180);

function onInput(event) {
  if (!s) return;
  const target = event.target;
  if (target.dataset.range !== undefined) {
    const range = s.ranges[Number(target.dataset.range)];
    if (range) range[target.dataset.end] = target.value === "" ? NaN : Number(target.value);
  } else if (target.name === "pages") {
    readPagesField();
    s.resync?.();
  }
  scheduleRefresh();
}

/** Lê o campo "Páginas a extrair" para a seleção (vazio: nenhuma). */
function readPagesField() {
  const text = form.elements.pages.value;
  s.pagesError = null;
  if (!text.trim()) {
    s.selected.clear();
    return;
  }
  try {
    const indices = parsePageRange(text, s.total);
    s.selected.clear();
    indices.forEach((i) => s.selected.add(i));
  } catch (err) {
    s.pagesError = err.userMessage || err.message;
  }
}

function pagesWord(pages) {
  const text = pagesText(pages);
  if (pages.length === 1) return `página ${text}`;
  return text.length > 40 ? plural(pages.length, "página", "páginas") : `páginas ${text}`;
}

// ---- O plano: grupos na grade e arquivos que serão criados ----

function computePlan() {
  const v = formValues(form);
  const total = s.total;
  const prefix = v.prefix.trim() || baseName(s.tab.name);
  const nameFor = (pages) => `${prefix} (${pagesWord(pages)}).pdf`;
  const each = (groups) => groups.map((g) => ({ pages: g.pages, name: nameFor(g.pages) }));

  if (s.view === "pages") {
    if (s.pagesMode === "all") {
      const groups = Array.from({ length: total }, (_, i) => ({ pages: [i], label: `Página ${i + 1}` }));
      return { groups, outputs: each(groups), info: `Cada página vira um PDF: ${outputsText(total)}.` };
    }
    if (s.pagesError) return { pick: true, outputs: [], error: s.pagesError };
    const pages = [...s.selected].sort((a, b) => a - b);
    if (!pages.length) return { pick: true, outputs: [], info: "Escolha as páginas: clique nas miniaturas ou digite os números." };
    const outputs = v.mergePages ? [{ pages, name: nameFor(pages) }] : pages.map((p) => ({ pages: [p], name: nameFor([p]) }));
    let info = `${plural(pages.length, "página escolhida", "páginas escolhidas")}: ${outputsText(outputs.length)}.`;
    if (v.removeAfter) {
      if (pages.length === total) info += " Elas não saem deste documento: um PDF precisa de pelo menos uma página.";
      else info += pages.length === 1 ? " Depois ela sai deste documento (dá para desfazer)." : " Depois elas saem deste documento (dá para desfazer).";
    }
    return { pick: true, outputs, info };
  }

  if (s.view === "size") return sizePlan(v, each);

  if (s.rangeMode === "fixed") {
    const every = Math.max(1, Math.floor(Number(v.every)) || 1);
    const groups = plans.fixedGroups(total, every).map((pages, k) => ({ pages, label: `Intervalo ${k + 1}` }));
    const last = groups[groups.length - 1].pages.length;
    let info = `Este PDF será dividido em arquivos de ${plural(every, "página", "páginas")}. ${outputsText(groups.length)}.`;
    if (groups.length > 1 && last !== every) info += ` O último fica com ${plural(last, "página", "páginas")}.`;
    return { groups, outputs: each(groups), info };
  }

  if (s.rangeMode === "custom") {
    let groups;
    try {
      groups = plans.customGroups(s.ranges, total).map((pages, k) => ({ pages, label: `Intervalo ${k + 1}` }));
    } catch (err) {
      return { groups: [], outputs: [], error: err.message };
    }
    if (v.mergeRanges) {
      const pages = groups.flatMap((g) => g.pages);
      const info = groups.length === 1 ? `1 PDF será criado, com ${plural(pages.length, "página", "páginas")}.` : `Os ${groups.length} intervalos vão para um único PDF, com ${plural(pages.length, "página", "páginas")}.`;
      return { groups, outputs: [{ pages, name: nameFor(pages) }], info };
    }
    return { groups, outputs: each(groups), info: `${outputsText(groups.length)}.` };
  }

  return smartPlan(v, prefix);
}

function sizeLimit(v) {
  return Number(v.maxSize) * (v.unit === "KB" ? 1024 : 1024 * 1024);
}

function sizePlan(v, each) {
  const limit = sizeLimit(v);
  if (!(limit >= 1024)) return { groups: [], outputs: [], error: "Informe o tamanho máximo de cada arquivo (pelo menos 1 KB)." };
  if (!s.sizes) {
    measure();
    return { groups: [], outputs: [], pending: true, info: "Calculando o tamanho das páginas…" };
  }
  // Um pouco de folga: o tamanho de cada página é uma estimativa.
  const groups = plans.sizeGroups(s.resources, limit * 0.95).map((pages, k) => ({ pages, label: `Arquivo ${k + 1}` }));
  const big = s.sizes.filter((size) => size > limit).length;
  let info = `O documento tem ${formatBytes(s.fileSize)}. Em arquivos de até ${formatBytes(limit)}: cerca de ${plural(groups.length, "PDF", "PDFs")}.`;
  if (big) info += ` ${big === 1 ? "Uma página passa" : `${big} páginas passam`} desse tamanho sozinha${big === 1 ? "" : "s"} e ${big === 1 ? "fica num arquivo só dela" : "ficam cada uma num arquivo só dela"}.`;
  return { groups, outputs: each(groups), info, limit };
}

async function measure() {
  if (s.measuring) return;
  const session = s;
  session.measuring = true;
  try {
    session.editable = await session.tab.loadEditable();
    session.resources = plans.pageResources(session.editable);
    session.sizes = plans.pageSizes(session.resources);
    session.fileSize = (await session.tab.currentBytes()).length;
  } catch (err) {
    session.sizes = null;
    toast(err.userMessage || "Não foi possível calcular o tamanho das páginas.");
  } finally {
    session.measuring = false;
  }
  if (session === s) refresh();
}

// ---- Modo inteligente ----

const FOUND_BY = {
  outline: "pelos marcadores",
  numbering: "pela numeração das páginas",
  keyword: "pela palavra",
  blank: "pelas páginas em branco",
};

/** O critério a usar, ou o que ainda falta analisar ({ need }). */
function detect(by) {
  const a = s.analysis;
  const distinctStarts = () => new Set(a.outline.map((o) => o.index)).size;
  switch (by) {
    case "outline":
      return a.outline ? { method: "outline" } : { need: "outline" };
    case "numbering":
    case "keyword":
      return a.texts ? { method: by } : { need: "texts" };
    case "blank":
      return a.blanks ? { method: "blank" } : { need: "blanks" };
    default:
      if (!a.outline) return { need: "outline" };
      if (distinctStarts() >= 2) return { method: "outline" };
      if (!a.texts) return { need: "texts" };
      if (plans.numberingStarts(a.texts).length >= 2) return { method: "numbering" };
      if (!a.blanks) return { need: "blanks" };
      return { method: a.blanks.size ? "blank" : null };
  }
}

function smartPlan(v, prefix) {
  const all = Array.from({ length: s.total }, (_, i) => i);
  const whole = [{ pages: all, label: "Documento inteiro" }];
  if (v.smartBy === "keyword" && !v.keyword.trim()) {
    return { groups: whole, outputs: [], info: "Digite a palavra que aparece na primeira página de cada documento (ex.: Nota Fiscal)." };
  }
  const found = detect(v.smartBy);
  if (found.need) {
    analyze(found.need);
    return { groups: whole, outputs: [], pending: true, info: s.progress || "Analisando as páginas…" };
  }
  const a = s.analysis;
  // O título de cada documento vem do texto da primeira página (nos marcadores, do próprio marcador).
  if (found.method && found.method !== "outline" && v.smartNames && !a.texts) {
    analyze("texts");
    return { groups: whole, outputs: [], pending: true, info: s.progress || "Lendo o título de cada documento…" };
  }
  let groupPages = [];
  if (found.method === "blank") groupPages = plans.groupsBetweenBlanks(s.total, a.blanks);
  else if (found.method) {
    const starts =
      found.method === "outline"
        ? a.outline.map((o) => o.index)
        : found.method === "numbering"
          ? plans.numberingStarts(a.texts)
          : plans.keywordStarts(a.texts, v.keyword);
    groupPages = plans.groupsFromStarts(s.total, starts);
  }
  const blanks = found.method === "blank" ? a.blanks.size : 0;
  if (blanks && !groupPages.length) return { groups: whole, outputs: [], info: "Todas as páginas deste PDF estão em branco." };
  if (groupPages.length < 2 && !blanks) {
    const message = {
      outline: "Este PDF não tem marcadores que separem documentos.",
      numbering: 'Não achamos páginas com "Página 1 de ..." para separar os documentos.',
      keyword: `Nenhuma outra página tem "${v.keyword.trim()}" para começar um documento novo.`,
      blank: "Não há páginas em branco separando documentos.",
    }[found.method || v.smartBy];
    return {
      groups: whole,
      outputs: [],
      info: `${message || "Não achamos onde começa cada documento."} Tente outro critério, ou use os intervalos personalizados ou fixos.`,
    };
  }
  const titleOf = (pages) => {
    if (found.method === "outline") return a.outline.find((o) => o.index === pages[0])?.title || a.titles?.[pages[0]] || "";
    return a.titles?.[pages[0]] || "";
  };
  const titles = groupPages.map((pages) => (v.smartNames ? plans.fileNameFrom(titleOf(pages), "") : ""));
  const names = plans.uniqueNames(groupPages.map((pages, k) => titles[k] || `${prefix} (${pagesWord(pages)})`));
  const groups = groupPages.map((pages, k) => ({ pages, label: titles[k] || `Documento ${k + 1}` }));
  let info = `${plural(groups.length, "documento encontrado", "documentos encontrados")} ${FOUND_BY[found.method]}: ${outputsText(groups.length)}.`;
  if (blanks) info += ` ${blanks === 1 ? "A página em branco fica" : `As ${blanks} páginas em branco ficam`} de fora.`;
  return { groups, outputs: groups.map((g, k) => ({ pages: g.pages, name: `${names[k]}.pdf` })), info };
}

/** Lê o que o modo inteligente precisa: marcadores, texto das páginas ou páginas em branco. */
async function analyze(need) {
  if (s.analyzing) return;
  const session = s;
  const a = session.analysis;
  const pdf = session.tab.doc;
  session.analyzing = true;
  const progress = (text) => {
    session.progress = text;
    if (session === s && session.plan?.pending) showInfo({ info: text, pending: true });
  };
  try {
    if (need === "outline") a.outline = await outlineStarts(pdf);
    if (need === "texts") {
      const texts = [];
      const titles = [];
      for (let n = 1; n <= session.total; n++) {
        if (session !== s) return;
        if (n % 5 === 1) progress(`Lendo o texto das páginas… ${n}/${session.total}`);
        const page = await pdf.getPage(n);
        const content = await page.getTextContent().catch(() => ({ items: [] }));
        texts.push(content.items.map((item) => item.str).join(" "));
        titles.push(pageTitle(content.items, page.getViewport({ scale: 1 })));
      }
      a.texts = texts;
      a.titles = titles;
    }
    if (need === "blanks") {
      const blanks = new Set();
      for (let n = 1; n <= session.total; n++) {
        if (session !== s) return;
        if (n % 5 === 1) progress(`Procurando páginas em branco… ${n}/${session.total}`);
        if (await isBlank(await pdf.getPage(n))) blanks.add(n - 1);
      }
      a.blanks = blanks;
    }
  } catch (err) {
    console.error(err);
    if (need === "outline") a.outline = [];
    if (need === "texts") a.texts ||= Array(session.total).fill("");
    if (need === "blanks") a.blanks ||= new Set();
  } finally {
    session.analyzing = false;
    session.progress = "";
  }
  if (session === s) refresh();
}

/** Página e título de cada marcador do primeiro nível, na ordem das páginas. */
async function outlineStarts(pdf) {
  const outline = (await pdf.getOutline().catch(() => null)) || [];
  const starts = [];
  for (const item of outline) {
    try {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      const ref = Array.isArray(dest) ? dest[0] : null;
      const index = ref && typeof ref === "object" ? await pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
      if (index !== null && !starts.some((o) => o.index === index)) starts.push({ index, title: item.title || "" });
    } catch {
      // Marcador sem destino válido.
    }
  }
  return starts.sort((x, y) => x.index - y.index);
}

/** Título da página: a linha de letra maior no alto da página. */
function pageTitle(items, viewport) {
  const lines = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const size = Math.hypot(item.transform[2], item.transform[3]);
    let line = lines.find((l) => Math.abs(l.y - y) < Math.max(size, l.size) * 0.6);
    if (!line) lines.push((line = { y, size, parts: [] }));
    line.parts.push({ x, str: item.str });
    line.size = Math.max(line.size, size);
  }
  const top = lines.filter((l) => l.y < viewport.height * 0.4);
  const pool = (top.length ? top : lines).sort((a, b) => b.size - a.size || a.y - b.y);
  const best = pool[0];
  if (!best) return "";
  return best.parts
    .sort((a, b) => a.x - b.x)
    .map((p) => p.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Página em branco: sem texto e quase sem tinta (ignora as bordas, onde o scanner deixa sombra). */
async function isBlank(page) {
  const content = await page.getTextContent().catch(() => ({ items: [] }));
  if (content.items.some((item) => item.str?.trim())) return false;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 90 / base.width });
  const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const mx = Math.round(canvas.width * 0.06);
  const my = Math.round(canvas.height * 0.06);
  const { data, width, height } = ctx.getImageData(mx, my, canvas.width - 2 * mx, canvas.height - 2 * my);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 180) ink++;
  return ink / (width * height) < 0.0025;
}

// ---- Tela ----

function refresh() {
  if (!s) return;
  updateControls();
  const plan = computePlan();
  s.plan = plan;
  renderGrid(plan);
  showInfo(plan);
}

function updateControls() {
  for (const button of $$("[data-tab]", dialog)) {
    const on = button.dataset.tab === s.view;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const pane of $$("[data-pane]", dialog)) pane.hidden = pane.dataset.pane !== s.view;
  for (const button of $$('[data-modes="range"] [data-mode]', dialog)) button.classList.toggle("active", button.dataset.mode === s.rangeMode);
  for (const sub of $$('[data-pane="ranges"] [data-sub]', dialog)) sub.hidden = sub.dataset.sub !== s.rangeMode;
  for (const button of $$('[data-modes="pages"] [data-mode]', dialog)) button.classList.toggle("active", button.dataset.mode === s.pagesMode);
  $('[data-pane="pages"] [data-sub="select"]', dialog).hidden = s.pagesMode !== "select";
  form.elements.keyword.hidden = form.elements.smartBy.value !== "keyword";
  $("[data-go] span", dialog).textContent = s.view === "pages" ? "Extrair páginas" : "Dividir PDF";
}

function renderGrid(plan) {
  if (plan.pick) {
    // Selecionar páginas: todas as miniaturas, clicáveis.
    if (s.gridKey !== "pick") {
      s.gridKey = "pick";
      s.resync = pickGrid(grid, s.thumbs, s.total, {
        chosen: s.selected,
        mark: "selected",
        badge: "check",
        onChange: () => {
          form.elements.pages.value = pagesText([...s.selected].sort((a, b) => a - b));
          s.pagesError = null;
          refresh();
        },
      });
    }
    return;
  }
  const key = JSON.stringify(plan.groups.map((g) => [g.label, g.pages.length, g.pages[0], g.pages[g.pages.length - 1]]));
  if (key === s.gridKey) return;
  s.gridKey = key;
  s.resync = null;
  s.thumbs.forget();
  grid.classList.remove("pick");
  if (!plan.groups.length) {
    grid.replaceChildren(el("p", { class: "tool-grid-message", text: "Corrija as opções ao lado para ver como o documento será dividido." }));
    return;
  }
  grid.replaceChildren(...plan.groups.map(groupBox));
}

/** Caixa tracejada de um arquivo: a primeira e a última página (e quantas há no meio). */
function groupBox(group) {
  const { pages } = group;
  const card = (i) => pageCard(s.thumbs, i);
  const cards =
    pages.length <= 2
      ? pages.map(card)
      : [card(pages[0]), el("div", { class: "split-more", title: `Mais ${pages.length - 2} páginas` }, [el("strong", { text: "···" }), el("span", { text: `+${pages.length - 2}` })]), card(pages[pages.length - 1])];
  return el("div", { class: "split-group" }, [el("div", { class: "split-group-label", text: group.label, title: group.label }), el("div", { class: "split-group-box" }, cards)]);
}

function showInfo(plan) {
  const box = $(".tool-info", dialog);
  box.textContent = plan.error || plan.info || "";
  box.classList.toggle("error", Boolean(plan.error));
  $("[data-go]", dialog).disabled = Boolean(plan.error || plan.pending || !plan.outputs?.length);
}

// ---- Dividir ----

async function go() {
  const plan = s?.plan;
  if (!plan || plan.error || plan.pending || !plan.outputs?.length) return;
  const session = s;
  const values = formValues(form);
  dialog.close();
  await session.app.run(session.view === "pages" ? "Extraindo páginas…" : "Dividindo…", () => produce(session, plan, values));
}

async function produce(session, plan, values) {
  const { tab } = session;
  const doc = session.editable || (await tab.loadEditable());
  const prefix = values.prefix.trim() || baseName(tab.name);
  const queue = plan.outputs.map((out) => ({ ...out }));
  const files = [];
  while (queue.length) {
    const out = queue.shift();
    setBusy(`Criando os arquivos… ${files.length + 1}/${files.length + 1 + queue.length}`);
    const data = await ops.extractPages(doc, out.pages);
    // No modo Tamanho, um arquivo que passou do limite é dividido de novo ao meio.
    if (plan.limit && data.length > plan.limit && out.pages.length > 1) {
      const half = Math.ceil(out.pages.length / 2);
      queue.unshift({ pages: out.pages.slice(0, half) }, { pages: out.pages.slice(half) });
      continue;
    }
    files.push({ pages: out.pages, name: out.name || `${prefix} (${pagesWord(out.pages)}).pdf`, data });
  }
  const names = plans.uniqueNames(files.map((f) => f.name.replace(/\.pdf$/i, "")));
  files.forEach((f, k) => (f.name = `${names[k]}.pdf`));
  setBusy("Salvando…");
  let where;
  if (files.length === 1) {
    const saved = await platform.saveFile(files[0].data, { suggestedName: files[0].name, saveAs: true });
    if (!saved) return;
    where = saved.name;
  } else {
    const saved = await platform.saveFiles(
      files.map(({ name, data }) => ({ name, data })),
      { zipName: `${prefix} (dividido).zip` },
    );
    if (!saved) return;
    where = saved.where;
  }
  const extracted = session.view === "pages" && session.pagesMode === "select" ? [...session.selected].sort((a, b) => a - b) : null;
  if (extracted && values.removeAfter && extracted.length < session.total) {
    setBusy("Tirando as páginas deste documento…");
    await tab.edit((d) => ops.deletePages(d, extracted), { keepView: false, page: Math.min(extracted[0] + 1, session.total - extracted.length) });
  }
  toast(files.length === 1 ? `PDF salvo: ${where}` : `${files.length} arquivos salvos em ${where}.`, { duration: 6000 });
}
