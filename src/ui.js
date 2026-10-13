// Utilidades de interface: seletores, avisos, indicador de progresso e
// diálogos genéricos (confirmação, texto, escolha) baseados em <dialog>.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...[].concat(children).filter((c) => c !== null && c !== undefined));
  return node;
}

let toastTimer = null;
export function toast(message, { duration = 3500 } = {}) {
  const box = $("#toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), duration);
}

/** Mostra (texto) ou esconde (false) o indicador de processamento. */
export function setBusy(message) {
  $("#busy").hidden = !message;
  if (message) $("#busy-text").textContent = message;
}

/** Executa uma tarefa longa com indicador de progresso e mensagem de erro amigável. */
export async function runBusy(message, task) {
  setBusy(message);
  try {
    return await task();
  } catch (err) {
    console.error(err);
    toast(err?.userMessage || err?.message || String(err), { duration: 6000 });
    return undefined;
  } finally {
    setBusy(false);
  }
}

/** Erro com mensagem já pronta para o usuário. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

/** Abre um <dialog> modal e resolve com true se fechado com value="ok". */
export function openDialog(dialog, { focus } = {}) {
  if (typeof dialog === "string") dialog = $(dialog);
  dialog.returnValue = "";
  dialog.showModal();
  (focus ? $(focus, dialog) : dialog.querySelector("[autofocus], input, textarea, select"))?.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

export async function confirmAction({ title, message, ok = "OK", danger = false }) {
  const dialog = $("#confirm-dialog");
  $("h2", dialog).textContent = title;
  $(".message", dialog).textContent = message || "";
  const okButton = $('button[value="ok"]', dialog);
  okButton.textContent = ok;
  okButton.classList.toggle("danger", danger);
  return openDialog(dialog, { focus: 'button[value="ok"]' });
}

/** Pede um texto. Retorna a string digitada ou null se cancelado. */
export async function askText({ title, label, value = "", multiline = false, ok = "OK", password = false, placeholder = "" }) {
  const dialog = $("#prompt-dialog");
  $("h2", dialog).textContent = title;
  $(".prompt-label", dialog).textContent = label || "";
  const input = $("#prompt-input", dialog);
  const area = $("#prompt-textarea", dialog);
  input.hidden = multiline;
  area.hidden = !multiline;
  input.type = password ? "password" : "text";
  const field = multiline ? area : input;
  field.value = value;
  field.placeholder = placeholder;
  $('button[value="ok"]', dialog).textContent = ok;
  const confirmed = await openDialog(dialog, { focus: multiline ? "#prompt-textarea" : "#prompt-input" });
  return confirmed ? field.value : null;
}

/** Lê os campos nomeados de um formulário como objeto. */
export function formValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === "checkbox") values[element.name] = element.checked;
    else if (element.type === "radio") {
      if (element.checked) values[element.name] = element.value;
    } else values[element.name] = element.value;
  }
  return values;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2).replace(".", ",")} MB`;
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

/** "1-3, 5" -> [0, 1, 2, 4] */
export function parsePageRange(text, total) {
  const out = new Set();
  const trimmed = String(text).trim();
  if (!trimmed || /^(todas?|tudo|all)$/i.test(trimmed)) {
    return Array.from({ length: total }, (_, i) => i);
  }
  for (const part of trimmed.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new UserError(`Intervalo inválido: "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > total || a > b) throw new UserError(`Intervalo fora do documento: "${part}" (o documento tem ${total} página(s)).`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (!out.size) throw new UserError("Informe ao menos uma página.");
  return [...out].sort((x, y) => x - y);
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
