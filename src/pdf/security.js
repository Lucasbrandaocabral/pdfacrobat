// Senhas e permissões (Standard Security Handler do PDF): verifica a senha de
// permissões (proprietário), converte as permissões do documento e aplica ou
// remove a criptografia.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, PDFWriter } from "@cantoo/pdf-lib";
import { AES128Cipher, AES256Cipher, CipherTransformFactory, PDF17, PDF20, encodeRevision6Password } from "cantoo-crypto";

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
  const ids = idArray instanceof PDFArray ? idArray.asArray().map((id) => context.lookup(id)).filter(isText) : [];
  const fileId = ids[0]?.asBytes() ?? new Uint8Array();
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
    // O dicionário e o /ID como estão no arquivo, para regravar com a mesma
    // proteção, e onde estão as informações do documento (título, autor…).
    original: { encrypt: detach(context, dict), ids, info: context.trailerInfo.Info instanceof PDFRef ? context.trailerInfo.Info : null },
  };
}

const isText = (object) => object instanceof PDFString || object instanceof PDFHexString;

/** Cópia de um objeto direto que não depende do documento lido (referências resolvidas). */
function detach(context, value, depth = 0) {
  const object = value instanceof PDFRef ? context.lookup(value) : value;
  if (depth > 8) return null;
  if (object instanceof PDFDict) {
    const plain = {};
    for (const [key, item] of object.entries()) plain[key.decodeText()] = detach(context, item, depth + 1);
    return plain;
  }
  if (object instanceof PDFArray) return object.asArray().map((item) => detach(context, item, depth + 1));
  return object;
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
    // Com senha, o pdf-lib não consegue ler o índice em fluxo (XRef stream) e
    // perde a referência às informações do documento (título, autor, datas).
    const { context } = doc;
    const info = security?.original?.info;
    if (info && !context.trailerInfo.Info && context.lookup(info) instanceof PDFDict) context.trailerInfo.Info = info;
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

/**
 * Estado da proteção de um documento aberto com `password` (a senha digitada
 * para abrir, que pode ser a de permissões) e, se já confirmada antes, a senha
 * de permissões. `owner` diz se as restrições estão liberadas.
 */
export function sessionSecurity(info, password, ownerPassword) {
  let owner = false;
  let userPassword = password ?? "";
  if (ownerPassword && isOwnerPassword(info, ownerPassword)) {
    owner = true;
  } else if (password && isOwnerPassword(info, password)) {
    owner = true;
    ownerPassword = password;
    userPassword = isUserPassword(info, password) ? password : userPasswordFromOwner(info, password);
  } else {
    ownerPassword = null;
  }
  // Sem como recuperar a senha de abertura (AES-256 aberto pelo proprietário):
  // a de permissões também abre o documento.
  if (userPassword == null) userPassword = ownerPassword;
  return {
    owner,
    security: {
      keepProtection: true,
      userPassword,
      ownerPassword,
      P: info.P,
      permissions: permissionsFromFlags(info.P),
      original: info.original,
    },
  };
}

/**
 * Salva aplicando de novo a proteção, se o documento tinha uma. Vale também
 * para um documento novo feito a partir dele (páginas extraídas, por exemplo).
 */
export function saveFromEdit(doc, security, saveOptions = {}) {
  if (security?.keepProtection) keepEncryption(doc, security);
  return doc.save(saveOptions);
}

/**
 * Protege o documento com a mesma criptografia do arquivo original: o mesmo
 * dicionário /Encrypt, o mesmo /ID e a mesma chave. Assim as duas senhas e as
 * permissões continuam exatamente as mesmas, inclusive a senha que a pessoa não
 * digitou (a de permissões, quando abriu só com a de abertura, ou a de abertura
 * de um AES-256 aberto com a de permissões).
 */
function keepEncryption(doc, security) {
  const { context } = doc;
  const { encrypt, ids } = security.original;
  const dict = context.obj(encrypt);
  const fileId = ids[0]?.asBytes() ?? new Uint8Array();
  const factory = new CipherTransformFactory(dict, fileId, security.ownerPassword || security.userPassword || "");
  if (ids.length) context.trailerInfo.ID = context.obj(ids);
  else delete context.trailerInfo.ID;
  context.trailerInfo.Encrypt = context.register(dict);
  context.security = {
    getEncryptFn: (num, gen) => encryptWith(factory.createCipherTransform(num, gen).StreamCipherConstructor),
    getStringEncryptFn: (num, gen) => encryptWith(factory.createCipherTransform(num, gen).StringCipherConstructor),
  };
}

/** Função que cifra bytes com um novo cifrador do tipo dado (RC4, AES ou nenhum). */
function encryptWith(makeCipher) {
  return (bytes) => {
    const cipher = makeCipher();
    if (!(cipher instanceof AES128Cipher || cipher instanceof AES256Cipher)) return cipher.encrypt(bytes);
    // AES: preenchimento até múltiplo de 16 e vetor inicial aleatório na frente (ISO 32000-1, 7.6.2).
    const pad = 16 - (bytes.length % 16);
    const padded = new Uint8Array(bytes.length + pad).fill(pad);
    padded.set(bytes);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = cipher.encrypt(padded, iv);
    const out = new Uint8Array(16 + encrypted.length);
    out.set(iv);
    out.set(encrypted, 16);
    return out;
  };
}

// O pdf-lib, ao gravar um documento protegido, cifra só os fluxos (streams):
// os textos fora deles (título, comentários, valores de campos, idioma) iam
// em claro, e quem decifra o arquivo lia lixo no lugar. Aqui eles também são
// cifrados, com a chave do objeto em que estão. Objetos dentro de pacotes
// (ObjStm) não passam por aqui: o pacote inteiro é cifrado.
const encryptStreams = PDFWriter.prototype.encrypt;
PDFWriter.prototype.encrypt = function encrypt(ref, object, security) {
  if (ref === this.context.trailerInfo.Encrypt) return;
  let encryptString = null;
  const get = () =>
    (encryptString ||= (security.getStringEncryptFn ?? security.getEncryptFn).call(security, ref.objectNumber, ref.generationNumber));
  encryptStrings(object instanceof PDFStream ? object.dict : object, get);
  encryptStreams.call(this, ref, object, security);
};

const CONTENTS = PDFName.of("Contents");
const SIGNATURE_TYPES = new Set([PDFName.of("Sig"), PDFName.of("DocTimeStamp")]);

/** Troca, no lugar, cada texto de um dicionário ou lista (e dos que estão dentro) pelo texto cifrado. */
function encryptStrings(root, getEncryptFn) {
  const encrypted = (text) => PDFHexString.fromBytes(getEncryptFn()(text.asBytes()));
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node instanceof PDFDict) {
      // O valor de uma assinatura digital nunca é cifrado.
      const signature =
        SIGNATURE_TYPES.has(node.get(PDFName.of("Type"))) || (isText(node.get(CONTENTS)) && node.get(PDFName.of("ByteRange")) instanceof PDFArray);
      for (const [key, value] of node.entries()) {
        if (isText(value)) {
          if (!(signature && key === CONTENTS)) node.set(key, encrypted(value));
        } else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
      }
    } else if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i++) {
        const value = node.get(i);
        if (isText(value)) node.set(i, encrypted(value));
        else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
      }
    }
  }
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
