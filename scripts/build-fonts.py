"""Monta o catálogo de fontes do app a partir do Google Fonts.

Para cada família baixa o subconjunto "latin" (cobre o português) nos pesos
normal (400) e negrito (700, quando existe), converte para TrueType sem
hinting (o formato que o PDF embute; o navegador também usa) e grava:

  public/fonts/<id>-<peso>.ttf   os arquivos
  public/fonts/LICENSES.md       direitos autorais e licença de cada família
  src/fonts.json                 o catálogo lido pelo app

Uso (precisa de internet e de `pip install fonttools brotli`):
  python3 scripts/build-fonts.py
"""

import io
import json
import pathlib
import re
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "fonts"
CATALOG = ROOT / "src" / "fonts.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"

# Família -> categoria. As compatíveis com fontes do Windows/Office vêm com o
# nome da fonte que substituem (usado ao editar textos de PDFs do Word).
FAMILIES = {
    "sans": [
        "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Inter", "Raleway", "Nunito",
        "Nunito Sans", "Ubuntu", "Noto Sans", "PT Sans", "Source Sans 3", "Work Sans", "Rubik",
        "Mulish", "Barlow", "Fira Sans", "Karla", "Josefin Sans", "Archivo", "Quicksand", "Cabin",
        "Titillium Web", "Hind", "Heebo", "Manrope", "DM Sans", "Libre Franklin", "Lexend", "Outfit",
        "Plus Jakarta Sans", "Figtree", "Kanit", "Exo 2", "Oxygen", "Varela Round", "Comfortaa",
        "Maven Pro", "Assistant", "Space Grotesk", "IBM Plex Sans", "Red Hat Display", "Sora",
        "Urbanist", "Arimo", "Carlito",
    ],
    "serif": [
        "Merriweather", "Playfair Display", "Lora", "PT Serif", "Noto Serif", "Roboto Slab",
        "Libre Baskerville", "Crimson Text", "EB Garamond", "Cormorant Garamond", "Bitter", "Arvo",
        "Zilla Slab", "Spectral", "Source Serif 4", "DM Serif Display", "Cinzel", "Old Standard TT",
        "Alegreya", "Vollkorn", "Domine", "Prata", "Tinos", "Caladea", "Gelasio",
    ],
    "display": [
        "Bebas Neue", "Anton", "Oswald", "Lobster", "Righteous", "Abril Fatface", "Alfa Slab One",
        "Fredoka", "Bangers", "Fjalla One", "Archivo Black", "Black Ops One", "Russo One", "Teko",
        "Barlow Condensed", "Orbitron", "Press Start 2P", "Bungee", "Passion One", "Lilita One",
        "Luckiest Guy", "Staatliches", "Chewy",
    ],
    "handwriting": [
        "Dancing Script", "Great Vibes", "Pacifico", "Caveat", "Satisfy", "Shadows Into Light",
        "Indie Flower", "Amatic SC", "Permanent Marker", "Sacramento", "Allura", "Alex Brush",
        "Parisienne", "Kaushan Script", "Yellowtail", "Cookie", "Tangerine", "Homemade Apple",
        "Patrick Hand", "Kalam", "Gloria Hallelujah", "Courgette", "Handlee",
    ],
    "mono": [
        "Roboto Mono", "Source Code Pro", "Space Mono", "IBM Plex Mono", "Inconsolata", "Fira Code",
        "JetBrains Mono", "Courier Prime", "Cousine",
    ],
}

# Fontes comuns em PDFs que não estão no Google Fonts -> a substituta com as
# mesmas medidas (ou a mais parecida).
ALIASES = {
    "arial": "Arimo", "helvetica": "Arimo", "helveticaneue": "Arimo", "liberationsans": "Arimo",
    "timesnewroman": "Tinos", "times": "Tinos", "liberationserif": "Tinos",
    "couriernew": "Cousine", "courier": "Cousine", "liberationmono": "Cousine",
    "calibri": "Carlito", "cambria": "Caladea", "georgia": "Gelasio",
    "segoeui": "Open Sans", "verdana": "Noto Sans", "tahoma": "PT Sans", "trebuchetms": "Fira Sans",
    "garamond": "EB Garamond", "bookantiqua": "Domine", "palatinolinotype": "Domine",
    "centurygothic": "Questrial", "gillsans": "Cabin", "futura": "Josefin Sans",
}


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def latin_woff2(family, weight):
    css_url = f"https://fonts.googleapis.com/css2?family={family.replace(' ', '+')}:wght@{weight}"
    try:
        css = get(css_url).decode()
    except Exception:
        return None
    match = re.search(r"/\* latin \*/\s*@font-face\s*\{[^}]*?src:\s*url\((https://[^)]+)\)", css)
    return get(match.group(1)) if match else None


