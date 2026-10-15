// Reparar PDF: refaz o arquivo a partir do que dá para ler e mostra o que foi
// consertado. Vale para o documento aberto (um arquivo que abre aqui mas dá
// erro em outros programas ou em sites que conferem o PDF) e para um arquivo
// que nem abre (download interrompido, por exemplo), oferecido ao abrir.
import { PDFDocument } from "@cantoo/pdf-lib";
import { $, UserError, baseName, confirmAction, el, openDialog, setBusy } from "../ui.js";
import { Perm, saveFromEdit } from "../pdf/security.js";
import { LOAD_OPTIONS, pdfjsLib } from "../pdfjs.js";
import { describeRepair, inspectBytes, loadDamaged, repairDocument } from "../pdf/repair.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Refaz os bytes com o pdf-lib; devolve { bytes, pages, parts } ou lança. */
async function rebuild(bytes, security = null) {
  const password = security ? (security.ownerPassword ?? security.userPassword ?? "") : undefined;
  const { doc, header } = await loadDamaged(bytes, { password });
  const report = { ...repairDocument(doc), header, ...inspectBytes(bytes) };
  if (!report.pages) throw new UserError("Nenhuma página do arquivo pôde ser lida.");
  if (report.unreadable) throw new UserError("O conteúdo das páginas não pôde ser lido (o arquivo pode estar protegido por senha ou danificado demais).");
  // Índice clássico (sem pacotes de objetos), que qualquer leitor entende.
  const out = await saveFromEdit(doc, security, { useObjectStreams: false });
  return { bytes: out, pages: report.pages, parts: describeRepair(report) };
}

/**
 * Último recurso, quando a estrutura não dá para refazer mas o leitor mostra
 * as páginas: cada página vira uma imagem num PDF novo (o texto deixa de ser
 * selecionável; o OCR devolve).
 */
async function rebuildAsImages(pdf, security = null) {
  const doc = await PDFDocument.create();
  let lost = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    setBusy(`Recuperando as páginas como imagem… ${n}/${pdf.numPages}`);
    try {
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(150 / 72, Math.sqrt(12e6 / (size.width * size.height)));
      const viewport = page.getViewport({ scale });
      const canvas = el("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      canvas.width = canvas.height = 0;
      const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      doc.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      page.cleanup();
    } catch (err) {
      console.warn("página", n, err);
      lost++;
    }
  }
  if (lost === pdf.numPages) throw new UserError("Nenhuma página do arquivo pôde ser lida.");
  const parts = ["a estrutura do arquivo não dava para refazer: as páginas foram recuperadas como imagem (o texto delas deixa de ser selecionável; use Reconhecer texto (OCR) para trazê-lo de volta)"];
  if (lost) parts.push(`${plural(lost, "página não pôde ser lida", "páginas não puderam ser lidas")}`);
  // Um documento protegido por senha continua protegido.
  return { bytes: await saveFromEdit(doc, security), pages: pdf.numPages - lost, parts };
}

/** Mostra o que foi consertado. */
async function showReport({ pages, parts }, { opened = false } = {}) {
  const dialog = $("#repair-dialog");
  const what = opened ? `O arquivo reparado foi aberto numa aba nova, com ${plural(pages, "página", "páginas")}.` : `O arquivo foi refeito, com ${plural(pages, "página", "páginas")}.`;
  $(".message", dialog).textContent = parts.length
    ? `${what} Salve para gravar a versão reparada. O que foi feito:`
    : `${what} Nenhum problema apareceu: o arquivo foi regravado com estrutura e índice novos, o que resolve erros em programas e sites mais exigentes. Salve para gravar.`;
  $(".repair-list", dialog).replaceChildren(...parts.map((text) => el("li", { text: text.replace(/^./, (c) => c.toUpperCase()) })));
  await openDialog(dialog, { focus: 'button[value="ok"]' });
}

/** Repara o documento aberto (Desfazer volta ao arquivo como estava). */
export async function repair(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.MODIFY, "reparar o arquivo"))) return;
  let result = null;
  await app.run("Reparando o arquivo…", async () => {
    const before = await tab.currentBytes();
    const security = tab.encrypted ? tab.security : null;
    try {
      result = await rebuild(before, security);
    } catch (err) {
      console.warn("refazer a estrutura", err);
      result = await rebuildAsImages(tab.doc, security);
    }
    setBusy("Reparando o arquivo…");
    await tab.replace(result.bytes, { keepView: true, previous: before });
  });
  if (result) await showReport(result);
}

/**
 * Um arquivo que não abriu: pergunta se quer tentar reparar e, se der, abre
 * a versão reparada numa aba nova (o arquivo original não muda).
 */
export async function repairAndOpen(app, bytes, name) {
  const ok = await confirmAction({
    title: "Arquivo danificado",
    message: `“${name}” não abriu: o arquivo parece estar danificado (um download que não terminou, por exemplo). Tentar reparar? O arquivo original não é alterado.`,
    ok: "Reparar",
  });
  if (!ok) return null;
  let result = null;
  let tab = null;
  await app.run("Reparando o arquivo…", async () => {
    // Sem "%PDF-" nem objetos de PDF no começo: é outro tipo de arquivo com o nome terminado em .pdf.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 65536));
    if (!/%PDF-|\d+\s+\d+\s+obj/.test(head)) throw new UserError(`“${name}” não é um PDF (talvez seja outro tipo de arquivo com o nome terminado em .pdf).`);
    try {
      result = await rebuild(bytes);
    } catch (err) {
      console.warn("refazer a estrutura", err);
      if (/encrypt/i.test(`${err?.name} ${err?.message}`)) throw new UserError(`“${name}” é protegido por senha e está danificado: sem abrir com a senha, não dá para reparar.`);
      throw new UserError(`Não foi possível reparar “${name}”: ${err?.userMessage || "o arquivo está danificado demais."}`);
    }
    // Confere que o leitor abre a versão reparada.
    try {
      const check = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: result.bytes.slice() }).promise;
      await check.destroy();
    } catch (err) {
      console.warn("conferir a versão reparada", err);
      throw new UserError(`Não foi possível reparar “${name}”: o arquivo está danificado demais.`);
    }
    tab = await app.manager.open(result.bytes, { name: `${baseName(name)} (reparado).pdf`, dirty: true });
  });
  if (tab && result) await showReport(result, { opened: true });
  return tab;
}
