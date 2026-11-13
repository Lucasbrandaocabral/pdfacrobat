// Alinhamento automático ao arrastar (como no Canva): perto da borda ou do
// meio de outro item da página, ou das bordas e do meio da página, o que está
// sendo arrastado gruda ali, e uma linha-guia mostra com o que alinhou.
import { el } from "./ui.js";

const REACH = 6;

/**
 * `rect` ({ left, top, width, height }, em px da página) é onde o item está
 * indo; `targets`, os outros itens; `page` ({ width, height }), a página.
 * Devolve o ajuste ({ dx, dy }) e as guias ({ axis, at, from, to }).
 */
export function snapRect(rect, targets, page, reach = REACH) {
  const others = [...targets];
  if (page) others.push({ left: 0, top: 0, width: page.width, height: page.height, page: true });
  const axis = (start, size, cross, crossSize) => {
    const mine = [rect[start], rect[start] + rect[size] / 2, rect[start] + rect[size]];
    let best = null;
    for (const other of others) {
      const theirs = [other[start], other[start] + other[size] / 2, other[start] + other[size]];
      for (const [i, m] of mine.entries()) {
        for (const [j, t] of theirs.entries()) {
          // Bordas com bordas e meio com meio.
          if ((i === 1) !== (j === 1)) continue;
          const gap = t - m;
          if (Math.abs(gap) > reach) continue;
          if (!best || Math.abs(gap) < Math.abs(best.gap) - 0.01) best = { gap, at: t, matches: [other] };
          else if (Math.abs(gap - best.gap) <= 0.01 && Math.abs(t - best.at) <= 0.01) best.matches.push(other);
        }
      }
    }
    if (!best) return { shift: 0, guide: null };
    const spans = [rect, ...best.matches].flatMap((r) => [r[cross], r[cross] + r[crossSize]]);
    return { shift: best.gap, guide: { at: best.at, from: Math.min(...spans), to: Math.max(...spans) } };
  };
  const x = axis("left", "width", "top", "height");
  const y = axis("top", "height", "left", "width");
  const guides = [];
  if (x.guide) guides.push({ axis: "x", ...x.guide });
  if (y.guide) guides.push({ axis: "y", ...y.guide });
  return { dx: x.shift, dy: y.shift, guides };
}

/** Desenha as guias em `layer` (a camada da página); sem guias, tira as que havia. */
export function showGuides(layer, guides = []) {
  if (!layer) return;
  for (const node of layer.querySelectorAll(":scope > .snap-guide")) node.remove();
  for (const guide of guides) {
    const node = el("div", { class: `snap-guide ${guide.axis}`, "aria-hidden": "true" });
    if (guide.axis === "x") Object.assign(node.style, { left: `${guide.at}px`, top: `${guide.from}px`, height: `${guide.to - guide.from}px` });
    else Object.assign(node.style, { top: `${guide.at}px`, left: `${guide.from}px`, width: `${guide.to - guide.from}px` });
    layer.append(node);
  }
}
