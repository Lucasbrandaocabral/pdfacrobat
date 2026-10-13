// Converter: páginas em imagens (PNG/JPG), texto (.txt) e Word (.docx).
import { LOAD_OPTIONS, fontRealName, pdfjsLib } from "../pdfjs.js";
import { $, UserError, baseName, formValues, openDialog, parsePageRange, setBusy, toast } from "../ui.js";
import { Perm } from "../pdf/security.js";
import * as platform from "../platform.js";

function requireTab(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  return tab;
}

/** Documento PDF.js separado com o estado atual (inclui anotações). */
async function snapshot(tab) {
  const bytes = await tab.currentBytes();
  return pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice(), password: tab.security?.userPassword ?? tab.password ?? undefined }).promise;
}

export async function exportImages(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.COPY, "extrair o conteúdo"))) return;
  const dialog = $("#export-images-dialog");
  if (!(await openDialog(dialog))) return;
  const v = formValues($("form", dialog));
  await app.run("Convertendo em imagens…", async () => {
    const pages = parsePageRange(v.pages, tab.doc.numPages);
    const doc = await snapshot(tab);
    const scale = Number(v.dpi) / 72;
    const ext = v.format === "jpeg" ? "jpg" : "png";
    const files = [];
    try {
      for (const [k, index] of pages.entries()) {
        setBusy(`Convertendo página ${k + 1} de ${pages.length}…`);
        const page = await doc.getPage(index + 1);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, `image/${v.format}`, 0.9));
        files.push({ name: `${baseName(tab.name)} - página ${index + 1}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
        canvas.width = canvas.height = 0;
      }
    } finally {
      doc.destroy();
    }
    const result = await platform.saveFiles(files, { zipName: `${baseName(tab.name)} (imagens).zip` });
    if (result) toast(`${files.length} imagem(ns) salva(s) em ${result.where}.`, { duration: 6000 });
  });
}

/** Linhas de texto de uma página, com tamanho e estilo da fonte. */
async function pageLines(page) {
  const content = await page.getTextContent();
  const lines = [];
  let line = null;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const size = Math.hypot(item.transform[2], item.transform[3]) || 10;
    const y = item.transform[5];
    if (!line || Math.abs(line.y - y) > size * 0.6) {
      line = { y, size, text: "", bold: false, italic: false };
      lines.push(line);
    }
    if (item.str) {
      const needsSpace = line.text && !/\s$/.test(line.text) && !/^\s/.test(item.str) && line.lastX !== undefined && item.transform[4] - line.lastX > size * 0.15;
      line.text += (needsSpace ? " " : "") + item.str;
      line.lastX = item.transform[4] + item.width;
      line.size = Math.max(line.size, size);
      const name = fontRealName(page, item.fontName);
      if (/bold|black|heavy|semibold/i.test(name)) line.bold = true;
      if (/italic|oblique/i.test(name)) line.italic = true;
    }
    if (item.hasEOL) line = null;
  }
  return lines.filter((l) => l.text.trim());
}

/** Agrupa linhas próximas em parágrafos. */
function paragraphs(lines) {
  const out = [];
  let current = null;
  let previous = null;
  for (const line of lines) {
    const gap = previous ? previous.y - line.y : 0;
    const sameStyle = current && Math.abs(current.size - line.size) < 1.5 && current.bold === line.bold;
    if (current && sameStyle && gap > 0 && gap < line.size * 1.75) {
      current.text = current.text.endsWith("-") ? current.text.slice(0, -1) + line.text.trim() : `${current.text} ${line.text.trim()}`;
    } else {
      current = { text: line.text.trim(), size: line.size, bold: line.bold, italic: line.italic };
      out.push(current);
    }
    previous = line;
  }
  return out;
}

export async function exportText(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.COPY, "extrair o texto"))) return;
  await app.run("Extraindo texto…", async () => {
    const chunks = [];
    for (let n = 1; n <= tab.doc.numPages; n++) {
      setBusy(`Extraindo texto… página ${n}/${tab.doc.numPages}`);
      const lines = await pageLines(await tab.doc.getPage(n));
      chunks.push(paragraphs(lines).map((p) => p.text).join("\n\n"));
    }
    const text = chunks.join("\n\n\f\n\n").trim();
    if (!text.replace(/\f/g, "").trim()) {
      throw new UserError("Este PDF não tem texto selecionável. Use Reconhecer texto (OCR) primeiro.");
    }
    const data = new TextEncoder().encode(`﻿${text}\n`);
    const saved = await platform.saveFile(data, { suggestedName: `${baseName(tab.name)}.txt`, saveAs: true, filter: "text" });
    if (saved) toast("Texto salvo.");
  });
}

export async function exportWord(app) {
  const tab = requireTab(app);
  if (!(await app.guard(tab, Perm.COPY, "extrair o texto"))) return;
  await app.run("Convertendo em Word…", async () => {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const children = [];
    let hasText = false;
    for (let n = 1; n <= tab.doc.numPages; n++) {
      setBusy(`Convertendo em Word… página ${n}/${tab.doc.numPages}`);
      const paras = paragraphs(await pageLines(await tab.doc.getPage(n)));
      if (paras.length) hasText = true;
      const sizes = paras.map((p) => p.size).sort((a, b) => a - b);
      const body = sizes[Math.floor(sizes.length / 2)] || 11;
      paras.forEach((p, k) => {
        // Mantém a proporção dos tamanhos, com o corpo do texto em 11 pt.
        const size = Math.round(Math.min(48, Math.max(7, (p.size / body) * 11)) * 2);
        children.push(
          new Paragraph({
            pageBreakBefore: k === 0 && n > 1,
            spacing: { after: 120 },
            children: [new TextRun({ text: p.text, bold: p.bold || p.size > body * 1.3, italics: p.italic, size })],
          }),
        );
      });
      if (!paras.length && n > 1) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    }
    if (!hasText) throw new UserError("Este PDF não tem texto selecionável. Use Reconhecer texto (OCR) primeiro.");
    const document = new Document({
      creator: "PDF Acrobat",
      title: baseName(tab.name),
      styles: { default: { document: { run: { font: "Calibri" } } } },
      sections: [{ children }],
    });
    const blob = await Packer.toBlob(document);
    const saved = await platform.saveFile(new Uint8Array(await blob.arrayBuffer()), {
      suggestedName: `${baseName(tab.name)}.docx`,
      saveAs: true,
      filter: "word",
    });
    if (saved) toast("Documento do Word salvo. O layout é simplificado: o texto vem em parágrafos.", { duration: 6000 });
  });
}
