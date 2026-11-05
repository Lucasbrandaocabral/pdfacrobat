// Animações curtas da janela de Novidades: uma cena em SVG por recurso, que
// mostra o gesto (o cursor arrastando, a tecla apertada, o dedo segurando).
// No NOVIDADES.md, o item que tem cena termina com o comentário "demo: nome",
// com o nome de uma das cenas daqui; as correções não têm.
//
// Cada cena tem o desenho (em 240 × 150) e as trilhas, tocadas com a Web
// Animations API. Uma trilha diz, em frações da duração, onde fica um
// elemento ("xy": [t, x, y] e, se mudar, a escala), o tamanho ("s": [t, sx,
// sy]), quanto ele aparece ("o": [t, opacidade]; "fo" nas letras de um texto)
// ou quanto de um traço já foi desenhado ("dash"). Todas as trilhas de uma
// cena têm a mesma duração e repetem juntas, sem atraso: o quadro t é o
// mesmo para todas. `still` é o quadro mostrado parado (movimento reduzido)
// e `experimentar` diz o que o botão Experimentar abre.

import { icon } from "./icons.js";

const EASE = "cubic-bezier(.45, 0, .25, 1)";

// ---- Peças do desenho ----

/** Folha branca com uma sombra leve. */
const page = (x, y, w, h) =>
  `<rect class="d-shadow" x="${x}" y="${y + 1.2}" width="${w}" height="${h}" rx="1.5"/><rect class="d-page" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5"/>`;

/** Linhas de texto (barras): [x, y, largura]. */
const bars = (rows, h = 3.4, cls = "d-ln") =>
  rows.map(([x, y, w]) => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`).join("");

const heading = (x, y, w, h = 5) => bars([[x, y, w]], h, "d-hd");

/** Foto: céu, sol e morros. */
function picture(x, y, w, h) {
  const at = (fx, fy) => `${+(x + w * fx).toFixed(2)} ${+(y + h * fy).toFixed(2)}`;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="#d6e6fb"/>` +
    `<circle cx="${+(x + w * 0.74).toFixed(2)}" cy="${+(y + h * 0.3).toFixed(2)}" r="${+(h * 0.13).toFixed(2)}" fill="#ffc94d"/>` +
    `<path d="M${at(0, 1)}L${at(0.32, 0.46)}L${at(0.56, 0.8)}L${at(0.74, 0.6)}L${at(1, 1)}Z" fill="#5b9ae6"/>`
  );
}

/** Estrela (desenho do PDF) com centro em (cx, cy). */
function star(cx, cy, r) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 ? r * 0.45 : r;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${+(cx + radius * Math.cos(angle)).toFixed(2)},${+(cy + radius * Math.sin(angle)).toFixed(2)}`;
  });
  return `<polygon class="d-star" points="${points.join(" ")}"/>`;
}

/** Contorno azul de objeto selecionado, como o do programa. */
const outline = (x, y, w, h, cls = "") => `<rect class="d-sel ${cls}" x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" rx="1.5"/>`;

/** Ponteiro do mouse, com a ponta em (0, 0); `extra` vai junto (ex.: o "+" de copiar). */
const cursor = (cls = "cur", extra = "") => `<g class="${cls}"><path class="d-arrow" d="M0 0V12.4L3 9.6L5.2 14.3L7.4 13.4L5.2 8.8H9.3Z"/>${extra}</g>`;
const COPY_BADGE = '<g class="plus"><circle class="d-badge" cx="11" cy="14.5" r="3.6"/><path class="d-badge-mark" d="M11 12.7v3.6M9.2 14.5h3.6"/></g>';

/** Onda que marca um clique (ou toque) em (x, y). */
const ripple = (x, y, cls) => `<circle class="d-ripple sc ${cls}" cx="${x}" cy="${y}" r="5"/>`;

/** Teclas lado a lado, centradas em cx; a camada "d-key-down" mostra a tecla apertada. */
function keycaps(cx, y, labels, cls) {
  const widths = labels.map((label) => Math.max(14, label.length * 5 + 7));
  let x = cx - (widths.reduce((a, b) => a + b, 0) + 3 * (labels.length - 1)) / 2;
  const caps = labels.map((label, i) => {
    const w = widths[i];
    const cap =
      `<rect class="d-key-up" x="${x}" y="${y}" width="${w}" height="13" rx="3"/>` +
      `<rect class="d-key-down" x="${x}" y="${y}" width="${w}" height="13" rx="3"/>` +
      `<text class="d-key-text" x="${x + w / 2}" y="${y + 9.1}">${label}</text>`;
    x += w + 3;
    return cap;
  });
  return `<g class="${cls}">${caps.join("")}</g>`;
}

/** Dedo (toque), com centro em (0, 0). */
const finger = (cls) => `<g class="${cls}"><circle class="d-touch" r="7"/></g>`;

