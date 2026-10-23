// Comparar duas versões: diferenças de texto palavra a palavra, num novo PDF
// com resumo e as páginas lado a lado (vermelho = saiu, verde = entrou).
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { PermissionFlag, getTextItems, loadPdf } from "../pdfjs.js";
import { $, UserError, askText, baseName, el, formValues, openDialog, setBusy, toast } from "../ui.js";
import { encodable } from "../pdf/textedit.js";
import { Perm, isOwnerPassword, readEncryption } from "../pdf/security.js";
import * as platform from "../platform.js";

const RED = [0.83, 0.18, 0.18];
const GREEN = [0.18, 0.49, 0.2];

const measureContext = document.createElement("canvas").getContext("2d");

/** Largura relativa dos caracteres, medida com uma fonte parecida com a do PDF. */
function measurer(fontFamily) {
  measureContext.font = `100px ${fontFamily || "sans-serif"}`;
  return (text) => measureContext.measureText(text).width;
}

/** Palavras com a posição de cada uma dentro do trecho de texto. */
async function extractWords(doc) {
  const words = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const items = await getTextItems(page);
    for (const item of items) {
      const measure = measurer(item.fontFamily);
      const total = measure(item.str) || 1;
      const cos = Math.cos(item.angle);
      const sin = Math.sin(item.angle);
      for (const match of item.str.matchAll(/\S+/g)) {
        const start = (measure(item.str.slice(0, match.index)) / total) * item.width;
        const end = (measure(item.str.slice(0, match.index + match[0].length)) / total) * item.width;
        const lo = item.descent * item.size;
        const hi = item.ascent * item.size;
        const pts = [
          [start, lo],
          [end, lo],
          [end, hi],
          [start, hi],
        ].map(([x, y]) => [item.origin[0] + x * cos - y * sin, item.origin[1] + x * sin + y * cos]);
        words.push({
          text: match[0],
          page: n - 1,
          rect: [
            Math.min(...pts.map((p) => p[0])),
            Math.min(...pts.map((p) => p[1])),
            Math.max(...pts.map((p) => p[0])),
            Math.max(...pts.map((p) => p[1])),
          ],
        });
      }
    }
  }
  return words;
}

async function resolveSource(app, choice) {
  if (choice.startsWith("tab:")) {
    const tab = app.manager.tabs.find((t) => String(t.id) === choice.slice(4));
    if (!tab) throw new UserError("O documento escolhido foi fechado.");
    // O relatório reproduz o texto e as páginas: precisa da permissão de copiar.
    if (!(await app.guard(tab, Perm.COPY, "copiar o conteúdo, que a comparação reproduz no relatório"))) return null;
    return { name: tab.name, bytes: await tab.currentBytes(), password: tab.security?.ownerPassword ?? tab.security?.userPassword ?? tab.password, checked: true };
  }
  const [file] = await platform.pickFiles({ kind: "pdf" });
  if (!file) return null;
  return { name: file.name, bytes: file.data, password: null };
}

/** Arquivo escolhido do disco que proíbe copiar: só com a senha de permissões. */
async function requireCopy(src, doc) {
  if (src.checked) return;
  const allowed = await doc.getPermissions();
  if (!allowed || allowed.includes(PermissionFlag.COPY)) return;
  const info = await readEncryption(src.bytes);
  if (info && src.password && isOwnerPassword(info, src.password)) return;
  throw new UserError(
    `O autor de "${src.name}" não permite copiar o conteúdo, e a comparação o reproduz no relatório. Abra o arquivo aqui e libere as restrições com a senha de permissões antes de comparar.`,
  );
}

function wrapLines(text, font, size, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function summarize(parts, oldWords, newWords) {
  const changes = [];
  let oi = 0;
  let ni = 0;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (!part.added && !part.removed) {
      oi += part.count;
      ni += part.count;
      continue;
    }
    const change = { removed: [], added: [], oldPage: oldWords[oi]?.page ?? oldWords[oldWords.length - 1]?.page ?? 0, newPage: newWords[ni]?.page ?? newWords[newWords.length - 1]?.page ?? 0 };
    if (part.removed) {
      change.removed = oldWords.slice(oi, oi + part.count);
      oi += part.count;
      if (parts[k + 1]?.added) {
        k++;
        change.added = newWords.slice(ni, ni + parts[k].count);
        ni += parts[k].count;
      }
    } else {
      change.added = newWords.slice(ni, ni + part.count);
      ni += part.count;
    }
    changes.push(change);
  }
  return changes;
}

