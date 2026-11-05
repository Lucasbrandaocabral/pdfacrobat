// Girar com o ponteiro (objetos, imagem e caixa de texto na ferramenta
// Editar): a alça redonda, o ângulo que aparece ao lado do ponteiro e os
// ímãs (perto de um ângulo reto, gruda nele; com Shift, de 15 em 15 graus).
// Os ângulos são da tela: positivo no sentido horário.
import { el } from "./ui.js";
import { icon } from "./icons.js";

const FINE_STEP = Math.PI / 12;
const MAGNET = (5 * Math.PI) / 180;

/** O ângulo entre -π e π. */
export const normalizeAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Em graus, de 0 a 359 (como no Canva). */
export const degrees = (a) => (Math.round((normalizeAngle(a) * 180) / Math.PI) + 360) % 360;

/**
 * O giro `turn` com os ímãs: com `fine` (Shift), de 15 em 15°; sem, preso no
 * ângulo reto mais perto quando passa a menos de 5° dele. `base` é o ângulo
 * que o objeto já tem na tela (um texto inclinado endireita no 0°).
 */
export function snapTurn(turn, base = 0, fine = false) {
  const total = base + turn;
  const step = fine ? FINE_STEP : Math.PI / 2;
  const nearest = Math.round(total / step) * step;
  return fine || Math.abs(total - nearest) < MAGNET ? nearest - base : turn;
}

/** O ângulo na tela de uma direção `angle` do PDF (radianos), pela `viewport` da página. */
export function screenAngle(viewport, angle) {
  const [x0, y0] = viewport.convertToViewportPoint(0, 0);
  const [x1, y1] = viewport.convertToViewportPoint(Math.cos(angle), Math.sin(angle));
  return Math.atan2(y1 - y0, x1 - x0);
}

/** A alça de girar: um botão redondo com a seta circular. */
export function rotateHandle(className = "") {
  return el("span", {
    class: `rotate-handle ${className}`.trim(),
    title: "Arraste para girar (com Shift, de 15 em 15°)",
    html: icon("rotateCw"),
    "aria-hidden": "true",
  });
}

/**
 * Gira com o ponteiro (do `pointerdown` `e`) em volta de `pivot` ([x, y] na
 * tela). `onTurn(turn)` a cada movimento (o giro desde o começo, com os ímãs)
 * e `onEnd(turn)` ao soltar (null se o toque foi cancelado). `base`: o ângulo
 * que o objeto já tinha, para os ímãs e o ângulo mostrado.
 */
export function dragRotation(e, pivot, { base = 0, onTurn, onEnd }) {
  e.preventDefault();
  e.stopPropagation();
  const start = Math.atan2(e.clientY - pivot[1], e.clientX - pivot[0]);
  const tip = el("div", { class: "rotate-tip", role: "status" });
  document.body.append(tip);
  let turn = 0;
  const show = (ev) => {
    tip.textContent = `${degrees(base + turn)}°`;
    Object.assign(tip.style, { left: `${ev.clientX + 18}px`, top: `${ev.clientY + 18}px` });
  };
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const raw = normalizeAngle(Math.atan2(ev.clientY - pivot[1], ev.clientX - pivot[0]) - start);
    turn = snapTurn(raw, base, ev.shiftKey);
    show(ev);
    onTurn(turn);
  };
  const finish = (ev, cancelled) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    tip.remove();
    onEnd(cancelled ? null : turn);
  };
  const up = (ev) => finish(ev, false);
  const cancel = (ev) => finish(ev, true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  show(e);
}
