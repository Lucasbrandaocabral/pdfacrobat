// Anotações PDF reais (comentários) com aparência própria, para que apareçam
// iguais em qualquer leitor: sublinhado, tachado, destaque, nota, formas e carimbos.
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
  appendBezierCurve,
  beginText,
  closePath,
  endText,
  fill,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
} from "@cantoo/pdf-lib";

export const ANNOTATION_LABELS = {
  Text: "Nota",
  FreeText: "Texto",
  Highlight: "Destaque",
  Underline: "Sublinhado",
  StrikeOut: "Tachado",
  Squiggly: "Ondulado",
  Square: "Retângulo",
  Circle: "Elipse",
  Line: "Linha",
  Polygon: "Polígono",
  PolyLine: "Polilinha",
  Ink: "Desenho",
  Stamp: "Carimbo",
  Caret: "Inserção",
  FileAttachment: "Anexo",
};

export const STAMPS = {
  aprovado: { label: "APROVADO", color: [0.1, 0.5, 0.22], name: "Approved" },
  reprovado: { label: "REPROVADO", color: [0.78, 0.16, 0.16], name: "NotApproved" },
  confidencial: { label: "CONFIDENCIAL", color: [0.78, 0.16, 0.16], name: "Confidential" },
  rascunho: { label: "RASCUNHO", color: [0.85, 0.42, 0.0], name: "Draft" },
  recebido: { label: "RECEBIDO", color: [0.08, 0.4, 0.75], name: "NotForPublicRelease" },
  revisado: { label: "REVISADO", color: [0.08, 0.4, 0.75], name: "Final" },
  pago: { label: "PAGO", color: [0.1, 0.5, 0.22], name: "Approved" },
};

const pad2 = (n) => String(n).padStart(2, "0");

/** Data no formato do PDF: D:AAAAMMDDHHmmSS-03'00' */
export function pdfDate(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `D:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}'${pad2(abs % 60)}'`
  );
}

