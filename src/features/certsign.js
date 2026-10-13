// Fluxo da assinatura digital com certificado A1.
import { $, UserError, baseName, formValues, openDialog, setBusy, toast } from "../ui.js";
import { drawSignatureBlock, readCertificate, signPdf } from "../pdf/certsign.js";
import { Perm } from "../pdf/security.js";
import * as platform from "../platform.js";

export async function certSign(app) {
  const tab = app.manager.active;
  if (!tab?.doc) throw new UserError("Abra um documento primeiro.");
  if (!(await app.guard(tab, Perm.MODIFY, "assinar"))) return;
  if (tab.encrypted) {
    toast("Remova a senha do documento antes de assinar (Proteger → Remover senha). Depois de assinado, ele não pode mais ser alterado.", { duration: 8000 });
    return;
  }
  const dialog = $("#cert-sign-dialog");
  const form = $("form", dialog);
  let certificate = null;
  $("#cert-file-name").textContent = "Nenhum arquivo (.pfx ou .p12)";
  $("#cert-file-button").onclick = async () => {
    const [file] = await platform.pickFiles({ kind: "certificate" });
    if (!file) return;
    certificate = file;
    $("#cert-file-name").textContent = file.name;
  };
  form.elements.password.value = "";

  let info;
  let values;
  for (;;) {
    if (!(await openDialog(dialog))) return;
    values = formValues(form);
    if (!certificate) {
      toast("Escolha o arquivo do certificado (.pfx ou .p12).");
      continue;
    }
    try {
      info = await readCertificate(certificate.data, values.password);
      break;
    } catch (err) {
      toast(err.userMessage || err.message, { duration: 6000 });
    }
  }

  let placement = null;
  if (values.visible) {
    placement = await app.tools.pickPoint({ label: "Assinado digitalmente", size: [190, 52] });
    if (!placement) return;
  }

  const signed = await app.run("Assinando…", async () => {
    const doc = await tab.loadEditable();
    let widgetRect = [0, 0, 0, 0];
    const pageIndex = placement ? placement.pageIndex : 0;
    if (placement) {
      widgetRect = await drawSignatureBlock(doc, pageIndex, { center: placement.pdf, info, reason: values.reason.trim() });
    }
    const prepared = await doc.save();
    setBusy("Assinando com o certificado…");
    return signPdf(prepared, {
      p12: certificate.data,
      password: values.password,
      info,
      reason: values.reason.trim(),
      location: values.location.trim(),
      pageIndex,
      widgetRect,
    });
  });
  if (!signed) return;

  // O arquivo assinado precisa ser salvo exatamente como está.
  const saved = await platform.saveFile(signed, { suggestedName: `${baseName(tab.name)} (assinado).pdf`, saveAs: true });
  if (saved) {
    await app.openDocument(signed, { name: saved.name, path: saved.path });
    toast(`Documento assinado por ${info.name} e salvo.`, { duration: 6000 });
  } else {
    await app.openDocument(signed, { name: `${baseName(tab.name)} (assinado).pdf`, dirty: true });
    toast("Documento assinado. Salve-o sem fazer alterações para manter a assinatura válida.", { duration: 7000 });
  }
}
