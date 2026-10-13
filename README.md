# PDF Acrobat

Leitor e editor de PDF para desktop (Windows, macOS e Linux), inspirado no Adobe Acrobat.

![Tela do PDF Acrobat](docs/screenshot.png)

## O que ele faz

| Categoria | Recursos |
|---|---|
| **Ler** | Rolagem contínua, miniaturas das páginas, zoom (inclusive Ctrl + roda do mouse), ajustar à largura ou à página, pesquisa de texto com destaque, seleção e cópia de texto, links, PDFs protegidos por senha |
| **Comentar** | Destacar texto, adicionar texto, desenhar à mão livre, inserir imagem. Tudo é salvo como anotação PDF padrão, visível em qualquer leitor |
| **Preencher e assinar** | Preencher formulários (campos de texto, caixas de seleção etc.) e assinar desenhando ou digitando o nome |
| **Organizar páginas** | Girar, excluir, inserir página em branco, reordenar arrastando as miniaturas, inserir outro PDF ou imagem, extrair páginas para um novo PDF |
| **Criar** | Combinar vários PDFs ou imagens em um só arquivo, ou criar um PDF a partir de imagens (JPG/PNG) |
| **Outros** | Imprimir, propriedades do documento, abrir PDFs com duplo clique (associação de arquivo), arrastar e soltar, aviso de alterações não salvas, tema claro e escuro |

## Como baixar e instalar

Os instaladores são gerados automaticamente pelo GitHub Actions (workflow **Gerar instaladores**):

- **Versão publicada:** na aba **Releases** do repositório, baixe o arquivo do seu sistema. Uma versão nova é publicada sempre que uma tag `v*` é enviada (ex.: `git tag v1.0.0 && git push origin v1.0.0`).
- **Build manual:** na aba **Actions**, abra *Gerar instaladores*, clique em **Run workflow** e, quando terminar, baixe o artefato do seu sistema no fim da página.

| Sistema | Arquivo |
|---|---|
| Windows | `PDF-Acrobat-<versão>-win-x64.exe` (instalador) |
| macOS | `PDF-Acrobat-<versão>-mac-arm64.dmg` (Apple Silicon) ou `-x64.dmg` (Intel) |
| Linux | `.AppImage` (portátil) ou `.deb` (Ubuntu/Debian) |

> Os instaladores não têm assinatura digital paga. Por isso, no **Windows** o SmartScreen pode avisar "O Windows protegeu o computador": clique em *Mais informações* → *Executar assim mesmo*. No **macOS**, na primeira vez, clique com o botão direito no app → *Abrir* (no macOS 15 ou mais novo: *Ajustes do Sistema* → *Privacidade e Segurança* → *Abrir Mesmo Assim*).

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+O | Abrir |
| Ctrl+S / Ctrl+Shift+S | Salvar / Salvar como |
| Ctrl+P | Imprimir |
| Ctrl+F | Localizar (Enter = próximo, Shift+Enter = anterior) |
| Ctrl+D | Propriedades do documento |
| Ctrl + / Ctrl − | Zoom |
| V, H, T, D | Selecionar, Destacar, Texto, Desenhar |
| Esc | Voltar para a ferramenta Selecionar |

No macOS, use Cmd no lugar de Ctrl.

## Tecnologias

A arquitetura segue a do Acrobat moderno: um núcleo que interpreta e desenha o PDF, uma camada de edição de baixo nível e uma interface web rodando dentro do Chromium.

| Camada | No Adobe Acrobat | Neste projeto |
|---|---|---|
| Aplicativo desktop / janela | C++ nativo + Chromium Embedded Framework | **Electron** (Node.js + Chromium) — `electron/` |
| Interface | HTML/CSS/JS em partes da UI | **HTML, CSS e JavaScript** — `index.html`, `src/` |
| Interpretação e renderização do PDF | AGM + CoolType (C++) | **PDF.js** (Mozilla, o mesmo motor do Firefox) |
| Anotações e formulários | Camada PD / AcroForms | Editores de anotação e formulários do **PDF.js** |
| Edição estrutural (páginas, objetos) | Camadas PD / Cos do SDK | **pdf-lib** — `src/pdfops.js` |
| Build e instaladores | — | **Vite** + **electron-builder** |

### Estrutura

```
electron/main.cjs     processo principal: janela, menus, diálogos, abrir/salvar arquivos
electron/preload.cjs  ponte segura entre a interface e o sistema
src/main.js           interface: visualizador, ferramentas, miniaturas, impressão
src/pdfops.js         operações de página com pdf-lib (girar, excluir, mover, combinar...)
src/signature.js      janela de assinatura
src/platform.js       abstrai desktop (Electron) × navegador
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

Algumas funções do Acrobat Pro não estão incluídas: editar o texto original do PDF, OCR (reconhecer texto em documentos escaneados), converter PDF para Word/Excel, comprimir arquivos e assinatura digital com certificado. A assinatura deste app é visual (imagem na página), como o "Preencher e assinar" do Acrobat Reader. Reorganizar páginas não funciona em PDFs criptografados.

## Créditos

Projeto de [@Lucasbrandaocabral](https://github.com/Lucasbrandaocabral), desenvolvido com a ajuda do [Claude Code](https://claude.com/claude-code), o assistente de programação da Anthropic.

## Licença

MIT. Usa [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) e [Electron](https://www.electronjs.org/) (MIT).