export function formatDateTime(date = new Date()) {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const text = (value) => PDFHexString.fromText(value);
const uid = () => `pdfacrobat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function bbox(points, margin = 0) {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

function baseDict(doc, page, subtype, rect, { color, contents, author, opacity = 1 }) {
  const now = pdfDate();
  const dict = doc.context.obj({
    Type: "Annot",
    Subtype: subtype,
    Rect: rect,
    F: 4,
    P: page.ref,
    NM: PDFString.of(uid()),
    M: PDFString.of(now),
    CreationDate: PDFString.of(now),
  });
  if (color) dict.set(PDFName.of("C"), doc.context.obj(color));
  if (opacity < 1) dict.set(PDFName.of("CA"), PDFNumber.of(opacity));
  if (author) dict.set(PDFName.of("T"), text(author));
  if (contents) dict.set(PDFName.of("Contents"), text(contents));
  return dict;
}

function setAppearance(doc, dict, operators, { bbox: box, resources, matrix }) {
  const extra = { BBox: box };
  if (resources) extra.Resources = resources;
  if (matrix) extra.Matrix = matrix;
  const stream = doc.context.formXObject(operators, extra);
  dict.set(PDFName.of("AP"), doc.context.obj({ N: doc.context.register(stream) }));
}

function attach(doc, pageIndex, dict) {
  const page = doc.getPage(pageIndex);
  const ref = doc.context.register(dict);
  page.node.addAnnot(ref);
  return ref;
}

/**
 * Sublinhado, tachado ou destaque sobre trechos de texto. `quads` são
 * retângulos [x0, y0, x1, y1] em coordenadas do PDF (um por linha).
 */
export function addTextMarkup(doc, pageIndex, { kind, quads, color, author, contents, rotation = 0 }) {
  const page = doc.getPage(pageIndex);
  const quadPoints = [];
  for (const [x0, y0, x1, y1] of quads) quadPoints.push(x0, y1, x1, y1, x0, y0, x1, y0);
  const rect = bbox(quadPoints, 1);
  const dict = baseDict(doc, page, kind, rect, { color, author, contents });
  dict.set(PDFName.of("QuadPoints"), doc.context.obj(quadPoints));

  const ops = [pushGraphicsState()];
  let resources;
  if (kind === "Highlight") {
    resources = { ExtGState: { GS0: { Type: "ExtGState", BM: "Multiply", CA: 1, ca: 1 } } };
    ops.push(setGraphicsState("GS0"), setFillingRgbColor(...color));
    for (const [x0, y0, x1, y1] of quads) {
      ops.push(moveTo(x0, y0), lineTo(x1, y0), lineTo(x1, y1), lineTo(x0, y1), closePath(), fill());
    }
  } else {
    // A linha acompanha o texto como ele aparece na tela, mesmo em páginas giradas.
    const fraction = kind === "Underline" ? 0.08 : 0.42;
    ops.push(setStrokingRgbColor(...color), setLineCap(1));
    for (const [x0, y0, x1, y1] of quads) {
      const vertical = rotation % 180 !== 0;
      const h = vertical ? x1 - x0 : y1 - y0;
      ops.push(setLineWidth(Math.max(0.8, h * (kind === "Underline" ? 0.07 : 0.06))));
      if (rotation === 90) {
        const x = x1 - h * fraction;
        ops.push(moveTo(x, y0), lineTo(x, y1), stroke());
      } else if (rotation === 270) {
        const x = x0 + h * fraction;
        ops.push(moveTo(x, y0), lineTo(x, y1), stroke());
      } else if (rotation === 180) {
        const y = y1 - h * fraction;
        ops.push(moveTo(x0, y), lineTo(x1, y), stroke());
      } else {
        const y = y0 + h * fraction;
        ops.push(moveTo(x0, y), lineTo(x1, y), stroke());
      }
    }
  }
  ops.push(popGraphicsState());
  setAppearance(doc, dict, ops, { bbox: rect, resources });
  return attach(doc, pageIndex, dict);
}

/** Nota adesiva (ícone de comentário). `point` é o canto superior esquerdo. */
export function addNote(doc, pageIndex, { point, contents, color = [1, 0.85, 0.2], author }) {
  const page = doc.getPage(pageIndex);
  const [x, y] = point;
  const dict = baseDict(doc, page, "Text", [x, y - 20, x + 20, y], { color, contents, author });
  dict.set(PDFName.of("Name"), PDFName.of("Comment"));
  dict.set(PDFName.of("Open"), doc.context.obj(false));
  return attach(doc, pageIndex, dict);
}

function ellipseOps(x0, y0, x1, y1) {
  const k = 0.5522847498;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
    closePath(),
  ];
}

/**
 * Formas: `kind` é "rect", "ellipse", "line" ou "arrow". `points` são
 * [x1, y1, x2, y2] em coordenadas do PDF (cantos opostos ou extremidades).
 */
export function addShape(doc, pageIndex, { kind, points, color, width = 2, author, contents }) {
  const page = doc.getPage(pageIndex);
  const [ax, ay, bx, by] = points;
  const half = width / 2;
  const style = [setStrokingRgbColor(...color), setLineWidth(width), setLineJoin(1), setLineCap(1)];

  if (kind === "rect" || kind === "ellipse") {
    const x0 = Math.min(ax, bx);
    const y0 = Math.min(ay, by);
    const x1 = Math.max(ax, bx);
    const y1 = Math.max(ay, by);
    const rect = [x0 - half, y0 - half, x1 + half, y1 + half];
    const dict = baseDict(doc, page, kind === "rect" ? "Square" : "Circle", rect, { color, author, contents });
    dict.set(PDFName.of("BS"), doc.context.obj({ W: width, S: "S" }));
    const path =
      kind === "rect"
        ? [moveTo(x0, y0), lineTo(x1, y0), lineTo(x1, y1), lineTo(x0, y1), closePath()]
        : ellipseOps(x0, y0, x1, y1);
    setAppearance(doc, dict, [pushGraphicsState(), ...style, ...path, stroke(), popGraphicsState()], { bbox: rect });
    return attach(doc, pageIndex, dict);
  }

  const arrow = kind === "arrow";
  const head = Math.max(8, width * 4);
  const rect = bbox(points, head + width);
  const dict = baseDict(doc, page, "Line", rect, { color, author, contents });
  dict.set(PDFName.of("L"), doc.context.obj(points));
  dict.set(PDFName.of("BS"), doc.context.obj({ W: width, S: "S" }));
  if (arrow) dict.set(PDFName.of("LE"), doc.context.obj(["None", "OpenArrow"]));
  const ops = [pushGraphicsState(), ...style, moveTo(ax, ay), lineTo(bx, by), stroke()];
  if (arrow) {
    const angle = Math.atan2(by - ay, bx - ax);
    const spread = Math.PI / 7;
    const p1 = [bx - head * Math.cos(angle - spread), by - head * Math.sin(angle - spread)];
    const p2 = [bx - head * Math.cos(angle + spread), by - head * Math.sin(angle + spread)];
    ops.push(moveTo(...p1), lineTo(bx, by), lineTo(...p2), stroke());
  }
  ops.push(popGraphicsState());
  setAppearance(doc, dict, ops, { bbox: rect });
  return attach(doc, pageIndex, dict);
}

/** Tamanho do carimbo (sem rotação), para posicionar a prévia na tela. */
export async function stampSize(doc, { label, subtitle }) {
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const w1 = bold.widthOfTextAtSize(label, 18);
  const w2 = subtitle ? regular.widthOfTextAtSize(subtitle, 7) : 0;
  return { width: Math.max(w1, w2) + 24, height: subtitle ? 42 : 32, bold, regular };
}

/**
 * Carimbo centrado em `center` (coordenadas do PDF). `rotation` é a rotação de
 * exibição da página: o carimbo é desenhado "em pé" na tela.
 */
export async function addStamp(doc, pageIndex, { stamp, subtitle, center, rotation = 0, author }) {
  const page = doc.getPage(pageIndex);
  const { width: W, height: H, bold, regular } = await stampSize(doc, { label: stamp.label, subtitle });
  const swap = rotation % 180 !== 0;
  const rw = swap ? H : W;
  const rh = swap ? W : H;
  const rect = [center[0] - rw / 2, center[1] - rh / 2, center[0] + rw / 2, center[1] + rh / 2];
  const dict = baseDict(doc, page, "Stamp", rect, { color: stamp.color, author, contents: stamp.label });
  dict.set(PDFName.of("Name"), PDFName.of(stamp.name));

  const [r, g, b] = stamp.color;
  const radius = 5;
  const k = 0.5522847498 * radius;
  const inset = 1.5;
  const x0 = inset;
  const y0 = inset;
  const x1 = W - inset;
  const y1 = H - inset;
  const border = [
    moveTo(x0 + radius, y0),
    lineTo(x1 - radius, y0),
    appendBezierCurve(x1 - radius + k, y0, x1, y0 + radius - k, x1, y0 + radius),
    lineTo(x1, y1 - radius),
    appendBezierCurve(x1, y1 - radius + k, x1 - radius + k, y1, x1 - radius, y1),
    lineTo(x0 + radius, y1),
    appendBezierCurve(x0 + radius - k, y1, x0, y1 - radius + k, x0, y1 - radius),
    lineTo(x0, y0 + radius),
    appendBezierCurve(x0, y0 + radius - k, x0 + radius - k, y0, x0 + radius, y0),
    closePath(),
  ];
  const labelWidth = bold.widthOfTextAtSize(stamp.label, 18);
  const ops = [
    pushGraphicsState(),
    setStrokingRgbColor(r, g, b),
    setLineWidth(2.2),
    ...border,
    stroke(),
    setFillingRgbColor(r, g, b),
    beginText(),
    setFontAndSize("F1", 18),
    moveText((W - labelWidth) / 2, subtitle ? H - 24 : (H - 13) / 2),
    showText(bold.encodeText(stamp.label)),
    endText(),
  ];
  if (subtitle) {
    const subWidth = regular.widthOfTextAtSize(subtitle, 7);
    ops.push(
      beginText(),
      setFontAndSize("F2", 7),
      moveText((W - subWidth) / 2, 8),
      showText(regular.encodeText(subtitle)),
      endText(),
    );
  }
  ops.push(popGraphicsState());
  const rad = (rotation * Math.PI) / 180;
  const matrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0].map((v) => Math.round(v * 1e6) / 1e6);
  setAppearance(doc, dict, ops, {
    bbox: [0, 0, W, H],
    resources: { Font: { F1: bold.ref, F2: regular.ref } },
    matrix,
  });
  return attach(doc, pageIndex, dict);
}

function refId(ref) {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

function rectOf(dict) {
  const rect = dict.lookup(PDFName.of("Rect"));
  return rect instanceof PDFArray ? rect.asArray().map((n) => n.asNumber?.() ?? 0) : null;
}

/** Localiza uma anotação pelo id do PDF.js ("12R") ou por tipo + retângulo. */
function findAnnotation(doc, pageIndex, target) {
  const page = doc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) return null;
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    if (entry instanceof PDFRef && refId(entry) === target.id) {
      return { annots, index: i, ref: entry, dict: doc.context.lookup(entry, PDFDict) };
    }
  }
  if (!target.rect) return null;
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    const dict = doc.context.lookup(entry);
    if (!(dict instanceof PDFDict)) continue;
    const subtype = dict.lookup(PDFName.of("Subtype"))?.asString?.();
    const rect = rectOf(dict);
    if (subtype === `/${target.subtype}` && rect && rect.every((v, k) => Math.abs(v - target.rect[k]) < 1)) {
      return { annots, index: i, ref: entry instanceof PDFRef ? entry : null, dict };
    }
  }
  return null;
}

/** Exclui uma anotação (e o balão associado, se houver). */
export function deleteAnnotation(doc, pageIndex, target) {
  const found = findAnnotation(doc, pageIndex, target);
  if (!found) return false;
  const { annots, index, ref, dict } = found;
  annots.remove(index);
  const popup = dict.get(PDFName.of("Popup"));
  if (popup instanceof PDFRef) {
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && entry === popup) annots.remove(i);
    }
    doc.context.delete(popup);
  }
  if (ref) doc.context.delete(ref);
  return true;
}

/** Altera o texto de um comentário. */
export function setAnnotationContents(doc, pageIndex, target, contents) {
  const found = findAnnotation(doc, pageIndex, target);
  if (!found) return false;
  found.dict.set(PDFName.of("Contents"), text(contents));
  found.dict.set(PDFName.of("M"), PDFString.of(pdfDate()));
  return true;
}
