// Reconhecimento de texto (OCR) com Tesseract, que roda localmente (sem
// enviar o documento para a internet).
import { LOAD_OPTIONS, pdfjsLib } from "../pdfjs.js";
import { $, UserError, formValues, openDialog, parsePageRange, setBusy, toast } from "../ui.js";
import { Perm } from "../pdf/security.js";
import { addInvisibleText } from "../pdf/ocrtext.js";

const OCR_DPI = 300;

async function createOcrWorker(lang, onProgress) {
  const { createWorker } = await import("tesseract.js");
  const base = new URL("./tesseract/", document.baseURI).href;
  return createWorker(lang.split("+"), 1, {
    workerPath: `${base}worker.min.js`,
    corePath: base,
    langPath: `${base}lang`,
    gzip: true,
    cacheMethod: "none",
    workerBlobURL: false,
    logger: (m) => onProgress?.(m),
  });
}

/** Páginas que praticamente não têm texto (escaneadas ou fotos). */
async function pagesWithoutText(doc) {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const chars = content.items.reduce((sum, item) => sum + (item.str?.trim().length || 0), 0);
    if (chars < 25) out.push(n - 1);
  }
  return out;
}

function collectWords(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (word.text?.trim() && word.confidence > 30) words.push(word);
        }
      }
    }
  }
  return words;
}

export async function ocr(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.MODIFY, "alterar o documento"))) return;
  const dialog = $("#ocr-dialog");
  if (!(await openDialog(dialog))) return;
  const v = formValues($("form", dialog));

  await app.run("Preparando o reconhecimento de texto…", async () => {
    const pages = v.scope === "auto" ? await pagesWithoutText(tab.doc) : parsePageRange(v.pages, tab.doc.numPages);
    if (!pages.length) {
      toast("Todas as páginas já têm texto. Para reconhecer mesmo assim, escolha as páginas manualmente.", { duration: 7000 });
      return;
    }
    let status = "Carregando o reconhecimento de texto…";
    let current = 0;
    const show = (progress) => setBusy(`${status}${progress != null ? ` ${Math.round(progress * 100)}%` : ""}`);
    show();
    const worker = await createOcrWorker(v.lang, (m) => {
      if (m.status === "recognizing text") show(m.progress);
    });
    const results = [];
    try {
      const bytes = await tab.currentBytes();
      const doc = await pdfjsLib.getDocument({ ...LOAD_OPTIONS, data: bytes.slice(), password: tab.security?.userPassword ?? tab.password ?? undefined }).promise;
      try {
        for (const index of pages) {
          current++;
          status = `Reconhecendo texto: página ${index + 1} (${current} de ${pages.length})…`;
          show(0);
          const page = await doc.getPage(index + 1);
          const viewport = page.getViewport({ scale: OCR_DPI / 72 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
          canvas.width = canvas.height = 0;
          const words = collectWords(data.blocks).map((w) => {
            const { x0, y0, x1, y1 } = w.bbox;
            const scale = viewport.scale;
            return {
              text: w.text,
              origin: viewport.convertToPdfPoint(x0, y1),
              width: (x1 - x0) / scale,
              height: (y1 - y0) / scale,
            };
          });
          results.push({ index, words, rotation: page.rotate });
        }
      } finally {
        doc.destroy();
      }
    } finally {
      await worker.terminate();
    }
    const total = results.reduce((sum, r) => sum + r.words.length, 0);
    if (!total) {
      toast("Nenhum texto foi reconhecido nas páginas escolhidas.", { duration: 6000 });
      return;
    }
    setBusy("Gravando o texto reconhecido…");
    await tab.edit(async (pdf) => {
      for (const r of results) await addInvisibleText(pdf, r.index, r.words, r.rotation);
    });
    toast(`Texto reconhecido em ${results.length} página(s) (${total} palavras). Agora dá para pesquisar e copiar.`, { duration: 7000 });
  });
}
