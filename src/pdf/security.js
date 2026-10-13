// Senhas e permissões (Standard Security Handler do PDF): verifica a senha de
// permissões (proprietário), converte as permissões do documento e aplica ou
// remove a criptografia.
import { PDFArray, PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { CipherTransformFactory, PDF17, PDF20, encodeRevision6Password } from "cantoo-crypto";

// Preenchimento padrão de senhas (ISO 32000-1, Algoritmo 2).
const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// Bits de permissão do campo /P.
export const Perm = {
  PRINT: 0x04,
  MODIFY: 0x08,
  COPY: 0x10,
  ANNOTATE: 0x20,
  FILL_FORMS: 0x100,
  ACCESSIBILITY: 0x200,
  ASSEMBLE: 0x400,
  PRINT_HIGH: 0x800,
};

const latin1 = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);

function passwordBytes(info, password) {
  return info.R === 6 ? encodeRevision6Password(password) : latin1(password).subarray(0, 127);
}

/** Lê o dicionário /Encrypt. Retorna null se o PDF não for criptografado. */
export async function readEncryption(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const { context } = doc;
  const dict = context.lookup(context.trailerInfo.Encrypt);
  if (!(dict instanceof PDFDict)) return null;
  const num = (key) => dict.lookup(context.obj(key))?.asNumber?.();
  const str = (key) => dict.lookup(context.obj(key))?.asBytes?.();
  const V = num("V");
  let keyLength = num("Length");
  if (!keyLength) {
    if (V <= 3) keyLength = 40;
    else {
      const cf = dict.lookup(context.obj("CF"));
      const stmf = dict.lookup(context.obj("StmF"));
      let len = cf instanceof PDFDict && stmf ? cf.lookup(stmf)?.lookup?.(context.obj("Length"))?.asNumber?.() : null;
      if (len && len < 40) len <<= 3;
      keyLength = len || 128;
    }
  }
  const idArray = context.lookup(context.trailerInfo.ID);
  const fileId = idArray instanceof PDFArray ? idArray.lookup(0)?.asBytes?.() ?? new Uint8Array() : new Uint8Array();
  const encryptMetadata = V >= 4 ? dict.lookup(context.obj("EncryptMetadata"))?.asBoolean?.() !== false : true;
  return {
    V,
    R: num("R"),
    P: num("P"),
    O: str("O"),
    U: str("U"),
    keyLength,
    fileId,
    encryptMetadata,
  };
}

function legacyHelper() {
  const helper = Object.create(CipherTransformFactory.prototype);
  helper.defaultPasswordBytes = PASSWORD_PADDING;
  return helper;
}

/** A senha é a senha de abertura (usuário)? */
export function isUserPassword(info, password) {
  const pw = passwordBytes(info, password);
  if (info.V === 5) {
    const alg = info.R === 6 ? new PDF20() : new PDF17();
    return alg.checkUserPassword(pw, info.U.subarray(32, 40), info.U.subarray(0, 32));
  }
  const key = legacyHelper().prepareKeyData(
    info.fileId, pw, info.O.subarray(0, 32), info.U.subarray(0, 32), info.P, info.R, info.keyLength, info.encryptMetadata,
  );
  return Boolean(key);
}

/** A senha é a senha de permissões (proprietário)? */
export function isOwnerPassword(info, password) {
  if (!password) return false;
  const pw = passwordBytes(info, password);
  if (info.V === 5) {
    const alg = info.R === 6 ? new PDF20() : new PDF17();
    return alg.checkOwnerPassword(pw, info.O.subarray(32, 40), info.U.subarray(0, 48), info.O.subarray(0, 32));
  }
  const helper = legacyHelper();
  const decoded = helper.decodeUserPassword(pw, info.O.subarray(0, 32), info.R, info.keyLength);
  const key = helper.prepareKeyData(
    info.fileId, decoded, info.O.subarray(0, 32), info.U.subarray(0, 32), info.P, info.R, info.keyLength, info.encryptMetadata,
  );
  return Boolean(key);
}