def set_names(font, family, weight):
    """Nomes da fonte estática. As geradas de fontes variáveis vêm com os nomes
    da instância padrão ("Montserrat Thin" no arquivo do peso 700, por exemplo),
    que aparecem nas propriedades do PDF e confundem quem reconhece a fonte."""
    style = "Bold" if weight == 700 else "Regular"
    postscript = f"{re.sub(r'[^A-Za-z0-9]', '', family)}-{style}"
    names = font["name"]
    for name_id in (16, 17, 21, 22, 25):
        names.removeNames(nameID=name_id)
    names.removeNames(platformID=1)
    full = family if style == "Regular" else f"{family} {style}"
    for name_id, value in ((1, family), (2, style), (3, postscript), (4, full), (6, postscript)):
        names.setName(value, name_id, 3, 1, 0x409)
    font["OS/2"].usWeightClass = weight
    selection = font["OS/2"].fsSelection & ~0b1100001
    font["OS/2"].fsSelection = selection | (1 << 5 if style == "Bold" else 1 << 6)
    font["head"].macStyle = (font["head"].macStyle & ~0b11) | (1 if style == "Bold" else 0)


def to_ttf(data, family, weight):
    """WOFF2 -> TrueType sem hinting, com todos os glifos e recursos tipográficos."""
    font = TTFont(io.BytesIO(data))
    options = subset.Options()
    options.hinting = False
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)
    set_names(font, family, weight)
    font.flavor = None
    out = io.BytesIO()
    font.save(out)
    return out.getvalue(), font


def slug(family):
    return re.sub(r"[^a-z0-9]+", "-", family.lower()).strip("-")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    catalog, licenses, missing = [], [], []
    for category, families in FAMILIES.items():
        for family in families:
            weights, notice = [], None
            for weight in (400, 700):
                data = latin_woff2(family, weight)
                if not data:
                    continue
                ttf, font = to_ttf(data, family, weight)
                (OUT / f"{slug(family)}-{weight}.ttf").write_bytes(ttf)
                weights.append(weight)
                if notice is None:
                    names = font["name"]
                    notice = {
                        "copyright": (names.getDebugName(0) or "").strip(),
                        "license": (names.getDebugName(13) or "").strip().split("\n")[0],
                        "url": (names.getDebugName(14) or "").strip(),
                    }
            if 400 not in weights:
                missing.append(family)
                for weight in weights:
                    (OUT / f"{slug(family)}-{weight}.ttf").unlink()
                continue
            catalog.append({"id": slug(family), "family": family, "category": category, "bold": 700 in weights})
            licenses.append((family, notice))
            print(f"{family}: {weights}", file=sys.stderr)
    aliases = {alias: slug(target) for alias, target in ALIASES.items() if any(f["family"] == target for f in catalog)}
    CATALOG.write_text(json.dumps({"fonts": catalog, "aliases": aliases}, ensure_ascii=False, indent=1) + "\n")
    lines = [
        "# Fontes incluídas",
        "",
        "Fontes do [Google Fonts](https://fonts.google.com), redistribuídas conforme as licenças abaixo",
        "(SIL Open Font License 1.1, Apache 2.0 ou Ubuntu Font Licence). Apenas o subconjunto latino,",
        "convertido para TrueType sem hinting por `scripts/build-fonts.py`.",
        "",
    ]
    for family, notice in licenses:
        lines.append(f"- **{family}** — {notice['copyright']} {notice['license']} {notice['url']}".rstrip())
    (OUT / "LICENSES.md").write_text("\n".join(lines) + "\n")
    total = sum(p.stat().st_size for p in OUT.glob("*.ttf"))
    print(f"{len(catalog)} famílias, {total / 1e6:.1f} MB; sem o peso normal: {missing}", file=sys.stderr)


if __name__ == "__main__":
    main()
