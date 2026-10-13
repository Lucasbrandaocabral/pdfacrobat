// Janela "Preencher e assinar": desenhar a assinatura ou digitar o nome.
// Resolve com { png: Uint8Array, aspect } ou null se cancelada.

const FONT = "'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', 'Apple Chancery', cursive";

export function openSignatureDialog() {
  const dialog = document.getElementById("signature-dialog");
  const canvas = dialog.querySelector("canvas");
  const nameInput = dialog.querySelector("#signature-name");
  const tabs = dialog.querySelectorAll("[data-sig-tab]");
  const ctx = canvas.getContext("2d");
  let mode = "draw";
  let hasInk = false;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio || 560 * ratio;
  canvas.height = canvas.clientHeight * ratio || 200 * ratio;

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1f66";
    hasInk = false;
  }

  function drawTyped() {
    clear();
    const text = nameInput.value.trim();
    if (!text) return;
    const w = canvas.width / ratio;
    const h = canvas.height / ratio;
    let size = 72;
    ctx.font = `${size}px ${FONT}`;
    while (ctx.measureText(text).width > w - 40 && size > 16) {
      size -= 2;
      ctx.font = `${size}px ${FONT}`;
    }
    ctx.fillStyle = "#0b1f66";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2);
    hasInk = true;
  }

  function setMode(next) {
    mode = next;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.sigTab === next));
    nameInput.hidden = next !== "type";
    canvas.classList.toggle("typing", next === "type");
    if (next === "type") {
      drawTyped();
      nameInput.focus();
    } else {
      clear();
    }
  }

  let drawing = false;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onDown = (e) => {
    if (mode !== "draw") return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
    hasInk = true;
  };
  const onMove = (e) => {
    if (!drawing) return;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const onUp = () => {
    drawing = false;
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  nameInput.addEventListener("input", drawTyped);
  const tabHandlers = [...tabs].map((t) => {
    const h = () => setMode(t.dataset.sigTab);
    t.addEventListener("click", h);
    return [t, h];
  });
  const clearBtn = dialog.querySelector("#signature-clear");
  const onClear = () => (mode === "type" ? ((nameInput.value = ""), clear()) : clear());
  clearBtn.addEventListener("click", onClear);

  nameInput.value = "";
  setMode("draw");
  dialog.showModal();

  return new Promise((resolve) => {
    const onClose = async () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      nameInput.removeEventListener("input", drawTyped);
      clearBtn.removeEventListener("click", onClear);
      tabHandlers.forEach(([t, h]) => t.removeEventListener("click", h));
      dialog.removeEventListener("close", onClose);
      if (dialog.returnValue !== "ok" || !hasInk) return resolve(null);
      resolve(await cropToPng(canvas));
    };
    dialog.addEventListener("close", onClose);
  });
}

/** Recorta a área com tinta e devolve o PNG. */
async function cropToPng(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  const blob = await new Promise((r) => out.toBlob(r, "image/png"));
  const png = new Uint8Array(await blob.arrayBuffer());
  return { png, aspect: out.width / out.height, previewUrl: URL.createObjectURL(blob) };
}