// Anel que se fecha enquanto o dedo fica parado (toque longo). O vão do
// tracejado é maior que o círculo: com a ponta redonda, um traço de
// comprimento zero na emenda viraria um ponto.
const RING = 62.83;
const RING_OFF = RING + 3;
const ring = (cls) =>
  `<g class="${cls}"><circle class="d-ring" r="10" transform="rotate(-90)" stroke-dasharray="${RING} ${RING + 8}" stroke-dashoffset="${RING_OFF}"/></g>`;

/** Balão com um botão (como a barrinha do celular). */
const bubble = (x, y, w, label, cls) =>
  `<g class="${cls}"><rect class="d-bubble" x="${x}" y="${y}" width="${w}" height="12" rx="3.5"/><rect class="d-bubble-down" x="${x}" y="${y}" width="${w}" height="12" rx="3.5"/><text class="d-bubble-text" x="${x + w / 2}" y="${y + 8.3}">${label}</text></g>`;

/** Alça de largura da caixa de texto, com centro em (0, 0). */
const sizer = (cls) =>
  `<g class="${cls}"><rect class="d-sizer" x="-2.3" y="-6.5" width="4.6" height="13" rx="2.3"/><rect class="d-sizer-on" x="-2.3" y="-6.5" width="4.6" height="13" rx="2.3"/></g>`;

// ---- Trilhas prontas ----

/** Aparece entre a e b, some entre c e d. */
const show = (a, b, c, d) => [
  [0, 0],
  [a, 0],
  [b, 1],
  [c, 1],
  [d, 0],
];

/** Onda de clique em t, num `ripple` de classe `cls`. */
const click = (cls, t) => [
  [`.${cls}`, "o", [[0, 0], [t, 0], [t + 0.004, 0.9], [t + 0.07, 0]]],
  [`.${cls}`, "s", [[0, 0.4], [t, 0.4], [t + 0.07, 1.7]]],
];

/** Cursor de texto piscando de a até b (aceso no começo). */
function blink(a, b, step = 0.035) {
  const frames = [];
  for (let t = a, on = true; t < b - 1e-6; t += step, on = !on) frames.push([t, on ? 1 : 0], [Math.min(b, t + step - 0.004), on ? 1 : 0]);
  return frames;
}

// ---- Cenas ----