/** Recupera a senha de abertura a partir da senha de permissões (só R2–R4). */
export function userPasswordFromOwner(info, ownerPassword) {
  if (info.V === 5) return null;
  const padded = legacyHelper().decodeUserPassword(latin1(ownerPassword), info.O.subarray(0, 32), info.R, info.keyLength);
  for (let len = 0; len <= 32; len++) {
    let matches = true;
    for (let i = len; i < 32; i++) {
      if (padded[i] !== PASSWORD_PADDING[i - len]) {
        matches = false;
        break;
      }
    }
    if (matches) return String.fromCharCode(...padded.subarray(0, len));
  }
  return null;
}

/** Converte o campo /P no formato de permissões do pdf-lib. */
export function permissionsFromFlags(P) {
  const has = (bit) => (P & bit) !== 0;
  return {
    printing: has(Perm.PRINT) ? (has(Perm.PRINT_HIGH) ? "highResolution" : "lowResolution") : false,
    modifying: has(Perm.MODIFY),
    copying: has(Perm.COPY),
    annotating: has(Perm.ANNOTATE),
    fillingForms: has(Perm.FILL_FORMS),
    contentAccessibility: has(Perm.ACCESSIBILITY),
    documentAssembly: has(Perm.ASSEMBLE),
  };
}

/**
 * O pdf-lib mantém como objetos comuns os índices (XRef) e pacotes de objetos
 * (ObjStm) do arquivo original e os regrava ao salvar. Um índice antigo ainda
 * aponta para a criptografia e faz o arquivo parecer protegido depois de a
 * senha ser removida; por isso eles são descartados (o índice é sempre refeito).
 */
function dropStaleObjects(doc) {
  const { context } = doc;
  const XREF = PDFName.of("XRef");
  const OBJSTM = PDFName.of("ObjStm");
  const STANDARD = PDFName.of("Standard");
  for (const [ref, object] of [...context.enumerateIndirectObjects()]) {
    const dict = object instanceof PDFDict ? object : object?.dict;
    if (!(dict instanceof PDFDict)) continue;
    const type = dict.get(PDFName.of("Type"));
    if (type === XREF || type === OBJSTM) context.delete(ref);
    else if (
      object instanceof PDFDict &&
      dict.get(PDFName.of("Filter")) === STANDARD &&
      dict.has(PDFName.of("O")) &&
      dict.has(PDFName.of("U")) &&
      ref !== context.trailerInfo.Encrypt
    ) {
      context.delete(ref);
    }
  }
}

/** Carrega para edição, decifrando quando necessário. */
export async function loadForEdit(bytes, security) {
  const options = { updateMetadata: false };
  if (security) options.password = security.ownerPassword ?? security.userPassword ?? "";
  try {
    const doc = await PDFDocument.load(bytes, options);
    dropStaleObjects(doc);
    return doc;
  } catch (err) {
    if (/password|encrypt/i.test(err.message)) {
      const error = new Error("Não foi possível abrir este documento protegido para edição.");
      error.userMessage = error.message;
      throw error;
    }
    throw err;
  }
}

/** Salva aplicando de novo a proteção, se o documento tinha uma. */
export function saveFromEdit(doc, security, saveOptions = {}) {
  if (security?.keepProtection) {
    doc.encrypt({
      userPassword: security.userPassword ?? "",
      ownerPassword: security.ownerPassword || security.userPassword || randomPassword(),
      permissions: security.permissions,
    });
  }
  return doc.save(saveOptions);
}

export function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

/** Protege o documento com senha de abertura e/ou restrições. */
export async function protect(bytes, current, { userPassword, ownerPassword, permissions }) {
  const doc = await loadForEdit(bytes, current);
  doc.encrypt({
    userPassword: userPassword || "",
    ownerPassword: ownerPassword || userPassword || randomPassword(),
    permissions,
  });
  return doc.save();
}

/** Remove toda a proteção. */
export async function unprotect(bytes, current) {
  const doc = await loadForEdit(bytes, current);
  return doc.save();
}
