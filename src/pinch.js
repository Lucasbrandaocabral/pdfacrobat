// Zoom com dois dedos (pinça) na tela de toque. Enquanto os dedos se mexem, a
// página só é esticada (rápido); ao soltar, ela é redesenhada no zoom novo,
// com o ponto que estava entre os dedos no mesmo lugar.

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;

/** `area` é onde ficam os documentos; `activeTab()` dá a aba à vista (ou null). */
export function setupPinchZoom(area, activeTab) {
  let pinch = null;

  const measure = (touches) => {
    const [a, b] = touches;
    return {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      center: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
    };
  };

  const finish = () => {
    if (!pinch) return;
    const { tab, content, container, ratio, anchor } = pinch;
    pinch = null;
    content.style.transform = "";
    content.style.transformOrigin = "";
    if (Math.abs(ratio - 1) < 0.02 || !tab.doc) return;
    const before = tab.viewer.currentScale;
    const after = Math.min(MAX_SCALE, Math.max(MIN_SCALE, before * ratio));
    const real = after / before;
    tab.viewer.currentScale = after;
    // O ponto do documento que estava entre os dedos continua entre eles.
    container.scrollLeft = (anchor.left + anchor.x) * real - anchor.x;
    container.scrollTop = (anchor.top + anchor.y) * real - anchor.y;
  };

  area.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 2) return finish();
      const tab = activeTab();
      const container = tab?.container;
      if (!tab?.doc || !container || !container.contains(e.target) || document.querySelector("dialog[open]")) return;
      const content = container.firstElementChild;
      const { distance, center } = measure(e.touches);
      if (distance < 10) return;
      const box = container.getBoundingClientRect();
      const anchor = { x: center[0] - box.left, y: center[1] - box.top, left: container.scrollLeft, top: container.scrollTop };
      const inner = content.getBoundingClientRect();
      content.style.transformOrigin = `${center[0] - inner.left}px ${center[1] - inner.top}px`;
      pinch = { tab, container, content, start: distance, ratio: 1, anchor };
    },
    { passive: true },
  );
  area.addEventListener(
    "touchmove",
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      // Os dois dedos são do zoom: a página não rola nem o navegador dá zoom na tela toda.
      e.preventDefault();
      const scale = pinch.tab.viewer.currentScale;
      const ratio = measure(e.touches).distance / pinch.start;
      pinch.ratio = Math.min(MAX_SCALE / scale, Math.max(MIN_SCALE / scale, ratio));
      pinch.content.style.transform = `scale(${pinch.ratio})`;
    },
    { passive: false },
  );
  area.addEventListener("touchend", finish, { passive: true });
  area.addEventListener("touchcancel", finish, { passive: true });
}
