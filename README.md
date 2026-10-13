# PDF Acrobat

Leitor e editor de PDF para Windows, macOS, Linux, navegador e celular, inspirado no Adobe Acrobat.

![Tela do PDF Acrobat](docs/screenshot.png)

## O que ele faz

| Categoria | Recursos |
|---|---|
| **Ler** | Vários documentos em abas, miniaturas, marcadores (sumário) do PDF, zoom (inclusive Ctrl + roda do mouse), pesquisa com destaque, seleção e cópia de texto, links, PDFs com senha |
| **Comentar e revisar** | Destacar, sublinhar e tachar texto; notas adesivas; caixas de texto; desenho à mão livre; retângulo, elipse, linha e seta; carimbos (Aprovado, Reprovado, Confidencial, Rascunho, Recebido, Revisado, Pago); painel com todos os comentários para ir até cada um, editar ou excluir |
| **Editar** | Corrigir textos do PDF clicando neles; mover, redimensionar, substituir e excluir imagens; adicionar texto e imagens; marca d'água; cabeçalho, rodapé e numeração de páginas |
| **Preencher e assinar** | Preencher formulários; assinar desenhando ou digitando o nome; assinatura digital com certificado A1 (.pfx/.p12, como e-CPF e e-CNPJ) |
| **Páginas** | Girar, excluir, inserir em branco, reordenar arrastando as miniaturas, inserir outros PDFs ou imagens, extrair páginas e dividir em vários arquivos |
| **Proteger** | Senha para abrir (AES-256) e restrições de impressão, edição e cópia; remover senha; respeita as restrições de PDFs protegidos (pede a senha de permissões) |
| **Converter** | Para imagens (PNG/JPG), texto (.txt) e Word (.docx); comprimir o PDF; reconhecer texto em páginas escaneadas (OCR, em português e inglês, sem internet); comparar duas versões, com as diferenças destacadas |
| **Criar** | Combinar vários PDFs e imagens num arquivo só, ou criar um PDF a partir de imagens |
| **Outros** | Desfazer e refazer, imprimir, propriedades do documento, arquivos recentes, abrir PDFs com duplo clique, arrastar e soltar, tema claro e escuro |

Os comentários, carimbos e formas são gravados como anotações PDF padrão e aparecem em qualquer leitor. Os documentos nunca saem do seu computador ou celular: tudo, inclusive o OCR, roda localmente.

## Como baixar e instalar

Os instaladores ficam na aba **Releases** do repositório. Baixe o arquivo do seu sistema:

| Sistema | Arquivo |
|---|---|
| Windows | `PDF-Acrobat-<versão>-win-x64.exe` (instalador) |
| macOS | `PDF-Acrobat-<versão>-mac-arm64.dmg` (Apple Silicon) ou `-x64.dmg` (Intel) |
| Linux | `.AppImage` (portátil) ou `.deb` (Ubuntu/Debian) |

> Os instaladores não têm assinatura digital paga. Por isso, no **Windows** o SmartScreen pode avisar "O Windows protegeu o computador": clique em *Mais informações* → *Executar assim mesmo*. No **macOS**, na primeira vez, clique com o botão direito no app → *Abrir* (no macOS 15 ou mais novo: *Ajustes do Sistema* → *Privacidade e Segurança* → *Abrir Mesmo Assim*).

### Publicar uma versão nova

1. Abra **Releases** → **Draft a new release**.
2. Em **Tag: Select tag**, digite a versão (ex.: `v1.1.0`) e escolha **Create new tag**.
3. Clique em **Publish release**.

Em poucos minutos os instaladores aparecem anexados à versão (workflow **Gerar instaladores**) e a versão web é atualizada (workflow **Publicar versão web**).

Todo envio de código também gera os instaladores como *Artifacts* na aba **Actions** (vêm em `.zip`), útil para testar antes de publicar.

## Versão web e celular

A mesma interface roda no navegador, no computador ou no celular, em **https://lucasbrandaocabral.github.io/pdfacrobat/**. No celular, use **Adicionar à tela inicial** para instalar como app. Depois da primeira visita ela funciona sem internet.

Para ativar o endereço (uma vez só): **Settings → Pages → Source: GitHub Actions**. Depois publique uma versão ou rode o workflow **Publicar versão web** (aba **Actions** → **Run workflow**).

