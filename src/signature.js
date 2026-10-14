// Janela que cria a assinatura (ou as iniciais), como no "Preencher e assinar"
// do Acrobat: digitar o nome num estilo manuscrito, desenhar com o mouse, a
// caneta ou o dedo, ou usar a imagem de uma assinatura feita no papel. A
// assinatura pode ficar salva neste aparelho para ser usada de novo.
import "@fontsource/dancing-script/latin-400.css";
import "@fontsource/dancing-script/latin-ext-400.css";
import "@fontsource/great-vibes/latin-400.css";
import "@fontsource/great-vibes/latin-ext-400.css";
import "@fontsource/homemade-apple/latin-400.css";
import "@fontsource/caveat/latin-400.css";
import "@fontsource/caveat/latin-ext-400.css";
import { $, $$, el, toast } from "./ui.js";
import * as platform from "./platform.js";

const STYLES = [
  { id: "dancing", family: "'Dancing Script', cursive" },
  { id: "vibes", family: "'Great Vibes', cursive" },
  { id: "apple", family: "'Homemade Apple', cursive" },
  { id: "caveat", family: "'Caveat', cursive" },
];
const INKS = { blue: "#0b1f66", black: "#111111" };

const KINDS = {
  signature: {
    title: "Criar assinatura",
    ok: "Usar assinatura",
    storage: "savedSignature",
    placeholder: "Digite seu nome",
    sample: "Assinatura",
  },
  initials: {
    title: "Criar iniciais",
    ok: "Usar iniciais",
    storage: "savedInitials",
    placeholder: "Digite suas iniciais",
    sample: "AB",
  },
};

const HELP = {
  type: "Digite e escolha o estilo da letra.",
  draw: "Use o mouse, a caneta ou o dedo para assinar dentro do quadro.",
  image: "Use uma foto ou o escaneamento da assinatura feita no papel (PNG ou JPG).",
};

// ---- Assinatura e iniciais salvas ----

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Assinatura ou iniciais salvas neste aparelho ({ dataUrl, aspect }) ou null. */
export function getSaved(kind) {
  const saved = readJson(KINDS[kind].storage);
  return saved?.dataUrl && saved.aspect ? saved : null;
}

export function forgetSaved(kind) {
  try {
    localStorage.removeItem(KINDS[kind].storage);
  } catch {
    // Armazenamento indisponível: nada guardado.
  }
}

/** Formato usado para aplicar na página: { png, aspect, previewUrl, kind }. */
export function fromSaved(kind, saved) {
  return { png: dataUrlToBytes(saved.dataUrl), aspect: saved.aspect, previewUrl: saved.dataUrl, kind };
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** "Maria da Silva Souza" -> "MSS" (sem "da", "de", "do", "e"…). */
export function initialsOf(name) {
  return name
    .trim()
    .split(/\s+/)
    .filter((word) => word && !/^(d[aeo]s?|e)$/i.test(word))
    .map((word) => word[0].toUpperCase())
    .join("")
    .slice(0, 4);
}

/** Carrega as fontes manuscritas antes de desenhar com elas no canvas. */
function loadFonts(text) {
  return Promise.all(STYLES.map((s) => document.fonts.load(`48px ${s.family}`, text || "Assinatura").catch(() => {})));
}

// ---- Imagem, recorte e exportação ----

/** Recorta a área com tinta (pixels não transparentes). Retorna um canvas ou null. */
function cropToInk(source) {
  const { width, height } = source;
  const data = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(width, height) * 0.01) + 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Deixa transparente o papel de uma assinatura fotografada ou escaneada: o
 * brilho do papel é a mediana da imagem e o que for bem mais escuro é tinta.
 */
function removePaper(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  const total = d.length / 4;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
  if (transparent > total / 10) return; // Já vem sem fundo (ex.: PNG recortado).
  const luminance = (i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) histogram[Math.min(255, Math.round(luminance(i)))]++;
  let paper = 255;
  for (let v = 0, count = 0; v < 256; v++) {
    count += histogram[v];
    if (count >= total / 2) {
      paper = v;
      break;
    }
  }
  const start = paper - 25; // Até aqui ainda é papel (sombra, textura).
  const solid = paper - 90; // Daqui para baixo é tinta.
  for (let i = 0; i < d.length; i += 4) {
    const lum = luminance(i);
    const alpha = lum >= start ? 0 : lum <= solid ? 1 : (start - lum) / (start - solid);
    d[i + 3] = Math.round(alpha * d[i + 3]);
  }
  ctx.putImageData(image, 0, 0);
}

async function loadImage(bytes, clearBackground) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  if (clearBackground) removePaper(canvas);
  return cropToInk(canvas);
}

