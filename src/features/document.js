// Ações sobre o documento aberto: páginas, extrair/dividir, marca d'água,
// cabeçalho/rodapé, proteção, compressão e propriedades.
import { pdfjsLib } from "../pdfjs.js";
import { $, UserError, baseName, el, formValues, formatBytes, hexToRgb, openDialog, parsePageRange, setBusy, toast, confirmAction } from "../ui.js";
import * as ops from "../pdf/ops.js";
import { addHeaderFooter, addWatermark } from "../pdf/marks.js";
import { compressDocument } from "../pdf/compress.js";
import * as security from "../pdf/security.js";
import { Perm } from "../pdf/security.js";
import * as platform from "../platform.js";

const ALL_PERMISSION_BITS =
  Perm.PRINT | Perm.MODIFY | Perm.COPY | Perm.ANNOTATE | Perm.FILL_FORMS | Perm.ACCESSIBILITY | Perm.ASSEMBLE | Perm.PRINT_HIGH;

function requireTab(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  return tab;
}

const current = (tab) => tab.viewer.currentPageNumber - 1;

// ---- Páginas ----

export async function rotate(app, delta) {
  const tab = requireTab(app);
  await rotatePageAt(app, tab, current(tab), delta);
}

/** Gira a página `index` (contando do 0). */
export async function rotatePageAt(app, tab, index, delta) {
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  await app.run("Girando página…", () => tab.edit((doc) => ops.rotatePages(doc, [index], delta), { keepView: false, page: index + 1 }));
}

export async function deletePage(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  if (tab.doc.numPages <= 1) return toast("Um PDF precisa ter pelo menos uma página.");
  const n = tab.viewer.currentPageNumber;
  if (!(await confirmAction({ title: "Excluir página", message: `Excluir a página ${n}?`, ok: "Excluir", danger: true }))) return;
  await app.run("Excluindo página…", () =>
    tab.edit((doc) => ops.deletePages(doc, [n - 1]), { keepView: false, page: Math.min(n, tab.doc.numPages - 1) }),
  );
}

/** Exclui a página `index` (contando do 0) sem perguntar: Desfazer traz de volta. */
export async function deletePageAt(app, tab, index) {
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  const count = tab.doc.numPages;
  if (count <= 1) return toast("Um PDF precisa ter pelo menos uma página.");
  const done = await app.run("Excluindo página…", async () => {
    await tab.edit((doc) => ops.deletePages(doc, [index]), { keepView: false, page: Math.min(index + 1, count - 1) });
    return true;
  });
  if (done) toast(`Página ${index + 1} excluída. Para trazer de volta, use Desfazer.`);
}

export async function movePage(app, tab, from, to) {
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  await app.run("Movendo página…", () => tab.edit((doc) => ops.movePage(doc, from, to), { keepView: false, page: to + 1 }));
}

export async function insertBlank(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  const at = current(tab) + 1;
  await app.run("Inserindo página…", () => tab.edit((doc) => ops.insertBlankPage(doc, at), { keepView: false, page: at + 1 }));
}

export async function insertFiles(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.ASSEMBLE, "reorganizar páginas"))) return;
  const files = await platform.pickFiles({ multiple: true, kind: "pdfAndImages" });
  if (!files.length) return;
  const at = current(tab) + 1;
  await app.run("Inserindo arquivos…", () => tab.edit((doc) => ops.insertFiles(doc, files, at), { keepView: false, page: at + 1 }));
}

export async function extract(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.ASSEMBLE, "extrair páginas"))) return;
  const dialog = $("#extract-dialog");
  const form = $("form", dialog);
  form.elements.range.value = String(tab.viewer.currentPageNumber);
  form.elements.remove.checked = false;
  $("[data-total]", dialog).textContent = `O documento tem ${tab.doc.numPages} página(s).`;
  if (!(await openDialog(dialog, { focus: '[name="range"]' }))) return;
  const values = formValues(form);
  await app.run("Extraindo páginas…", async () => {
    const indices = parsePageRange(values.range, tab.doc.numPages);
    const doc = await tab.loadEditable();
    const out = await ops.extractPages(doc, indices);
    const label = values.range.replace(/\s+/g, "");
    const saved = await platform.saveFile(out, { suggestedName: `${baseName(tab.name)} (páginas ${label}).pdf`, saveAs: true });
    if (!saved) return;
    if (values.remove) await tab.edit((d) => ops.deletePages(d, indices), { keepView: false, page: indices[0] + 1 });
    toast(`${indices.length} página(s) extraída(s).`);
  });
}

