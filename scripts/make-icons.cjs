// Gera o logo e todos os ícones do app a partir do desenho abaixo: o do app de
// computador (build/icon.png), os da versão web (public/icons) e os do Android
// (mipmaps, com o ícone adaptativo e o monocromático).
//
// Uso: npx electron scripts/make-icons.cjs
// (no Linux sem tela: xvfb-run -a npx electron scripts/make-icons.cjs)
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Degradê da marca: coral → rubi → vinho.
const gradient = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF7452"/><stop offset=".52" stop-color="#E5254B"/><stop offset="1" stop-color="#A3123C"/></linearGradient>`;

// Duas páginas: a da frente com o canto dobrado e as linhas de texto; a de trás,
// inclinada e translúcida, dá a ideia de movimento (a "acrobacia").
const BACK = '<path d="M162 112h140l78 78v210a18 18 0 0 1-18 18H162a18 18 0 0 1-18-18V130a18 18 0 0 1 18-18z"/>';
const FRONT = '<path d="M170 104h140l84 84v226a18 18 0 0 1-18 18H170a18 18 0 0 1-18-18V122a18 18 0 0 1 18-18z"/>';
const FOLD = '<path d="M310 104l84 84h-66a18 18 0 0 1-18-18z"/>';
const LINES = [
  '<rect x="196" y="236" width="164" height="22" rx="11"/>',
  '<rect x="196" y="284" width="164" height="22" rx="11"/>',
  '<rect x="196" y="332" width="104" height="22" rx="11"/>',
];

const pages = (scale = 1) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -262)">
    <g transform="rotate(-13 256 268)" fill="#fff" opacity=".32">${BACK}</g>
    <g transform="rotate(5 256 268)">
      <g fill="#fff">${FRONT}</g>
      <g fill="#FFC4B5">${FOLD}</g>
      <g fill="#E5254B">${LINES[0]}<g opacity=".5">${LINES[1]}${LINES[2]}</g></g>
    </g>
  </g>`;

// Só a silhueta (ícone monocromático do Android 13+): as linhas ficam vazadas.
const silhouette = (scale) => `
  <defs><mask id="m"><rect width="512" height="512" fill="#fff"/><g transform="translate(256 256) scale(${scale}) translate(-256 -262)"><g transform="rotate(5 256 268)" fill="#000">${LINES.join("")}</g></g></mask></defs>
  <g mask="url(#m)">
    <g transform="translate(256 256) scale(${scale}) translate(-256 -262)">
      <g transform="rotate(-13 256 268)" fill="#fff" opacity=".45">${BACK}</g>
      <g transform="rotate(5 256 268)" fill="#fff">${FRONT}</g>
    </g>
  </g>`;

const svg = (body, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>${defs}</defs>${body}</svg>`;

const ART = {
  // Ícone com o fundo arredondado (computador, web, Android antigo).
  tile: svg(`<rect x="24" y="24" width="464" height="464" rx="112" fill="url(#g)"/>${pages(1)}`, gradient("g")),
  // Fundo inteiro (web "maskable"): o desenho fica dentro da área segura.
  full: svg(`<rect width="512" height="512" fill="url(#g)"/>${pages(0.78)}`, gradient("g")),
  // Redondo (Android antigo).
  round: svg(`<circle cx="256" cy="256" r="236" fill="url(#g)"/>${pages(0.8)}`, gradient("g")),
  // Ícone adaptativo do Android: fundo e primeiro plano separados.
  background: svg(`<rect width="512" height="512" fill="url(#g)"/>`, gradient("g")),
  foreground: svg(pages(0.62)),
  monochrome: svg(silhouette(0.62)),
};

const ANDROID = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const OUTPUTS = [
  ["build/icon.png", "tile", 1024],
  ["public/icons/icon-192.png", "tile", 192],
  ["public/icons/icon-512.png", "tile", 512],
  ["public/icons/icon-maskable-192.png", "full", 192],
  ["public/icons/icon-maskable-512.png", "full", 512],
  ...Object.entries(ANDROID).flatMap(([density, k]) => [
    [`android/app/src/main/res/mipmap-${density}/ic_launcher.png`, "tile", 48 * k],
    [`android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, "round", 48 * k],
    [`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, "foreground", 108 * k],
    [`android/app/src/main/res/mipmap-${density}/ic_launcher_background.png`, "background", 108 * k],
    [`android/app/src/main/res/mipmap-${density}/ic_launcher_monochrome.png`, "monochrome", 108 * k],
  ]),
];

async function render(win, art, size) {
  const url = `data:image/svg+xml;base64,${Buffer.from(art).toString("base64")}`;
  const data = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = ${size};
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("SVG inválido"));
      img.src = ${JSON.stringify(url)};
    })`);
  return Buffer.from(data.split(",")[1], "base64");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL("data:text/html,<body></body>");
  for (const [file, art, size] of OUTPUTS) {
    const target = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await render(win, ART[art], Math.round(size)));
    console.log(`${file} (${Math.round(size)}px)`);
  }
  // O logo em SVG, para a interface e o favicon.
  fs.writeFileSync(path.join(ROOT, "public/icons/logo.svg"), `${ART.tile}\n`);
  console.log("public/icons/logo.svg");
  app.quit();
});
