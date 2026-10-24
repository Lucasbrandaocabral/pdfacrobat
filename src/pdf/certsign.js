// Assinatura digital com certificado A1 (.pfx/.p12): PKCS#7 destacado
// (adbe.pkcs7.detached), SHA-256, com bloco visível opcional na página.
import { Buffer } from "buffer";
import { PDFArray, PDFDict, PDFName, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { UserError } from "../ui.js";
import { isolatePage } from "./content.js";
import { fromUser, visualFrame } from "./marks.js";
import { encodable } from "./textedit.js";

globalThis.Buffer ||= Buffer;

const toBinaryString = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

/** Lê o certificado do arquivo .pfx (valida a senha e a validade). */
export async function readCertificate(p12Bytes, password) {
  const { default: forge } = await import("node-forge");
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinaryString(p12Bytes)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err) {
    if (/mac|password|decrypt|invalid/i.test(err.message)) throw new UserError("Senha do certificado incorreta.");
    throw new UserError("Este arquivo não parece ser um certificado .pfx/.p12 válido.");
  }
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags.length) throw new UserError("O certificado não contém a chave privada necessária para assinar.");
  const keyId = keyBags[0].attributes?.localKeyId?.[0];
  const bag =
    certBags.find((b) => keyId && b.attributes?.localKeyId?.[0] === keyId) ||
    certBags.find((b) => !b.cert.getExtension("basicConstraints")?.cA) ||
    certBags[0];
  if (!bag) throw new UserError("Nenhum certificado encontrado no arquivo.");
  const { cert } = bag;
  const cn = cert.subject.getField("CN")?.value || "Assinante";
  const now = new Date();
  if (now > cert.validity.notAfter) {
    throw new UserError(`Este certificado venceu em ${cert.validity.notAfter.toLocaleDateString("pt-BR")}.`);
  }
  if (now < cert.validity.notBefore) throw new UserError("Este certificado ainda não é válido.");
  return {
    // Certificados ICP-Brasil usam "NOME:CPF" no CN.
    name: cn.split(":")[0].trim(),
    commonName: cn,
    issuer: cert.issuer.getField("CN")?.value || "",
    validTo: cert.validity.notAfter,
  };
}

/** Desenha o bloco "Assinado digitalmente por…" e devolve o retângulo [x0, y0, x1, y1]. */
export async function drawSignatureBlock(doc, pageIndex, { center, info, reason, date = new Date() }) {
  const page = doc.getPage(pageIndex);
  isolatePage(doc, page);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const frame = visualFrame(page);
  const lines = [
    { text: "Assinado digitalmente por", font: regular, size: 7 },
    { text: encodable(info.name, bold), font: bold, size: 10 },
    { text: `Data: ${date.toLocaleString("pt-BR")}`, font: regular, size: 7 },
  ];
  if (reason) lines.push({ text: encodable(`Motivo: ${reason}`, regular), font: regular, size: 7 });
  const width = Math.max(150, ...lines.map((l) => l.font.widthOfTextAtSize(l.text, l.size))) + 16;
  const height = lines.reduce((sum, l) => sum + l.size * 1.35, 0) + 12;
  // Centro em coordenadas visuais (página como aparece na tela).
  const [cvx, cvy] = fromUser(frame, center[0], center[1]);
  const left = Math.min(Math.max(cvx - width / 2, 4), frame.W - width - 4);
  const bottom = Math.min(Math.max(cvy - height / 2, 4), frame.H - height - 4);
  const corners = [frame.toUser(left, bottom), frame.toUser(left + width, bottom + height)];
  const rect = [
    Math.min(corners[0][0], corners[1][0]),
    Math.min(corners[0][1], corners[1][1]),
    Math.max(corners[0][0], corners[1][0]),
    Math.max(corners[0][1], corners[1][1]),
  ];
  const [x, y] = frame.toUser(left, bottom);
  page.drawRectangle({
    x,
    y,
    width,
    height,
    rotate: degrees(frame.r),
    color: rgb(0.95, 0.97, 1),
    borderColor: rgb(0.1, 0.32, 0.6),
    borderWidth: 1,
  });
  let cursor = bottom + height - 8;
  for (const line of lines) {
    cursor -= line.size;
    const [tx, ty] = frame.toUser(left + 8, cursor);
    page.drawText(line.text, { x: tx, y: ty, size: line.size, font: line.font, color: rgb(0.1, 0.2, 0.4), rotate: degrees(frame.r) });
    cursor -= line.size * 0.35;
  }
  return rect;
}

/** Quantas assinaturas digitais o documento já tem (campos de assinatura preenchidos). */
export function signatureCount(doc) {
  const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"));
  const seen = new Set();
  let count = 0;
  const visit = (fields, depth) => {
    if (!(fields instanceof PDFArray) || depth > 20) return;
    for (let i = 0; i < fields.size(); i++) {
      const field = fields.lookup(i);
      if (!(field instanceof PDFDict) || seen.has(field)) continue;
      seen.add(field);
      if (field.lookup(PDFName.of("FT")) === PDFName.of("Sig") && field.lookup(PDFName.of("V")) instanceof PDFDict) count++;
      visit(field.lookup(PDFName.of("Kids")), depth + 1);
    }
  };
  if (acroForm instanceof PDFDict) visit(acroForm.lookup(PDFName.of("Fields")), 0);
  return count;
}

/**
 * Assina os bytes (que já devem conter o bloco visível, se houver). Usa o
 * pdf-lib original exigido pelo @signpdf para criar o campo de assinatura.
 */
export async function signPdf(bytes, { p12, password, info, reason, location, pageIndex = 0, widgetRect = [0, 0, 0, 0] }) {
  const [{ PDFDocument }, { pdflibAddPlaceholder }, { P12Signer }, signpdfModule] = await Promise.all([
    import("pdf-lib"),
    import("@signpdf/placeholder-pdf-lib"),
    import("@signpdf/signer-p12"),
    import("@signpdf/signpdf"),
  ]);
  const signpdf = signpdfModule.default?.sign ? signpdfModule.default : signpdfModule.default?.default ?? signpdfModule;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfPage: doc.getPage(pageIndex),
    reason: reason || "Assinatura digital",
    contactInfo: "",
    name: info.name,
    location: location || "",
    signingTime: new Date(),
    widgetRect,
    appName: "PDF Acrobat",
    signatureLength: 16384,
  });
  const prepared = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(Buffer.from(p12), { passphrase: password });
  const signed = await signpdf.sign(Buffer.from(prepared), signer);
  return new Uint8Array(signed);
}