const SCENES = {
  // Selecionar, arrastar, Ctrl+C numa página e Ctrl+V na outra.
  mover: {
    duration: 8000,
    still: 0.84,
    experimentar: {
      category: "edit",
      action: "tool:edit",
      tip: "Clique num objeto e arraste. Ctrl+C e Ctrl+V levam para outra página.",
      touchTip: "Segure o dedo num objeto para selecionar e arraste.",
    },
    draw: () => ({
      svg: [
        page(24, 12, 88, 112),
        heading(32, 21, 44),
        bars([[32, 31, 72], [32, 38, 68], [32, 45, 70], [32, 92, 72], [32, 99, 64], [32, 106, 70], [32, 113, 40]]),
        page(128, 12, 88, 112),
        heading(136, 21, 40),
        bars([[136, 31, 72], [136, 38, 56], [136, 99, 72], [136, 106, 60], [136, 113, 66]]),
        `<g class="obj">${picture(32, 55, 34, 26)}${outline(32, 55, 34, 26, "sel")}</g>`,
        `<g class="copy sc">${picture(150, 62, 34, 26)}${outline(150, 62, 34, 26)}</g>`,
        keycaps(68, 130, ["Ctrl", "C"], "kc"),
        keycaps(172, 130, ["Ctrl", "V"], "kv"),
        ripple(49, 68, "r1"),
        ripple(167, 75, "r2"),
        cursor(),
      ].join(""),
      tracks: [
        [".cur", "o", [[0, 0], [0.03, 1], [0.9, 1], [0.93, 0]]],
        [".cur", "xy", [[0, 74, 140], [0.03, 74, 140], [0.12, 49, 68], [0.2, 49, 68], [0.36, 83, 68], [0.56, 83, 68], [0.66, 167, 75], [0.93, 167, 75], [1, 74, 140]]],
        ...click("r1", 0.145),
        [".sel", "o", show(0.145, 0.16, 0.76, 0.78)],
        [".obj", "xy", [[0, 0, 0], [0.2, 0, 0], [0.36, 34, 0], [0.955, 34, 0], [0.955, 0, 0]]],
        [".obj", "o", [[0, 1], [0.91, 1], [0.94, 0], [0.96, 0], [1, 1]]],
        [".kc", "o", show(0.4, 0.43, 0.53, 0.56)],
        [".kc .d-key-down", "o", show(0.45, 0.455, 0.5, 0.505)],
        ...click("r2", 0.675),
        [".kv", "o", show(0.69, 0.72, 0.84, 0.87)],
        [".kv .d-key-down", "o", show(0.74, 0.745, 0.79, 0.795)],
        [".copy", "o", show(0.76, 0.79, 0.91, 0.94)],
        [".copy", "s", [[0, 0.9], [0.76, 0.9], [0.8, 1]]],
      ],
    }),
  },

  // Alt apertado: o original fica e a cópia vai com o cursor.
  duplicar: {
    duration: 7000,
    still: 0.75,
    experimentar: {
      category: "edit",
      action: "tool:edit",
      tip: "Segure Alt e arraste um objeto: o original fica no lugar e a cópia vai junto.",
    },
    draw: () => ({
      svg: [
        page(70, 10, 100, 130),
        heading(80, 20, 50),
        bars([[80, 30, 80], [80, 37, 76], [80, 44, 78], [80, 100, 80], [80, 107, 70], [80, 114, 76], [80, 121, 50]]),
        star(100, 72, 13),
        outline(86, 58, 28, 28, "sel"),
        `<g class="dup">${star(100, 72, 13)}${outline(86, 58, 28, 28)}</g>`,
        keycaps(36, 66, ["Alt"], "ka"),
        ripple(100, 72, "r1"),
        cursor("cur", COPY_BADGE),
      ].join(""),
      tracks: [
        [".cur", "o", [[0, 0], [0.03, 1], [0.9, 1], [0.93, 0]]],
        [".cur", "xy", [[0, 124, 146], [0.03, 124, 146], [0.12, 100, 72], [0.28, 100, 72], [0.48, 146, 78], [0.93, 146, 78], [1, 124, 146]]],
        ...click("r1", 0.145),
        [".sel", "o", show(0.145, 0.16, 0.28, 0.29)],
        [".ka", "o", show(0.19, 0.22, 0.56, 0.6)],
        [".ka .d-key-down", "o", show(0.24, 0.25, 0.52, 0.53)],
        [".plus", "o", show(0.26, 0.27, 0.5, 0.52)],
        [".dup", "o", show(0.28, 0.285, 0.9, 0.93)],
        [".dup", "xy", [[0, 0, 0], [0.28, 0, 0], [0.48, 46, 6], [0.95, 46, 6], [0.95, 0, 0]]],
      ],
    }),
  },

  // Celular: segurar o dedo seleciona, Copiar, segurar numa parte vazia e Colar aqui.
  celular: {
    duration: 9500,
    still: 0.86,
    experimentar: {
      category: "edit",
      action: "tool:edit",
      tip: "No celular, segure o dedo num objeto para selecionar e numa parte vazia da página para colar.",
      touchTip: "Segure o dedo num objeto para selecionar e numa parte vazia da página para colar.",
    },
    draw: () => ({
      svg: [
        '<rect class="d-phone" x="78" y="2" width="84" height="146" rx="13"/>',
        '<rect class="d-screen" x="82" y="9" width="76" height="132" rx="4"/>',
        '<rect class="d-notch" x="110" y="4.6" width="20" height="2" rx="1"/>',
        page(86, 14, 68, 122),
        heading(92, 21, 34, 4.5),
        bars([[92, 30, 56], [92, 36, 50], [92, 42, 54], [92, 112, 56], [92, 118, 46], [92, 124, 52]], 3),
        picture(92, 50, 28, 21),
        outline(92, 50, 28, 21, "sel"),
        bubble(92, 76, 36, "Copiar", "bar"),
        `<g class="paste sc">${picture(106, 87.5, 28, 21)}${outline(106, 87.5, 28, 21)}</g>`,
        `<g class="menu sc">${bubble(97, 74, 46, "Colar aqui", "menu-in")}</g>`,
        ring("rg"),
        finger("fg"),
      ].join(""),
      tracks: [
        [".fg", "o", [[0, 0], [0.04, 1], [0.25, 1], [0.28, 0], [0.33, 0], [0.35, 1], [0.39, 1], [0.41, 0], [0.47, 0], [0.5, 1], [0.69, 1], [0.71, 0], [0.73, 0], [0.75, 1], [0.79, 1], [0.81, 0]]],
        [
          ".fg",
          "xy",
          [[0, 106, 60.5, 1.35], [0.04, 106, 60.5, 1], [0.28, 106, 60.5, 1], [0.3, 110, 82, 1.35], [0.33, 110, 82, 1.35], [0.35, 110, 82, 1], [0.365, 110, 82, 0.82], [0.39, 110, 82, 1], [0.42, 120, 98, 1.35], [0.47, 120, 98, 1.35], [0.5, 120, 98, 1], [0.71, 120, 98, 1], [0.72, 120, 80, 1.35], [0.73, 120, 80, 1.35], [0.75, 120, 80, 1], [0.765, 120, 80, 0.82], [0.79, 120, 80, 1], [0.95, 120, 80, 1], [1, 106, 60.5, 1.35]],
        ],
        [".rg", "o", [[0, 0], [0.04, 0], [0.05, 1], [0.22, 1], [0.25, 0], [0.5, 0], [0.51, 1], [0.66, 1], [0.68, 0]]],
        [".rg", "xy", [[0, 106, 60.5], [0.4, 106, 60.5], [0.4, 120, 98], [0.95, 120, 98], [0.95, 106, 60.5]]],
        [".rg .d-ring", "dash", [[0, RING_OFF], [0.05, RING_OFF], [0.22, 0], [0.3, 0], [0.3, RING_OFF], [0.51, RING_OFF], [0.66, 0], [0.7, 0], [0.7, RING_OFF]]],
        [".sel", "o", show(0.22, 0.24, 0.66, 0.68)],
        [".bar", "o", show(0.28, 0.31, 0.41, 0.44)],
        [".bar .d-bubble-down", "o", show(0.365, 0.37, 0.4, 0.41)],
        [".menu", "o", show(0.66, 0.69, 0.78, 0.8)],
        [".menu", "s", [[0, 0.85], [0.66, 0.85], [0.69, 1]]],
        [".menu .d-bubble-down", "o", show(0.765, 0.77, 0.78, 0.8)],
        [".paste", "o", show(0.79, 0.82, 0.93, 0.96)],
        [".paste", "s", [[0, 0.9], [0.79, 0.9], [0.83, 1]]],
      ],
    }),
  },

  // Alça da lateral: a caixa fica mais estreita e o texto quebra em mais linhas.
  largura: {
    duration: 7000,
    still: 0.5,
    experimentar: {
      category: "edit",
      action: "tool:addtext",
      tip: "Clique na página e escreva; arraste as alças das laterais da caixa para mudar a largura.",
    },
    draw: () => {
      // O mesmo texto (a mesma soma de larguras) em 3, 4 e 5 linhas.
      const layouts = {
        l3: [96, 92, 40],
        l4: [74, 70, 66, 18],
        l5: [54, 52, 50, 54, 18],
      };
      // Caixa: 3 de folga em volta do texto, que começa em (72, 48).
      const box = (widths) => ({ w: Math.max(...widths) + 6, h: (widths.length - 1) * 7 + 3.4 + 6 });
      const W = box(layouts.l3);
      const M = box(layouts.l4);
      const N = box(layouts.l5);
      // [t, estado da largura, estado da altura]: a largura segue a alça; a altura, as linhas.
      const steps = [[0, W, W], [0.2, W, W], [0.23, W, M], [0.32, M, M], [0.36, M, M], [0.39, M, N], [0.48, N, N], [0.56, N, N], [0.7, W, N], [0.73, W, W]];
      const right = steps.map(([t, a, b]) => [t, 69 + a.w + 6, 45 + b.h / 2]);
      return {
        svg: [
          page(50, 10, 140, 130),
          heading(62, 20, 60),
          bars([[62, 31, 110], [62, 104, 116], [62, 111, 100], [62, 118, 110], [62, 125, 70]]),
          ...Object.entries(layouts).map(([cls, widths]) => `<g class="${cls}">${bars(widths.map((w, i) => [72, 48 + 7 * i, w]))}</g>`),
          `<rect class="d-box sc-tl bx" x="69" y="45" width="${W.w}" height="${W.h}" rx="1"/>`,
          sizer("hl"),
          sizer("hr"),
          cursor(),
        ].join(""),
        tracks: [
          [".l3", "o", [[0, 1], [0.2, 1], [0.215, 0], [0.71, 0], [0.73, 1]]],
          [".l4", "o", [[0, 0], [0.205, 0], [0.23, 1], [0.36, 1], [0.375, 0]]],
          [".l5", "o", [[0, 0], [0.365, 0], [0.39, 1], [0.7, 1], [0.712, 0]]],
          [".bx", "s", steps.map(([t, a, b]) => [t, a.w / W.w, b.h / W.h])],
          [".hr", "xy", right],
          [".hl", "xy", steps.map(([t, , b]) => [t, 63, 45 + b.h / 2])],
          [".hr .d-sizer-on", "o", show(0.17, 0.18, 0.73, 0.74)],
          [".cur", "o", [[0, 0], [0.04, 1], [0.84, 1], [0.88, 0]]],
          [".cur", "xy", [[0, 198, 124], [0.04, 198, 124], [0.14, ...right[0].slice(1)], ...right.slice(1), [0.84, ...right[0].slice(1)], [0.88, 198, 124]]],
        ],
      };
    },
  },

  // Um clique numa palavra abre o parágrafo inteiro; o texto se reorganiza ao escrever.
  paragrafo: {
    duration: 7500,
    still: 0.64,
    experimentar: {
      category: "edit",
      action: "tool:edit",
      tip: "Clique numa palavra: o parágrafo inteiro fica pronto para editar.",
    },
    draw: (id) => ({
      svg: [
        `<defs><clipPath id="${id}-texto"><rect x="60" y="54" width="118.5" height="40"/></clipPath></defs>`,
        page(50, 8, 140, 134),
        heading(62, 18, 70, 5.5),
        bars([[62, 30, 116], [62, 37, 116], [62, 44, 64]]),
        `<rect class="d-hover hov" x="59" y="55" width="122" height="30.4" rx="1"/>`,
        `<g class="pa" clip-path="url(#${id}-texto)">${bars([[62, 58, 116], [62, 65, 40], [62, 72, 116], [62, 79, 84]])}<rect class="d-new sc-l tw" x="106" y="65" width="18" height="3.4" rx="1.7"/><g class="rs">${bars([[106, 65, 72]])}</g></g>`,
        `<g class="pb">${bars([[62, 58, 116], [62, 65, 40], [128, 65, 50], [62, 72, 116], [62, 79, 116], [62, 86, 30]])}${bars([[106, 65, 18]], 3.4, "d-new")}</g>`,
        `<g class="p3">${bars([[62, 96, 116], [62, 103, 116], [62, 110, 116], [62, 117, 52]])}</g>`,
        '<rect class="d-box sc-tl bx" x="59" y="55" width="122" height="30.4" rx="1"/>',
        sizer("hl"),
        sizer("hr"),
        '<g class="caret"><rect class="d-caret" x="-0.6" y="63.2" width="1.2" height="7.2"/></g>',
        ripple(104, 66.7, "r1"),
        cursor(),
      ].join(""),
      tracks: [
        [".cur", "o", [[0, 0], [0.03, 1], [0.3, 1], [0.34, 0]]],
        [".cur", "xy", [[0, 170, 140], [0.03, 170, 140], [0.14, 104, 66.7], [0.2, 104, 66.7], [0.3, 150, 124], [0.34, 150, 124], [1, 170, 140]]],
        ...click("r1", 0.17),
        [".hov", "o", [[0, 0], [0.1, 0], [0.12, 0.9], [0.17, 0.9], [0.175, 0]]],
        [".bx", "o", show(0.17, 0.175, 0.88, 0.92)],
        [".bx", "s", [[0, 1, 1], [0.46, 1, 1], [0.49, 1, 37.4 / 30.4], [0.92, 1, 37.4 / 30.4], [0.95, 1, 1]]],
        [".hl, .hr", "o", show(0.17, 0.175, 0.88, 0.92)],
        [".hl", "xy", [[0, 53, 70.2], [0.46, 53, 70.2], [0.49, 53, 73.7], [0.92, 53, 73.7], [0.95, 53, 70.2]]],
        [".hr", "xy", [[0, 187, 70.2], [0.46, 187, 70.2], [0.49, 187, 73.7], [0.92, 187, 73.7], [0.95, 187, 70.2]]],
        [".caret", "o", [[0, 0], [0.17, 0], ...blink(0.175, 0.26), [0.26, 1], [0.49, 1], ...blink(0.5, 0.88), [0.88, 1], [0.9, 0]]],
        [".caret", "xy", [[0, 104, 0], [0.26, 104, 0], [0.26, 106, 0], [0.44, 125, 0], [0.9, 125, 0], [0.92, 104, 0]]],
        [".tw", "s", [[0, 0, 1], [0.26, 0, 1], [0.44, 1, 1], [0.89, 1, 1], [0.89, 0, 1]]],
        [".rs", "xy", [[0, 0, 0], [0.26, 0, 0], [0.44, 22, 0], [0.89, 22, 0], [0.89, 0, 0]]],
        [".pa", "o", [[0, 1], [0.46, 1], [0.49, 0], [0.9, 0], [0.94, 1]]],
        [".pb", "o", [[0, 0], [0.46, 0], [0.49, 1], [0.9, 1], [0.94, 0]]],
        [".p3", "xy", [[0, 0, 0], [0.46, 0, 0], [0.49, 0, 7], [0.9, 0, 7], [0.94, 0, 0]]],
      ],
    }),
  },

  // Preencher e assinar: ✓ na caixa, a data de hoje e a assinatura sendo feita.
  assinar: {
    duration: 6500,
    still: 0.8,
    experimentar: { category: "fill", action: "sign" },
    draw: () => ({
      svg: [
        page(60, 8, 120, 134),
        heading(70, 18, 56),
        bars([[70, 28, 100], [70, 35, 96], [70, 42, 100], [70, 49, 60], [81, 62, 64], [81, 74, 48], [70, 87.5, 20]]),
        '<rect class="d-check-box" x="70" y="60" width="7.5" height="7.5" rx="1"/>',
        '<rect class="d-check-box" x="70" y="72" width="7.5" height="7.5" rx="1"/>',
        '<path class="d-mark sc ck" d="M71.6 64.1l2.1 2.2 4.1-4.9"/>',
        `<g class="date"><text class="d-date" x="95" y="91.2">${new Date().toLocaleDateString("pt-BR")}</text></g>`,
        '<path class="d-rule" d="M98 124H172"/>',
        bars([[117, 127.5, 36]], 2.4),
        '<path class="d-ink sig" pathLength="100" stroke-dasharray="100 110" stroke-dashoffset="105" d="M102 119C104 110 108 104 111 106C114 108 109 118 106 121C104 123 108 116 112 113C115 110 118 111 117 115C116 119 120 118 122 114C124 110 126 109 127 113C128 117 131 117 133 113C135 109 137 109 138 113C139 117 142 116 144 112C146 108 149 107 150 111C151 115 154 116 157 112C159 109 162 107 166 106"/>',
        '<path class="d-ink sig2" pathLength="100" stroke-dasharray="100 110" stroke-dashoffset="105" d="M104 122C122 119 146 119 170 115"/>',
      ].join(""),
      tracks: [
        [".ck", "o", show(0.08, 0.1, 0.9, 0.94)],
        [".ck", "s", [[0, 0.3], [0.08, 0.3], [0.12, 1.15], [0.14, 1]]],
        [".date", "o", show(0.18, 0.21, 0.9, 0.94)],
        [".date", "xy", [[0, 0, 2], [0.18, 0, 2], [0.22, 0, 0]]],
        [".sig", "dash", [[0, 105], [0.28, 105], [0.62, 0], [0.95, 0], [0.95, 105]]],
        [".sig2", "dash", [[0, 105], [0.62, 105], [0.7, 0], [0.95, 0], [0.95, 105]]],
        [".sig, .sig2", "o", [[0, 1], [0.9, 1], [0.94, 0], [0.95, 0], [0.96, 1]]],
      ],
    }),
  },

  // Tarjar: pesquisa "CPF", os achados ficam marcados e a tarja preta cobre.
  tarjar: {
    duration: 7000,
    still: 0.7,
    experimentar: { category: "protect", action: "redact" },
    draw: () => {
      const found = [
        [122, 30, 34],
        [108, 58, 34],
        [130, 114, 34],
      ];
      return {
        svg: [
          '<g class="find"><rect class="d-field" x="6" y="14" width="58" height="15" rx="7.5"/><circle class="d-glass" cx="15" cy="21.2" r="3"/><path class="d-glass" d="M17.2 23.4l2.4 2.4"/>',
          '<text class="d-field-text" x="24" y="24.4"><tspan class="t1">C</tspan><tspan class="t2">P</tspan><tspan class="t3">F</tspan></text></g>',
          page(72, 8, 104, 134),
          heading(82, 18, 50),
          bars([[82, 30, 36], [160, 30, 6], [82, 37, 84], [82, 44, 80], [82, 58, 22], [146, 58, 20], [82, 65, 84], [82, 72, 60], [82, 86, 84], [82, 93, 78], [82, 100, 82], [82, 114, 44], [82, 121, 70], [82, 128, 50]]),
          bars(found),
          found.map(([x, y, w]) => `<rect class="d-hit hit" x="${x - 1.5}" y="${y - 1.5}" width="${w + 3}" height="6.4" rx="1"/>`).join(""),
          found.map(([x, y, w], i) => `<rect class="d-redact sc-l b${i + 1}" x="${x - 1}" y="${y - 1.2}" width="${w + 2}" height="5.8"/>`).join(""),
        ].join(""),
        tracks: [
          [".find", "o", [[0, 0], [0.04, 1], [0.88, 1], [0.92, 0]]],
          ...[".t1", ".t2", ".t3"].map((cls, i) => [cls, "fo", [[0, 0], [0.1 + 0.04 * i, 0], [0.101 + 0.04 * i, 1], [0.95, 1], [0.95, 0]]]),
          [".hit", "o", show(0.24, 0.27, 0.56, 0.6)],
          ...[".b1", ".b2", ".b3"].map((cls, i) => [cls, "s", [[0, 0, 1], [0.34 + 0.04 * i, 0, 1], [0.44 + 0.04 * i, 1, 1], [0.95, 1, 1], [0.95, 0, 1]]]),
          [".b1, .b2, .b3", "o", [[0, 1], [0.88, 1], [0.92, 0], [0.96, 0], [1, 1]]],
        ],
      };
    },
  },

  // Recortar: a moldura vem para dentro pelos cantos e a página fica só com o miolo.
  recortar: {
    duration: 7500,
    still: 0.52,
    experimentar: { category: "pages", action: "crop" },
    draw: () => {
      // Moldura: a página toda, depois de arrastar o canto de baixo e por fim o de cima.
      const F0 = { x: 70, y: 6, w: 100, h: 128 };
      const F1 = { x: 70, y: 6, w: 88, h: 112 };
      const F2 = { x: 82, y: 18, w: 76, h: 100 };
      const at = [[0, F0], [0.13, F0], [0.27, F1], [0.35, F1], [0.49, F2], [0.95, F2], [0.95, F0]];
      const corner = (fx, fy) => at.map(([t, f]) => [t, f.x + f.w * fx, f.y + f.h * fy]);
      const handle = (cls) => `<g class="${cls}"><rect class="d-handle" x="-2.6" y="-2.6" width="5.2" height="5.2" rx="1"/></g>`;
      return {
        svg: [
          `<g class="pg sc-tl">${page(70, 6, 100, 128)}</g>`,
          heading(86, 22, 40),
          bars([[86, 32, 68], [86, 39, 64], [86, 46, 66], [124, 57, 30], [124, 64, 28], [124, 71, 30], [86, 90, 68], [86, 97, 60], [86, 104, 66], [86, 111, 40]]),
          picture(86, 56, 34, 26),
          '<g class="shade"><g class="d-shade">',
          '<rect class="sc-t st" x="70" y="6" width="100" height="12"/><rect class="sc-b sb" x="70" y="118" width="100" height="16"/>',
          '<rect class="sc-l sl" x="70" y="6" width="12" height="128"/><rect class="sc-r sr" x="158" y="6" width="12" height="128"/></g></g>',
          '<rect class="d-frame sc-tl fr" x="70" y="6" width="100" height="128"/>',
          handle("c1"),
          handle("c2"),
          handle("c3"),
          handle("c4"),
          cursor(),
        ].join(""),
        tracks: [
          [".fr", "xy", at.map(([t, f]) => [t, f.x - F0.x, f.y - F0.y, f.w / F0.w, f.h / F0.h])],
          [".c1", "xy", corner(0, 0)],
          [".c2", "xy", corner(1, 0)],
          [".c3", "xy", corner(0, 1)],
          [".c4", "xy", corner(1, 1)],
          [".fr, .c1, .c2, .c3, .c4", "o", [[0, 1], [0.62, 1], [0.66, 0], [0.95, 0], [0.99, 1]]],
          [".st", "s", [[0, 1, 0], [0.35, 1, 0], [0.49, 1, 1], [0.95, 1, 1], [0.95, 1, 0]]],
          [".sb", "s", [[0, 1, 0], [0.13, 1, 0], [0.27, 1, 1], [0.95, 1, 1], [0.95, 1, 0]]],
          [".sl", "s", [[0, 0, 1], [0.35, 0, 1], [0.49, 1, 1], [0.95, 1, 1], [0.95, 0, 1]]],
          [".sr", "s", [[0, 0, 1], [0.13, 0, 1], [0.27, 1, 1], [0.95, 1, 1], [0.95, 0, 1]]],
          [".shade", "o", [[0, 1], [0.6, 1], [0.64, 0], [0.95, 0], [0.95, 1]]],
          [".pg", "xy", [[0, 0, 0], [0.6, 0, 0], [0.68, 12, 12, F2.w / F0.w, F2.h / F0.h], [0.86, 12, 12, F2.w / F0.w, F2.h / F0.h], [0.94, 0, 0]]],
          [".cur", "o", [[0, 0], [0.03, 1], [0.56, 1], [0.6, 0]]],
          [".cur", "xy", [[0, 200, 146], [0.03, 200, 146], [0.1, 170, 134], [0.13, 170, 134], [0.27, 158, 118], [0.31, 70, 6], [0.35, 70, 6], [0.49, 82, 18], [0.52, 82, 18], [0.6, 40, 120], [1, 200, 146]]],
        ],
      };
    },
  },

  // Dividir: a tesoura passa entre a página 3 e a 4 e saem dois arquivos.
  dividir: {
    duration: 7000,
    still: 0.75,
    experimentar: { category: "pages", action: "split" },
    draw: () => {
      const sheet = (i) => {
        const x = 33 + 30 * i;
        return `${page(x, 38, 24, 32)}${bars([[x + 5, 43, 10]], 2.4, "d-hd")}<text class="d-num" x="${x + 12}" y="60">${i + 1}</text>`;
      };
      return {
        svg: [
          `<g class="ga">${[0, 1, 2].map(sheet).join("")}</g>`,
          `<g class="gb">${[3, 4, 5].map(sheet).join("")}</g>`,
          '<path class="d-cut sc-t cut" d="M120 31V78"/>',
          '<g class="sci"><g class="d-scissors"><circle cx="-3" cy="-6.5" r="2.3"/><circle cx="3" cy="-6.5" r="2.3"/><path d="M-1.6 -4.4L2 5M1.6 -4.4L-2 5"/></g></g>',
          '<g class="labels"><text class="d-label" x="59" y="96">Parte 1.pdf</text><text class="d-label" x="181" y="96">Parte 2.pdf</text></g>',
        ].join(""),
        tracks: [
          [".cut", "o", [[0, 0], [0.11, 0], [0.12, 1], [0.4, 1], [0.44, 0]]],
          [".cut", "s", [[0, 1, 0], [0.12, 1, 0], [0.36, 1, 1], [0.95, 1, 1], [0.95, 1, 0]]],
          [".sci", "o", show(0.1, 0.13, 0.38, 0.42)],
          [".sci", "xy", [[0, 120, 31], [0.12, 120, 31], [0.36, 120, 78], [0.95, 120, 78], [0.95, 120, 31]]],
          [".ga", "xy", [[0, 0, 0], [0.42, 0, 0], [0.54, -16, 12], [0.86, -16, 12], [0.95, 0, 0]]],
          [".gb", "xy", [[0, 0, 0], [0.42, 0, 0], [0.54, 16, 12], [0.86, 16, 12], [0.95, 0, 0]]],
          [".labels", "o", show(0.54, 0.58, 0.84, 0.88)],
        ],
      };
    },
  },

  // Imprimir: quatro páginas entram numa folha só.
  imprimir: {
    duration: 7500,
    still: 0.62,
    experimentar: { action: "print" },
    draw: () => {
      const tops = [37, 81, 125, 169];
      const cells = [
        [76, 66.6],
        [105.5, 66.6],
        [76, 105.1],
        [105.5, 105.1],
      ];
      const scale = 0.779;
      return {
        svg: [
          page(72, 62, 64, 82),
          '<g class="lbl"><text class="d-label d-left" x="146" y="100">4 páginas</text><text class="d-label d-left d-muted" x="146" y="110">por folha</text></g>',
          ...tops.map((x, i) => `<g class="p${i + 1} sc-tl">${page(x, 8, 34, 44)}${bars([[x + 6, 14, 16]], 2.6, "d-hd")}<text class="d-num d-big" x="${x + 17}" y="38">${i + 1}</text></g>`),
        ].join(""),
        tracks: [
          ...tops.map((x, i) => {
            const [cx, cy] = cells[i];
            const t = 0.14 + 0.08 * i;
            return [`.p${i + 1}`, "xy", [[0, 0, 0, 1], [t, 0, 0, 1], [t + 0.14, cx - x, cy - 8, scale], [0.94, cx - x, cy - 8, scale], [0.94, 0, 0, 1]]];
          }),
          [".p1, .p2, .p3, .p4", "o", [[0, 1], [0.88, 1], [0.92, 0], [0.95, 0], [0.98, 1]]],
          [".lbl", "o", show(0.56, 0.6, 0.88, 0.92)],
        ],
      };
    },
  },
};