async function buildReport({ oldSrc, newSrc, oldWords, newWords, changes }) {
  const out = await PDFDocument.create();
  out.setTitle(`Comparação: ${oldSrc.name} x ${newSrc.name}`);
  out.setProducer("PDF Acrobat");
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const removedCount = changes.reduce((s, c) => s + c.removed.length, 0);
  const addedCount = changes.reduce((s, c) => s + c.added.length, 0);

  // Resumo
  const W = 595.28;
  const H = 841.89;
  const M = 48;
  let page = out.addPage([W, H]);
  let y = H - M;
  const write = (text, { size = 10, f = font, color = [0.15, 0.15, 0.15], indent = 0 } = {}) => {
    for (const line of wrapLines(encodable(text, f), f, size, W - 2 * M - indent)) {
      if (y < M + size) {
        page = out.addPage([W, H]);
        y = H - M;
      }
      y -= size * 1.35;
      page.drawText(line, { x: M + indent, y, size, font: f, color: rgb(...color) });
    }
  };
  write("Comparação de documentos", { size: 20, f: bold });
  y -= 6;
  write(`Versão antiga: ${oldSrc.name}`);
  write(`Versão nova: ${newSrc.name}`);
  write(`Gerado em ${new Date().toLocaleString("pt-BR")}`, { color: [0.45, 0.45, 0.45] });
  y -= 8;
  write(
    changes.length
      ? `${changes.length} alteração(ões): ${removedCount} palavra(s) removida(s) e ${addedCount} palavra(s) adicionada(s).`
      : "Nenhuma diferença de texto encontrada.",
    { size: 12, f: bold },
  );
  y -= 6;
  const LIMIT = 400;
  for (const change of changes.slice(0, LIMIT)) {
    y -= 4;
    const pages =
      change.oldPage === change.newPage
        ? `Página ${change.oldPage + 1}`
        : `Página ${change.oldPage + 1} (antiga) / ${change.newPage + 1} (nova)`;
    const where =
      change.removed.length && change.added.length
        ? `${pages}: alterado`
        : change.removed.length
          ? `Página ${change.oldPage + 1}: removido`
          : `Página ${change.newPage + 1}: adicionado`;
    write(where, { size: 9, f: bold, color: [0.35, 0.35, 0.35] });
    if (change.removed.length) write(`- ${change.removed.map((w) => w.text).join(" ")}`, { color: RED, indent: 8 });
    if (change.added.length) write(`+ ${change.added.map((w) => w.text).join(" ")}`, { color: GREEN, indent: 8 });
  }
  if (changes.length > LIMIT) write(`… e mais ${changes.length - LIMIT} alterações.`, { color: [0.45, 0.45, 0.45] });

  // Páginas lado a lado
  const oldDoc = await PDFDocument.load(oldSrc.bytes, { password: oldSrc.password ?? undefined, updateMetadata: false });
  const newDoc = await PDFDocument.load(newSrc.bytes, { password: newSrc.password ?? undefined, updateMetadata: false });
  const oldPages = await out.embedPages(oldDoc.getPages());
  const newPages = await out.embedPages(newDoc.getPages());
  const removedByPage = new Map();
  const addedByPage = new Map();
  for (const c of changes) {
    for (const w of c.removed) (removedByPage.get(w.page) || removedByPage.set(w.page, []).get(w.page)).push(w.rect);
    for (const w of c.added) (addedByPage.get(w.page) || addedByPage.set(w.page, []).get(w.page)).push(w.rect);
  }
  const GAP = 24;
  const HEAD = 28;
  for (let i = 0; i < Math.max(oldPages.length, newPages.length); i++) {
    const a = oldPages[i];
    const b = newPages[i];
    const wa = a?.width ?? b.width;
    const wb = b?.width ?? a.width;
    const height = Math.max(a?.height ?? 0, b?.height ?? 0) + HEAD + 2 * 12;
    const sheet = out.addPage([wa + wb + GAP + 2 * 12, height]);
    const top = height - 12 - HEAD;
    const place = (embedded, x, label, rects, color) => {
      sheet.drawText(label, { x, y: height - 12 - 14, size: 11, font: bold, color: rgb(...color) });
      if (!embedded) {
        sheet.drawText("(sem página correspondente)", { x, y: top - 20, size: 10, font, color: rgb(0.5, 0.5, 0.5) });
        return;
      }
      const y0 = top - embedded.height;
      sheet.drawRectangle({ x, y: y0, width: embedded.width, height: embedded.height, color: rgb(1, 1, 1), borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.5 });
      sheet.drawPage(embedded, { x, y: y0 });
      const box = embedded.embedder?.boundingBox || { left: 0, bottom: 0 };
      for (const [rx0, ry0, rx1, ry1] of rects || []) {
        sheet.drawRectangle({
          x: x + rx0 - box.left,
          y: y0 + ry0 - box.bottom,
          width: rx1 - rx0,
          height: ry1 - ry0,
          color: rgb(...color),
          opacity: 0.3,
        });
      }
    };
    place(a, 12, `Versão antiga — página ${i + 1}`, removedByPage.get(i), RED);
    place(b, 12 + wa + GAP, `Versão nova — página ${i + 1}`, addedByPage.get(i), GREEN);
    sheet.drawLine({ start: { x: 12 + wa + GAP / 2, y: 12 }, end: { x: 12 + wa + GAP / 2, y: height - 12 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  }
  return out.save();
}

export async function compare(app) {
  const dialog = $("#compare-dialog");
  const form = $("form", dialog);
  const options = [
    ...app.manager.tabs.map((t) => el("option", { value: `tab:${t.id}`, text: `Aberto: ${t.name}` })),
    el("option", { value: "file", text: "Escolher arquivo…" }),
  ];
  form.elements.old.replaceChildren(...options.map((o) => o.cloneNode(true)));
  form.elements.new.replaceChildren(...options);
  const tabs = app.manager.tabs;
  form.elements.old.value = tabs.length > 1 ? `tab:${tabs[0].id}` : tabs.length ? `tab:${tabs[0].id}` : "file";
  form.elements.new.value = tabs.length > 1 ? `tab:${app.manager.active?.id ?? tabs[1].id}` : "file";
  if (form.elements.old.value === form.elements.new.value && tabs.length > 1) form.elements.old.value = `tab:${tabs.find((t) => t !== app.manager.active).id}`;
  $("#compare-swap").onclick = () => {
    const a = form.elements.old.value;
    form.elements.old.value = form.elements.new.value;
    form.elements.new.value = a;
  };
  if (!(await openDialog(dialog))) return;
  const v = formValues(form);
  const oldSrc = await resolveSource(app, v.old);
  if (!oldSrc) return;
  const newSrc = await resolveSource(app, v.new);
  if (!newSrc) return;

  const result = await app.run("Comparando…", async () => {
    const askPassword = (name) => (incorrect) =>
      askText({ title: "Documento protegido", label: `${incorrect ? "Senha incorreta. " : ""}Senha de "${name}":`, password: true });
    setBusy("Lendo a versão antiga…");
    const a = await loadPdf(oldSrc.bytes, { password: oldSrc.password, onPassword: askPassword(oldSrc.name) });
    oldSrc.password = a.password;
    setBusy("Lendo a versão nova…");
    const b = await loadPdf(newSrc.bytes, { password: newSrc.password, onPassword: askPassword(newSrc.name) }).catch((err) => {
      a.doc.destroy();
      throw err;
    });
    newSrc.password = b.password;
    let oldWords;
    let newWords;
    try {
      await requireCopy(oldSrc, a.doc);
      await requireCopy(newSrc, b.doc);
      oldWords = await extractWords(a.doc);
      newWords = await extractWords(b.doc);
    } finally {
      a.doc.destroy();
      b.doc.destroy();
    }
    if (!oldWords.length && !newWords.length) {
      throw new UserError("Os documentos não têm texto para comparar. Se forem escaneados, use o OCR antes.");
    }
    setBusy("Procurando diferenças…");
    const { diffArrays } = await import("diff");
    const parts = diffArrays(
      oldWords.map((w) => w.text),
      newWords.map((w) => w.text),
      { timeout: 20000 },
    );
    if (!parts) throw new UserError("Os documentos são diferentes demais para comparar palavra a palavra.");
    const changes = summarize(parts, oldWords, newWords);
    setBusy("Montando o relatório…");
    const bytes = await buildReport({ oldSrc, newSrc, oldWords, newWords, changes });
    return { bytes, changes };
  });
  if (!result) return;
  await app.openDocument(result.bytes, { name: `Comparação - ${baseName(oldSrc.name)} x ${baseName(newSrc.name)}.pdf` });
  toast(result.changes.length ? `${result.changes.length} diferença(s) encontrada(s).` : "Nenhuma diferença de texto encontrada.", { duration: 6000 });
}