Na versão web os arquivos são abertos e baixados pelo navegador (vários arquivos de uma vez vêm num `.zip`). Para usar arquivos da nuvem, abra-os a partir das pastas sincronizadas do OneDrive, Google Drive ou Dropbox.

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+O | Abrir |
| Ctrl+S / Ctrl+Shift+S | Salvar / Salvar como |
| Ctrl+W | Fechar documento |
| Ctrl+Tab / Ctrl+Shift+Tab | Próximo / anterior documento |
| Ctrl+Z / Ctrl+Y | Desfazer / refazer |
| Ctrl+P | Imprimir |
| Ctrl+F | Localizar (Enter = próximo, Shift+Enter = anterior) |
| Ctrl+D | Propriedades do documento |
| Ctrl + / Ctrl − | Zoom |
| F4 | Painel lateral |
| V, H, U, K, N, T, D, E | Selecionar, Destacar, Sublinhar, Tachar, Nota, Texto, Desenhar, Editar texto e imagens |
| Esc | Voltar para a ferramenta Selecionar |

No macOS, use Cmd no lugar de Ctrl.

## Tecnologias

A arquitetura segue a do Acrobat moderno: um núcleo que interpreta e desenha o PDF, uma camada de edição de baixo nível e uma interface web rodando dentro do Chromium.

| Camada | No Adobe Acrobat | Neste projeto |
|---|---|---|
| Aplicativo desktop / janela | C++ nativo + Chromium Embedded Framework | **Electron** (Node.js + Chromium) — `electron/` |
| Interface | HTML/CSS/JS em partes da UI | **HTML, CSS e JavaScript** — `index.html`, `src/` |
| Interpretação e renderização do PDF | AGM + CoolType (C++) | **PDF.js** (Mozilla, o mesmo motor do Firefox) |
| Edição estrutural, anotações e criptografia | Camadas PD / Cos do SDK | **pdf-lib** (versão `@cantoo/pdf-lib`, com AES-256) — `src/pdf/` |
| OCR | Adobe Sensei | **Tesseract** (WebAssembly) |
| Assinatura digital | PKI própria | **@signpdf** + **node-forge** (PKCS#7) |
| Conversão para Word | Serviço na nuvem | **docx** |
| Build, instaladores e web | — | **Vite**, **electron-builder**, GitHub Actions e GitHub Pages |

### Estrutura

```
electron/main.cjs        processo principal: janela, menus, diálogos, abrir/salvar arquivos
electron/preload.cjs     ponte segura entre a interface e o sistema
src/main.js              inicialização, ações, atalhos, arrastar e soltar, recentes
src/tabs.js              abas (um visualizador do PDF.js por documento), desfazer/refazer, permissões
src/tools.js             ferramentas na página: comentar, formas, carimbos, assinar, editar texto e imagens
src/sidebar.js           miniaturas, marcadores e lista de comentários
src/features/            janelas e fluxos: documento, converter, OCR, comparar, certificado
src/pdf/                 operações no arquivo: anotações, conteúdo da página, marcas, segurança, compressão
public/                  manifesto e service worker da versão web
```

## Desenvolvimento

Requer Node.js 20 ou superior.

```bash
npm install
npm run dev          # interface no navegador (http://localhost:5173)
npm start            # app desktop
npm run dist         # gera o instalador do sistema atual em release/
npm run dist:win     # ou :mac / :linux
```

## Limitações

- **Editar texto:** o trecho original é coberto e o novo texto é escrito por cima, no mesmo lugar, com uma fonte padrão parecida (Helvetica, Times ou Courier). Funciona bem para correções; textos com fontes especiais podem mudar um pouco de aparência.
- **Word:** a conversão leva o texto em parágrafos, sem o layout original (colunas, tabelas e imagens).
- **Assinatura digital:** só certificados A1 (arquivo). Certificados A3 (token ou cartão) não são suportados.
- **Comparar:** compara o texto; mudanças só em imagens não aparecem.
- **Restrições de senha** são respeitadas por leitores como o Acrobat, mas não impedem totalmente que alguém determinado copie o conteúdo.

## Créditos

Projeto de [@Lucasbrandaocabral](https://github.com/Lucasbrandaocabral), desenvolvido com a ajuda do [Claude Code](https://claude.com/claude-code), o assistente de programação da Anthropic.

## Licença

MIT. Usa [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (MIT), [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), [signpdf](https://github.com/vbuch/node-signpdf) (MIT), [node-forge](https://github.com/digitalbazaar/forge) (BSD/GPL), [docx](https://github.com/dolanmiu/docx) (MIT), [jsdiff](https://github.com/kpdecker/jsdiff) (BSD), [fflate](https://github.com/101arrowz/fflate) (MIT) e [Electron](https://www.electronjs.org/) (MIT).
