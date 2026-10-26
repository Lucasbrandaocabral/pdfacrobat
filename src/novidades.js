// Novidades: o que mudou em cada versão, escrito em NOVIDADES.md (na raiz do
// projeto, o mesmo arquivo que aparece no GitHub e na página de cada versão).
// Depois de uma atualização, o programa avisa uma vez e mostra o que há de novo.
import source from "../NOVIDADES.md?raw";
import { APP_VERSION, isNewer } from "./platform.js";
import { $, el, openDialog } from "./ui.js";

/**
 * As versões do arquivo, da mais nova para a mais antiga: { version, items }.
 * Cada parte começa em "## 1.2.3" (o que vier depois do número, como a data,
 * fica de fora) e cada item numa linha "- ".
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

/**
 * Abre a janela com as novidades de todas as versões. `since`: versão que a
 * pessoa usava antes de atualizar ("" se não se sabe qual era); o que veio
 * depois dela fica marcado.
 */
export function showNews({ since = null } = {}) {
  const dialog = $("#news-dialog");
  const fresh = (version) =>
    since === null ? false : since === "" ? version === APP_VERSION : isNewer(version, since) && !isNewer(version, APP_VERSION);
  const list = $(".news-list", dialog);
  list.replaceChildren(
    ...VERSIONS.map(({ version, items }) =>
      el("section", { class: `news-version${fresh(version) ? " fresh" : ""}` }, [
        el("h3", {}, [`Versão ${version}`, fresh(version) ? el("span", { class: "news-tag", text: "Nesta atualização" }) : null]),
        el("ul", {}, items.map((item) => el("li", {}, inline(item)))),
      ]),
    ),
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