export async function split(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.ASSEMBLE, "dividir o documento"))) return;
  const dialog = $("#split-dialog");
  const form = $("form", dialog);
  form.elements.prefix.value = baseName(tab.name);
  $("[data-total]", dialog).textContent = `O documento tem ${tab.doc.numPages} página(s).`;
  if (!(await openDialog(dialog))) return;
  const values = formValues(form);
  await app.run("Dividindo…", async () => {
    const total = tab.doc.numPages;
    let groups;
    if (values.mode === "ranges") {
      const parts = values.ranges.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) throw new UserError("Informe os intervalos, separados por ponto e vírgula.");
      groups = parts.map((part) => parsePageRange(part, total));
    } else {
      const every = Math.max(1, parseInt(values.every, 10) || 1);
      groups = [];
      for (let i = 0; i < total; i += every) groups.push(Array.from({ length: Math.min(every, total - i) }, (_, k) => i + k));
    }
    if (groups.length < 2 && groups[0]?.length === total) throw new UserError("Com essas opções o documento não seria dividido.");
    const doc = await tab.loadEditable();
    const parts = await ops.splitDocument(doc, groups);
    const prefix = values.prefix.trim() || baseName(tab.name);
    const label = (indices) =>
      indices.length === 1 ? `página ${indices[0] + 1}` : `páginas ${indices[0] + 1}-${indices[indices.length - 1] + 1}`;
    const files = parts.map((p) => ({ name: `${prefix} (${label(p.indices)}).pdf`, data: p.bytes }));
    const result = await platform.saveFiles(files, { zipName: `${prefix} (dividido).zip` });
    if (result) toast(`${files.length} arquivos salvos em ${result.where}.`, { duration: 6000 });
  });
}

// ---- Marca d'água e cabeçalho/rodapé ----

export async function watermark(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.MODIFY, "editar o conteúdo"))) return;
  const dialog = $("#watermark-dialog");
  if (!(await openDialog(dialog))) return;
  const v = formValues($("form", dialog));
  await app.run("Aplicando marca d'água…", async () => {
    if (!v.text.trim()) throw new UserError("Digite o texto da marca d'água.");
    const pages = parsePageRange(v.pages, tab.doc.numPages);
    await tab.edit((doc) =>
      addWatermark(doc, {
        text: v.text.trim(),
        size: Number(v.size) || 64,
        color: hexToRgb(v.color),
        opacity: Math.min(1, Math.max(0.05, Number(v.opacity) / 100 || 0.25)),
        angle: Number(v.angle) || 0,
        position: v.position,
        pages,
        behind: v.behind,
      }),
    );
  });
}

export async function headerFooter(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.MODIFY, "editar o conteúdo"))) return;
  const dialog = $("#header-footer-dialog");
  if (!(await openDialog(dialog))) return;
  const v = formValues($("form", dialog));
  await app.run("Aplicando cabeçalho e rodapé…", async () => {
    const header = [v.hl, v.hc, v.hr];
    const footer = [v.fl, v.fc, v.fr];
    if (![...header, ...footer].some((t) => t.trim())) throw new UserError("Preencha pelo menos um campo do cabeçalho ou do rodapé.");
    const pages = parsePageRange(v.pages, tab.doc.numPages);
    await tab.edit((doc) =>
      addHeaderFooter(doc, {
        header,
        footer,
        size: Number(v.size) || 10,
        color: hexToRgb(v.color),
        margin: ((Number(v.margin) || 12) / 25.4) * 72,
        start: Number.isFinite(Number(v.start)) ? Number(v.start) : 1,
        pages,
        fileName: baseName(tab.name),
      }),
    );
  });
}