// ---- Tocar ----

const FORMAT = {
  xy: ([x, y, sx = 1, sy = sx]) => ({ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})` }),
  s: ([sx, sy = sx]) => ({ transform: `scale(${sx}, ${sy})` }),
  o: ([value]) => ({ opacity: value }),
  fo: ([value]) => ({ fillOpacity: value }),
  dash: ([value]) => ({ strokeDashoffset: `${value}px` }),
};

/** Quadros da Web Animations API, do começo (0) ao fim (1) da cena. */
function keyframes(kind, frames) {
  const list = frames.map(([offset, ...values]) => ({ offset, easing: EASE, ...FORMAT[kind](values) }));
  if (list[0].offset > 0) list.unshift({ ...list[0], offset: 0 });
  if (list[list.length - 1].offset < 1) list.push({ ...list[list.length - 1], offset: 1 });
  return list;
}

/** Se há uma cena com esse nome (e o navegador sabe animar). */
export function hasDemo(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SCENES, name) && typeof Element.prototype.animate === "function";
}

let count = 0;

/**
 * Uma cena pronta para pôr na página: `node` é um botão (um clique pausa ou
 * continua). Toca enquanto aparece na tela (`setVisible`); com movimento
 * reduzido, começa parada no quadro principal.
 */
export class Demo {
  constructor(name) {
    const scene = SCENES[name];
    const { svg, tracks } = scene.draw(`demo-${++count}`);
    this.name = name;
    this.experimentar = scene.experimentar ?? null;
    this.node = document.createElement("button");
    this.node.type = "button";
    this.node.className = "news-demo";
    this.node.dataset.demo = name;
    this.node.innerHTML = `<svg viewBox="0 0 240 150" aria-hidden="true" focusable="false">${svg}</svg><span class="news-demo-state" aria-hidden="true">${icon("play")}${icon("pause")}</span>`;
    this.animations = tracks.flatMap(([selector, kind, frames]) =>
      [...this.node.querySelectorAll(selector)].map((target) => target.animate(keyframes(kind, frames), { duration: scene.duration, iterations: Infinity })),
    );
    this.visible = false;
    this.stopped = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (this.stopped) for (const animation of this.animations) animation.currentTime = scene.still * scene.duration;
    this.node.addEventListener("click", () => {
      this.stopped = !this.stopped;
      this.update();
    });
    this.update();
  }

  setVisible(visible) {
    if (visible === this.visible) return;
    this.visible = visible;
    this.update();
  }

  update() {
    const playing = this.visible && !this.stopped;
    for (const animation of this.animations) {
      if (playing) animation.play();
      else animation.pause();
    }
    // Todas no mesmo quadro (pausar e continuar não pode descompassar).
    const time = this.animations[0]?.currentTime;
    if (time != null) for (const animation of this.animations) animation.currentTime = time;
    this.node.classList.toggle("stopped", this.stopped);
    const label = this.stopped ? "Tocar a animação" : "Pausar a animação";
    this.node.setAttribute("aria-label", label);
    this.node.title = label;
  }

  dispose() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }
}
