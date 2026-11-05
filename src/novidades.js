// Novidades: o que mudou em cada versão, escrito em NOVIDADES.md (na raiz do
// projeto, o mesmo arquivo que aparece no GitHub e na página de cada versão).
// Depois de uma atualização, o programa avisa uma vez e mostra o que há de novo.
// Os recursos com animação (o comentário "demo: nome" no fim do item) viram
// cartões com a cena de src/demos.js e o botão Experimentar; o resto (as
// correções) fica numa lista simples.
import source from "../NOVIDADES.md?raw";
import { Demo, hasDemo } from "./demos.js";
import { icon } from "./icons.js";
import { APP_VERSION, isNewer } from "./platform.js";
import { $, el, openDialog } from "./ui.js";

const DEMO_MARK = /\s*<!--\s*demo:\s*([\w-]+)\s*-->/;

/**
 * As versões do arquivo, da mais nova para a mais antiga: { version, items },
 * cada item { text, demo }. Cada parte começa em "## 1.2.3" (o que vier
 * depois do número, como a data, fica de fora) e cada item numa linha "- ".
 */
function parseNews(text) {
  const versions = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+v?(\d+\.\d+\.\d+)(?![\d.])/.exec(line);
    if (heading) {
      current = { version: heading[1], items: [] };
      versions.push(current);
    } else if (line.startsWith("#")) {
      current = null;
    } else if (current && line.startsWith("- ")) {
      current.items.push(line.slice(2));
    } else if (current && line && current.items.length) {
      // Item que continua na linha de baixo.
      current.items[current.items.length - 1] += ` ${line}`;
    }
  }
  for (const version of versions) {
    version.items = version.items.map((item) => ({ text: item.replace(DEMO_MARK, "").trim(), demo: DEMO_MARK.exec(item)?.[1] ?? null }));
  }
  return versions;
}

const VERSIONS = parseNews(source);

/** O texto de um item, com **negrito** e `código` (o resto entra como texto, nunca como HTML). */
function inline(text) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return el("strong", { text: part.slice(2, -2) });
      if (/^`[^`]+`$/.test(part)) return el("code", { text: part.slice(1, -1) });
      return part;
    });
}

/** "**Título**: o resto" → título e texto (com a primeira letra maiúscula). */
function splitTitle(text) {
  const match = /^\*\*([^*]+)\*\*[\s,:;.]*/.exec(text);
  if (!match) return { title: null, body: text };
  return { title: match[1], body: text.slice(match[0].length).replace(/\p{L}/u, (c) => c.toUpperCase()) };
}

/** Cartão de um recurso: a animação, o título, o texto e o botão Experimentar. */
function featureCard({ text, demo: name }, demos, tryIt) {
  const demo = new Demo(name);
  demos.push(demo);
  const { title, body } = splitTitle(text);
  const action = tryIt && demo.experimentar;
  return el("article", { class: "news-feature" }, [
    demo.node,
    el("div", { class: "news-feature-text" }, [
      title ? el("h4", { text: title }) : null,
      el("p", {}, inline(body)),
      action
        ? el("button", {
            type: "button",
            class: "btn news-try",
            html: `${icon("sparkle")}<span>Experimentar</span>`,
            onclick: () => tryIt(action),
          })
        : null,
    ]),
  ]);
}

/**
 * Abre a janela com as novidades de todas as versões. `since`: versão que a
 * pessoa usava antes de atualizar ("" se não se sabe qual era); o que veio
 * depois dela fica marcado. `onTry(experimentar)` abre o recurso de um
 * cartão (o botão Experimentar fecha a janela antes).
 */
export function showNews({ since = null, onTry = null } = {}) {
  const dialog = $("#news-dialog");
  // Já aberta (ex.: Ajuda → Novidades de novo, no menu do computador): fica como está.
  if (dialog.open) return Promise.resolve(false);
  const fresh = (version) =>
    since === null ? false : since === "" ? version === APP_VERSION : isNewer(version, since) && !isNewer(version, APP_VERSION);
  const list = $(".news-list", dialog);
  const demos = [];
  const tryIt = onTry
    ? (action) => {
        dialog.close();
        onTry(action);
      }
    : null;
  list.replaceChildren(
    ...VERSIONS.map(({ version, items }) => {
      const features = items.filter((item) => hasDemo(item.demo));
      const others = items.filter((item) => !hasDemo(item.demo));
      return el("section", { class: `news-version${fresh(version) ? " fresh" : ""}` }, [
        el("h3", {}, [`Versão ${version}`, fresh(version) ? el("span", { class: "news-tag", text: "Nesta atualização" }) : null]),
        features.length ? el("div", { class: "news-features" }, features.map((item) => featureCard(item, demos, tryIt))) : null,
        others.length ? el("ul", {}, others.map((item) => el("li", {}, inline(item.text)))) : null,
      ]);
    }),
  );
  // As animações só tocam enquanto aparecem na lista, e param de vez ao fechar.
  const byNode = new Map(demos.map((demo) => [demo.node, demo]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) byNode.get(entry.target)?.setVisible(entry.isIntersecting);
    },
    { root: list },
  );
  for (const demo of demos) observer.observe(demo.node);
  dialog.addEventListener(
    "close",
    () => {
      observer.disconnect();
      for (const demo of demos) demo.dispose();
    },
    { once: true },
  );
  const closed = openDialog(dialog, { focus: ".news-ok" });
  // Começa na primeira versão marcada (ou no topo), com a janela já aberta.
  const first = list.querySelector(".fresh");
  list.scrollTop = first ? first.offsetTop - list.offsetTop : 0;
  return closed;
}

const SEEN_KEY = "versaoVista";
// Preferências que só existem para quem já usou o programa.
const USED_KEYS = [
  "recentFiles",
  "sidebar",
  "authorName",
  "savedSignature",
  "savedInitials",
  "signaturePrefs",
  "texto-novo",
  "fontes-recentes",
  "impressao",
  "dividir",
];

/**
 * Se o programa acabou de ser atualizado, a versão usada antes ("" quando não
 * se sabe qual era); senão null (primeira vez ou nada mudou). Guarda a versão
 * atual, para avisar uma vez só.
 */
export function updatedFrom() {
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen !== APP_VERSION) localStorage.setItem(SEEN_KEY, APP_VERSION);
    if (seen) return isNewer(APP_VERSION, seen) ? seen : null;
    // Primeira vez com este aviso: quem já tinha preferências guardadas veio de uma versão anterior.
    return USED_KEYS.some((key) => localStorage.getItem(key) !== null) ? "" : null;
  } catch {
    // Sem armazenamento não dá para comparar.
    return null;
  }
}