/** Traço com curvas suaves; a espessura acompanha a pressão da caneta. */
function drawStroke(ctx, points, scale) {
  const width = (p) => (1.2 + p * 2.8) * scale;
  const [first] = points;
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x * scale, first.y * scale, width(first.p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let from = first;
  for (let i = 1; i < points.length; i++) {
    const control = points[i - 1];
    const next = points[i];
    const to = i === points.length - 1 ? next : { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
    ctx.lineWidth = width(next.p);
    ctx.beginPath();
    ctx.moveTo(from.x * scale, from.y * scale);
    ctx.quadraticCurveTo(control.x * scale, control.y * scale, to.x * scale, to.y * scale);
    ctx.stroke();
    from = to;
  }
}

// ---- Janela ----

/**
 * Abre a janela. `kind`: "signature" ou "initials"; `text`: nome (ou
 * iniciais) já digitado. Resolve com { png, aspect, previewUrl, kind } ou
 * null se cancelada; se o usuário pedir, a assinatura fica salva.
 */
export async function openSignatureDialog({ kind = "signature", text = "" } = {}) {
  const config = KINDS[kind];
  const dialog = $("#signature-dialog");
  const form = $("form", dialog);
  const canvas = $(".signature-pad", dialog);
  const nameInput = $("#signature-name", dialog);
  const styleList = $(".sig-styles", dialog);
  const removeBg = $("#signature-remove-bg", dialog);
  const saveBox = $("#signature-save", dialog);
  const ctx = canvas.getContext("2d");
  const prefs = readJson("signaturePrefs") || {};
  const state = {
    // A imagem é escolhida a cada vez; volta para digitar ou desenhar.
    mode: prefs.mode === "draw" ? "draw" : "type",
    style: STYLES.some((s) => s.id === prefs.style) ? prefs.style : STYLES[0].id,
    ink: INKS[prefs.ink] ? prefs.ink : "blue",
    strokes: [],
    current: null,
    imageBytes: null,
    image: null,
  };
  let frame = 0;

  $("h2", dialog).textContent = config.title;
  $('button[value="ok"]', dialog).textContent = config.ok;
  nameInput.placeholder = config.placeholder;
  nameInput.value = text;
  saveBox.checked = true;
  removeBg.checked = true;
  await loadFonts(text);

  const family = () => STYLES.find((s) => s.id === state.style).family;
  const ink = () => INKS[state.ink];
  const hasContent = () =>
    state.mode === "type" ? Boolean(nameInput.value.trim()) : state.mode === "draw" ? state.strokes.length > 0 : Boolean(state.image);

  /** Desenha o modo atual em `target`, na escala `scale` (1 = tamanho na tela). */
  function paint(target, scale, cssWidth, cssHeight) {
    const g = target.getContext("2d");
    g.fillStyle = g.strokeStyle = ink();
    g.lineCap = g.lineJoin = "round";
    if (state.mode === "type") {
      const value = nameInput.value.trim();
      if (!value) return;
      let size = (kind === "initials" ? 96 : 72) * scale;
      g.font = `${size}px ${family()}`;
      while (g.measureText(value).width > (cssWidth - 48) * scale && size > 14 * scale) {
        size -= 2 * scale;
        g.font = `${size}px ${family()}`;
      }
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(value, (cssWidth / 2) * scale, (cssHeight / 2) * scale);
    } else if (state.mode === "draw") {
      for (const stroke of state.strokes) drawStroke(g, stroke, scale);
    } else if (state.image) {
      const { width, height } = state.image;
      const fit = Math.min(((cssWidth - 32) * scale) / width, ((cssHeight - 24) * scale) / height, 4 * scale);
      const w = width * fit;
      const h = height * fit;
      g.drawImage(state.image, (cssWidth * scale - w) / 2, (cssHeight * scale - h) / 2, w, h);
    }
  }

  function render() {
    cancelAnimationFrame(frame);
    frame = 0;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 560;
    const cssHeight = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paint(canvas, ratio, cssWidth, cssHeight);
  }

  const scheduleRender = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  function renderStyles() {
    const sample = nameInput.value.trim() || config.sample;
    styleList.replaceChildren(
      ...STYLES.map((s) =>
        el("button", {
          type: "button",
          class: `sig-style${s.id === state.style ? " active" : ""}`,
          role: "radio",
          "aria-checked": String(s.id === state.style),
          style: `font-family: ${s.family}`,
          dataset: { style: s.id },
          text: sample,
        }),
      ),
    );
  }

  function setMode(mode) {
    state.mode = mode;
    $$("[data-sig-tab]", dialog).forEach((t) => {
      t.classList.toggle("active", t.dataset.sigTab === mode);
      t.setAttribute("aria-selected", String(t.dataset.sigTab === mode));
    });
    $$("[data-sig-pane]", dialog).forEach((p) => (p.hidden = p.dataset.sigPane !== mode));
    canvas.classList.toggle("drawing", mode === "draw");
    // A imagem fica com as cores originais.
    $(".sig-inks", dialog).hidden = mode === "image";
    $(".sig-help", dialog).textContent = HELP[mode];
    render();
    // No celular o teclado cobriria os estilos: com o nome já preenchido, só
    // aparece quando a pessoa toca no campo.
    const touch = window.matchMedia?.("(pointer: coarse)").matches;
    if (mode === "type" && !(touch && nameInput.value.trim())) nameInput.focus();
  }

  async function chooseImage() {
    const [file] = await platform.pickFiles({ kind: "images" });
    if (!file) return;
    state.imageBytes = file.data;
    await updateImage();
  }

  async function updateImage() {
    if (!state.imageBytes) return;
    try {
      state.image = await loadImage(state.imageBytes, removeBg.checked);
      if (!state.image) toast("Não foi encontrada uma assinatura nessa imagem.");
    } catch {
      state.image = null;
      toast("Não foi possível abrir essa imagem.");
    }
    render();
  }

  // Desenho com mouse, caneta ou dedo.
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === "pen" ? e.pressure || 0.5 : 0.5 };
  };
  const onDown = (e) => {
    if (state.mode !== "draw" || e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    state.current = [point(e)];
    state.strokes.push(state.current);
    scheduleRender();
  };
  const onMove = (e) => {
    if (!state.current) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) state.current.push(point(ev));
    scheduleRender();
  };
  const onUp = () => {
    state.current = null;
  };

  const onClick = (e) => {
    const tab = e.target.closest("[data-sig-tab]");
    if (tab) return setMode(tab.dataset.sigTab);
    const style = e.target.closest("[data-style]");
    if (style) {
      state.style = style.dataset.style;
      renderStyles();
      return render();
    }
    const swatch = e.target.closest("[data-ink]");
    if (swatch) {
      state.ink = swatch.dataset.ink;
      $$("[data-ink]", dialog).forEach((b) => b.setAttribute("aria-checked", String(b === swatch)));
      return render();
    }
    if (e.target.closest("#signature-image-button")) return chooseImage();
    if (e.target.closest("#signature-clear")) {
      if (state.mode === "type") nameInput.value = "";
      else if (state.mode === "draw") state.strokes = [];
      else {
        state.image = null;
        state.imageBytes = null;
      }
      renderStyles();
      render();
    }
  };
  const onInput = (e) => {
    if (e.target === nameInput) {
      renderStyles();
      loadFonts(nameInput.value).then(render);
      render();
    } else if (e.target === removeBg) {
      updateImage();
    }
  };
  const onSubmit = (e) => {
    if (e.submitter?.value !== "ok" || hasContent()) return;
    e.preventDefault();
    toast(
      { type: "Digite o nome.", draw: "Desenhe a assinatura no quadro.", image: "Escolha a imagem da assinatura." }[state.mode],
    );
  };
  const onResize = () => scheduleRender();
  // Enter no nome confirma (o primeiro botão do formulário é o "Cancelar").
  const onKeyDown = (e) => {
    if (e.key === "Enter" && e.target === nameInput) {
      e.preventDefault();
      $('button[value="ok"]', dialog).click();
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("input", onInput);
  dialog.addEventListener("keydown", onKeyDown);
  form.addEventListener("submit", onSubmit);
  window.addEventListener("resize", onResize);

  $$("[data-ink]", dialog).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.ink === state.ink)));
  renderStyles();
  dialog.returnValue = "";
  dialog.showModal();
  setMode(state.mode);

  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  canvas.removeEventListener("pointerdown", onDown);
  canvas.removeEventListener("pointermove", onMove);
  canvas.removeEventListener("pointerup", onUp);
  canvas.removeEventListener("pointercancel", onUp);
  dialog.removeEventListener("click", onClick);
  dialog.removeEventListener("input", onInput);
  dialog.removeEventListener("keydown", onKeyDown);
  form.removeEventListener("submit", onSubmit);
  window.removeEventListener("resize", onResize);
  cancelAnimationFrame(frame);
  if (dialog.returnValue !== "ok" || !hasContent()) return null;

  writeJson("signaturePrefs", { mode: state.mode, style: state.style, ink: state.ink });
  // Exporta em alta resolução: o dobro do quadro (ou a imagem original).
  let source;
  if (state.mode === "image") {
    source = state.image;
  } else {
    const scale = 3;
    const cssWidth = canvas.clientWidth || 560;
    const cssHeight = canvas.clientHeight || 200;
    const big = document.createElement("canvas");
    big.width = cssWidth * scale;
    big.height = cssHeight * scale;
    paint(big, scale, cssWidth, cssHeight);
    source = cropToInk(big);
  }
  if (!source) return null;
  const dataUrl = source.toDataURL("image/png");
  const aspect = source.width / source.height;
  if (saveBox.checked && !writeJson(config.storage, { dataUrl, aspect })) {
    toast("Não foi possível salvar a assinatura neste aparelho; ela será usada só agora.");
  }
  if (state.mode === "type" && kind === "signature" && !platform.savedUserName()) {
    platform.setUserName(nameInput.value.trim());
  }
  return { png: dataUrlToBytes(dataUrl), aspect, previewUrl: dataUrl, kind };
}