// ---- Proteção ----

export async function protect(app) {
  const tab = requireTab(app);
  if (tab.encrypted && !(await tab.requestOwner("alterar a proteção"))) return;
  const dialog = $("#protect-dialog");
  const form = $("form", dialog);
  form.reset();
  const sync = () => {
    $('[data-group="open"]', dialog).hidden = !form.elements.requireOpen.checked;
    $('[data-group="restrict"]', dialog).hidden = !form.elements.restrict.checked;
  };
  form.elements.requireOpen.onchange = sync;
  form.elements.restrict.onchange = sync;
  sync();
  let values;
  for (;;) {
    if (!(await openDialog(dialog))) return;
    values = formValues(form);
    const problem = validateProtection(values);
    if (!problem) break;
    toast(problem);
  }
  const permissions = {
    printing: values.printing === "none" ? false : values.printing,
    modifying: values.changes === "all",
    annotating: values.changes === "comments" || values.changes === "all",
    fillingForms: values.changes !== "none",
    documentAssembly: values.changes === "all",
    copying: values.copying,
    contentAccessibility: true,
  };
  const all = { printing: "highResolution", modifying: true, annotating: true, fillingForms: true, documentAssembly: true, copying: true, contentAccessibility: true };
  const userPassword = values.requireOpen ? values.userPassword : "";
  const ownerPassword = values.restrict ? values.ownerPassword : userPassword;
  await app.run("Protegendo…", async () => {
    const out = await security.protect(await tab.currentBytes(), tab.encrypted ? tab.security : null, {
      userPassword,
      ownerPassword,
      permissions: values.restrict ? permissions : all,
    });
    await tab.replace(out, { password: userPassword, ownerPassword });
    toast("Proteção aplicada. Salve o documento (Ctrl+S) para gravar o arquivo protegido.", { duration: 6000 });
  });
}

function validateProtection(v) {
  if (!v.requireOpen && !v.restrict) return "Escolha pelo menos uma forma de proteção.";
  if (v.requireOpen) {
    if (!v.userPassword) return "Digite a senha para abrir.";
    if (v.userPassword !== v.userPassword2) return "As senhas para abrir não conferem.";
  }
  if (v.restrict) {
    if (!v.ownerPassword) return "Digite a senha de permissões.";
    if (v.ownerPassword !== v.ownerPassword2) return "As senhas de permissões não conferem.";
    if (v.requireOpen && v.ownerPassword === v.userPassword) return "A senha de permissões precisa ser diferente da senha para abrir.";
  }
  return null;
}

export async function unprotect(app) {
  const tab = requireTab(app);
  if (!tab.encrypted) return toast("Este documento não tem senha nem restrições.");
  const unrestricted = (tab.security.P & ALL_PERMISSION_BITS) === ALL_PERMISSION_BITS;
  if (!unrestricted && !(await tab.requestOwner("remover a proteção"))) return;
  await app.run("Removendo proteção…", async () => {
    const out = await security.unprotect(await tab.currentBytes(), tab.security);
    await tab.replace(out, { password: null, ownerPassword: null });
    toast("Proteção removida. Salve o documento (Ctrl+S) para gravar.", { duration: 6000 });
  });
}

// ---- Compressão ----

export async function compress(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.MODIFY, "comprimir o documento"))) return;
  const dialog = $("#compress-dialog");
  const before = await tab.currentBytes();
  $("[data-size]", dialog).textContent = `Tamanho atual: ${formatBytes(before.length)}.`;
  if (!(await openDialog(dialog))) return;
  const { level } = formValues($("form", dialog));
  await app.run("Comprimindo…", async () => {
    const doc = await security.loadForEdit(before, tab.encrypted ? tab.security : null);
    const result = await compressDocument(doc, level, (k, n) => setBusy(`Comprimindo imagens… ${k}/${n}`));
    setBusy("Salvando…");
    const out = await security.saveFromEdit(doc, tab.encrypted ? tab.security : null);
    if (out.length >= before.length * 0.98) {
      toast(
        result.images
          ? "Este PDF já está bem comprimido: não foi possível diminuir mais."
          : "Este PDF quase não tem imagens, então não há o que comprimir.",
        { duration: 6000 },
      );
      return;
    }
    await tab.replace(out, { previous: before });
    if (!/\(comprimido\)/.test(tab.name)) {
      tab.name = `${baseName(tab.name)} (comprimido).pdf`;
      tab.path = null;
      app.manager.render();
      app.updateTitle();
    }
    const saved = Math.round((1 - out.length / before.length) * 100);
    toast(`${formatBytes(before.length)} → ${formatBytes(out.length)} (${saved}% menor). Salve para gravar o arquivo comprimido.`, { duration: 7000 });
  });
}

// ---- Propriedades ----

const PAPER_SIZES = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Carta: [216, 279], Ofício: [216, 356] };

function paperName(wMm, hMm) {
  const [a, b] = [Math.min(wMm, hMm), Math.max(wMm, hMm)];
  for (const [name, [w, h]] of Object.entries(PAPER_SIZES)) {
    if (Math.abs(a - w) < 3 && Math.abs(b - h) < 3) return name;
  }
  return null;
}

function formatDate(value) {
  const date = value && pdfjsLib.PDFDateString.toDateObject(value);
  return date ? date.toLocaleString("pt-BR") : "";
}

function describeRestrictions(tab) {
  if (!tab.encrypted) return "Nenhuma";
  const P = tab.security.P;
  const denied = [];
  if (!(P & Perm.PRINT)) denied.push("impressão");
  if (!(P & Perm.MODIFY)) denied.push("edição");
  if (!(P & Perm.COPY)) denied.push("cópia");
  if (!(P & Perm.ANNOTATE)) denied.push("comentários");
  if (!(P & Perm.ASSEMBLE)) denied.push("reorganizar páginas");
  if (!denied.length) return "Nenhuma";
  return `Não permite ${denied.join(", ")}${tab.owner ? " (liberadas nesta sessão)" : ""}`;
}

export async function properties(app) {
  const tab = requireTab(app);
  const doc = tab.doc;
  const [{ info }, page] = await Promise.all([doc.getMetadata(), doc.getPage(1)]);
  const [x0, y0, x1, y1] = page.view;
  const wMm = ((x1 - x0) / 72) * 25.4;
  const hMm = ((y1 - y0) / 72) * 25.4;
  const paper = paperName(wMm, hMm);
  const rows = [
    ["Arquivo", tab.name],
    ["Local", tab.path],
    ["Título", info.Title],
    ["Autor", info.Author],
    ["Assunto", info.Subject],
    ["Aplicativo", info.Creator],
    ["Produtor do PDF", info.Producer],
    ["Criado em", formatDate(info.CreationDate)],
    ["Modificado em", formatDate(info.ModDate)],
    ["Versão do PDF", info.PDFFormatVersion],
    ["Páginas", doc.numPages],
    ["Tamanho da página", `${wMm.toFixed(0)} × ${hMm.toFixed(0)} mm${paper ? ` (${paper})` : ""}`],
    ["Tamanho do arquivo", formatBytes(tab.size || 0)],
    ["Formulário", info.IsAcroFormPresent || info.IsXFAPresent ? "Sim" : "Não"],
    ["Assinaturas digitais", info.IsSignaturesPresent ? "Sim" : "Não"],
    ["Protegido por senha", tab.encrypted ? (tab.password ? "Sim (senha para abrir)" : "Sim (só restrições)") : "Não"],
    ["Restrições", describeRestrictions(tab)],
  ];
  const list = $("#properties-list");
  list.replaceChildren();
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    list.append(el("dt", { text: label }), el("dd", { text: String(value) }));
  }
  await openDialog("#properties-dialog");
}
