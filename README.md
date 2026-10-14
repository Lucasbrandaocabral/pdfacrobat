# PDF Acrobat

Leitor e editor de PDF para Windows, macOS, Linux, navegador e celular, inspirado no Adobe Acrobat.

![Tela do PDF Acrobat](docs/screenshot.png)

## O que ele faz

| Categoria | Recursos |
|---|---|
| **Ler** | Vários documentos em abas, miniaturas, marcadores (sumário) do PDF, zoom (inclusive Ctrl + roda do mouse), pesquisa com destaque, seleção e cópia de texto, links, PDFs com senha |
| **Comentar e revisar** | Destacar, sublinhar e tachar texto; notas adesivas; caixas de texto; desenho à mão livre; retângulo, elipse, linha e seta; carimbos (Aprovado, Reprovado, Confidencial, Rascunho, Recebido, Revisado, Pago); painel com todos os comentários para ir até cada um, editar ou excluir |
| **Editar** | Editar o texto do PDF clicando na linha: o texto antigo sai de verdade da página (sem caixa por cima, mesmo sobre fotos e fundos coloridos) e o novo fica no mesmo lugar, com a fonte original quando ela tem as letras; trocar a fonte, o tamanho, a cor, negrito e itálico, apagar a linha ou arrastá-la para outro lugar; adicionar texto com qualquer uma das 127 fontes do Google Fonts que vêm com o app (pesquisa por nome e por categoria); mover, redimensionar, substituir e excluir imagens, vendo como fica antes de concluir; adicionar imagens; marca d'água; cabeçalho, rodapé e numeração de páginas |
| **Preencher e assinar** | Preencher os campos de formulários; pôr texto (com a fonte que quiser), ✓, ✗, ● e a data de hoje em qualquer ponto da página; assinar digitando o nome (4 estilos de letra manuscrita), desenhando com o mouse, a caneta ou o dedo, ou com a foto da assinatura feita no papel (o fundo branco é removido); antes de concluir, dá para arrastar a assinatura e mudar o tamanho dela pelos cantos (ou com as setas do teclado), já vendo como vai ficar; iniciais; a assinatura e as iniciais ficam salvas no aparelho para usar de novo; assinatura digital com certificado A1 (.pfx/.p12, como e-CPF e e-CNPJ) |
| **Páginas** | Girar, excluir, inserir em branco e reordenar, pelos botões de cada miniatura (subir, descer, girar, excluir) ou arrastando as miniaturas; inserir outros PDFs ou imagens, extrair páginas e dividir em vários arquivos |
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
| Android | `PDF-Acrobat-<versão>-android.apk` |

Requer Windows 10 ou 11 (64 bits), macOS 13 ou mais novo, Linux de 64 bits ou Android 7 ou mais novo.

> Os instaladores não têm assinatura digital paga. Por isso, no **Windows** o SmartScreen pode avisar "O Windows protegeu o computador": clique em *Mais informações* → *Executar assim mesmo*. No **macOS**, na primeira vez, clique com o botão direito no app → *Abrir* (no macOS 15 ou mais novo: *Ajustes do Sistema* → *Privacidade e Segurança* → *Abrir Mesmo Assim*).

### Atualizações automáticas

A partir da versão 1.2.0 o programa se atualiza sozinho, sem precisar entrar no GitHub. Ele procura uma versão nova ao abrir e a cada 6 horas; para procurar na hora, use **Ajuda → Verificar atualizações…**.

| Sistema | Como atualiza |
|---|---|
| Windows e Linux (AppImage) | Baixa a versão nova em segundo plano (quando possível, só as partes que mudaram) e avisa quando ela está pronta. Ela é instalada ao fechar o programa, ou na hora, pelo botão **Reiniciar e atualizar**. |
| Linux (.deb) | Igual, mas a instalação pede a senha de administrador e só acontece pelo botão **Reiniciar e atualizar**. |
| macOS | Avisa que há versão nova; o botão **Baixar** baixa e abre o instalador, e basta arrastar o app para a pasta Aplicativos. Sem o certificado pago da Apple, o macOS não permite que o app se substitua sozinho. |

Antes de reiniciar, o programa pede para salvar os documentos com alterações. Quem usa a versão 1.1.0 ou anterior precisa instalar a 1.2.0 manualmente uma vez; daí em diante as atualizações chegam sozinhas.

### Android

1. No celular, abra a última versão em **Releases** e toque em `PDF-Acrobat-<versão>-android.apk`.
2. Ao abrir o arquivo baixado, o Android pede para permitir que o navegador (ou o app de arquivos) instale apps: toque em **Configurações**, ative **Permitir desta fonte** e volte para **Instalar**.

Com o app instalado:

- **Abrir com** e **Compartilhar**: PDFs do WhatsApp, do e-mail ou do gerenciador de arquivos abrem direto no PDF Acrobat.
- **Salvar** abre o seletor de arquivos do Android (Downloads, Documentos, Google Drive...) e depois grava no mesmo arquivo; vários arquivos de uma vez vão para a pasta escolhida.
- **Imprimir** usa o serviço de impressão do Android, que também salva como PDF.
- Quando sai uma versão nova, o app avisa e o botão **Baixar** abre o download no navegador; é só tocar no arquivo baixado para instalar por cima, sem perder as assinaturas salvas.

O APK é gerado pelo mesmo workflow e assinado sempre com a mesma chave, que fica nos *secrets* do repositório (**Settings → Secrets and variables → Actions**): `ANDROID_KEYSTORE_BASE64` (o arquivo da chave em base64) e `ANDROID_KEYSTORE_PASSWORD`. Guarde uma cópia do arquivo da chave: sem ela, uma versão nova não instala por cima da antiga. Sem os secrets, o workflow gera só um APK de teste (*Artifacts* → `apk-de-teste`), que não entra nas versões publicadas.

### Publicar uma versão nova

1. Abra **Releases** → **Draft a new release**.
2. Em **Tag: Select tag**, digite a versão nova, maior que a anterior (ex.: `v1.3.0` ou `1.3.0`), e escolha **Create new tag**.
3. Clique em **Publish release**.

Em poucos minutos os instaladores e o APK aparecem anexados à versão (workflow **Gerar instaladores**), e os programas já instalados passam a se atualizar para ela. O número da versão do app vem da tag; não é preciso mudar o `package.json`. Uma versão marcada como **Set as a pre-release** não é oferecida como atualização, o que serve para testar antes.

Todo envio de código também gera os instaladores como *Artifacts* na aba **Actions** (vêm em `.zip`), útil para testar antes de publicar.

## Versão web e celular

A mesma interface roda no navegador, no computador ou no celular, em **https://lucasbrandaocabral.github.io/pdfacrobat/**. No celular, use **Adicionar à tela inicial** para instalar como app. Depois da primeira visita ela funciona sem internet.

Ela é atualizada automaticamente a cada envio de código para o branch principal (workflow **Publicar versão web**). Para ativar o endereço (uma vez só): **Settings → Pages → Source: GitHub Actions**.

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
| Delete / Alt+↑ / Alt+↓ (numa miniatura) | Excluir / mover a página |
| V, H, U, K, N, T, D, E | Selecionar, Destacar, Sublinhar, Tachar, Nota, Texto, Desenhar, Editar texto e imagens (T em Editar e em Preencher e assinar escreve na página; em Comentar, cria uma caixa de texto) |
| Enter / Shift+Enter (editando uma linha) | Concluir / quebrar a linha |
| Ctrl+Enter (texto novo) | Concluir (Enter quebra a linha) |
| Ctrl+B / Ctrl+I (no texto) | Negrito / itálico |
| Esc | Cancelar a edição aberta; sem edição, voltar para a ferramenta Selecionar |

No macOS, use Cmd no lugar de Ctrl.

## Tecnologias

A arquitetura segue a do Acrobat moderno: um núcleo que interpreta e desenha o PDF, uma camada de edição de baixo nível e uma interface web rodando dentro do Chromium.

| Camada | No Adobe Acrobat | Neste projeto |
|---|---|---|
| Aplicativo desktop / janela | C++ nativo + Chromium Embedded Framework | **Electron** (Node.js + Chromium) — `electron/` |
| App Android | App nativo | **Capacitor** (a mesma interface num WebView) — `android/` |
| Interface | HTML/CSS/JS em partes da UI | **HTML, CSS e JavaScript** — `index.html`, `src/` |
| Interpretação e renderização do PDF | AGM + CoolType (C++) | **PDF.js** (Mozilla, o mesmo motor do Firefox) |
| Edição estrutural, anotações e criptografia | Camadas PD / Cos do SDK | **pdf-lib** (versão `@cantoo/pdf-lib`, com AES-256) — `src/pdf/` |
| OCR | Adobe Sensei | **Tesseract** (WebAssembly) |
| Assinatura digital | PKI própria | **@signpdf** + **node-forge** (PKCS#7) |
| Fontes | CoolType | **fontkit** (embute no PDF só as letras usadas) e 127 famílias do Google Fonts — `public/fonts/` |
| Conversão para Word | Serviço na nuvem | **docx** |
| Atualização automática | Adobe Updater (ARM) | **electron-updater**, a partir das Releases do GitHub — `electron/updater.cjs` |
| Build, instaladores e web | — | **Vite**, **electron-builder**, **Gradle**, GitHub Actions e GitHub Pages |

### Estrutura

```
electron/main.cjs        processo principal: janela, menus, diálogos, abrir/salvar arquivos
electron/preload.cjs     ponte segura entre a interface e o sistema
electron/updater.cjs     atualização automática (procura, baixa e instala versões novas)
android/                 app Android (Capacitor); NativeFilesPlugin.java: salvar, abrir com, imprimir
src/android.js           só no Android: botão voltar do sistema
src/main.js              inicialização, ações, atalhos, arrastar e soltar, recentes
src/tabs.js              abas (um visualizador do PDF.js por documento), desfazer/refazer, permissões
src/tools.js             ferramentas na página: comentar, formas, carimbos, assinar, editar texto e imagens
src/sidebar.js           miniaturas, marcadores e lista de comentários
src/updates.js           aviso de atualização (desktop e Android)
src/signature.js         criar assinatura e iniciais (digitar, desenhar, imagem) e as salvas
src/fonts.js             catálogo de fontes: carregar na tela, embutir no PDF, reconhecer a fonte de um PDF
src/fontpicker.js        lista de fontes com pesquisa e categorias
src/features/            janelas e fluxos: documento, converter, OCR, comparar, certificado
src/pdf/                 operações no arquivo: anotações, conteúdo da página, marcas, segurança, compressão
src/pdf/textops.js       lê os comandos de texto da página (e dos formulários internos) e apaga uma linha
src/pdf/textedit.js      linhas editáveis, escrever texto novo com a fonte do catálogo ou a original
public/                  manifesto e service worker da versão web; public/fonts: as fontes e suas licenças
scripts/build-fonts.py   baixa as fontes do Google Fonts e monta o catálogo
```

## Desenvolvimento

Requer Node.js 22 ou superior.

```bash
npm install
npm run dev          # interface no navegador (http://localhost:5173)
npm start            # app desktop
npm run dist         # gera o instalador do sistema atual em release/
npm run dist:win     # ou :mac / :linux
npm run android      # copia a interface para o app Android (android/)
python3 scripts/build-fonts.py   # refaz o catálogo de fontes (precisa de internet e de pip install fonttools brotli)
cd android && ./gradlew assembleDebug   # APK de teste (precisa do JDK 21 e do Android SDK)
```

## Limitações

- **Editar texto:** a edição é por linha (um parágrafo não se reorganiza sozinho, e uma linha justificada fica com o espaçamento normal). Letras que a fonte original do PDF não tem saem com a fonte parecida do catálogo. Texto que faz parte de uma imagem (documento escaneado) é coberto com a cor do fundo; use antes o OCR. Texto transformado em desenho (curvas) não é editável como texto.
- **Word:** a conversão leva o texto em parágrafos, sem o layout original (colunas, tabelas e imagens).
- **Assinatura digital:** só certificados A1 (arquivo). Certificados A3 (token ou cartão) não são suportados.
- **Comparar:** compara o texto; mudanças só em imagens não aparecem.
- **Restrições de senha** são respeitadas por leitores como o Acrobat, mas não impedem totalmente que alguém determinado copie o conteúdo.

## Créditos

Projeto de [@Lucasbrandaocabral](https://github.com/Lucasbrandaocabral), desenvolvido com a ajuda do [Claude Code](https://claude.com/claude-code), o assistente de programação da Anthropic.

## Licença

MIT. Usa [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (MIT), [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), [signpdf](https://github.com/vbuch/node-signpdf) (MIT), [node-forge](https://github.com/digitalbazaar/forge) (BSD/GPL), [docx](https://github.com/dolanmiu/docx) (MIT), [jsdiff](https://github.com/kpdecker/jsdiff) (BSD), [fflate](https://github.com/101arrowz/fflate) (MIT), [Electron](https://www.electronjs.org/) (MIT), [Capacitor](https://capacitorjs.com/) (MIT) e [electron-updater](https://github.com/electron-userland/electron-builder) (MIT). Fontes da assinatura digitada: [Dancing Script](https://fonts.google.com/specimen/Dancing+Script), [Great Vibes](https://fonts.google.com/specimen/Great+Vibes) e [Caveat](https://fonts.google.com/specimen/Caveat) (OFL) e [Homemade Apple](https://fonts.google.com/specimen/Homemade+Apple) (Apache-2.0). Fontes do editor de texto: 127 famílias do [Google Fonts](https://fonts.google.com) (SIL Open Font License 1.1, Apache 2.0 e Ubuntu Font Licence), com os direitos autorais e a licença de cada uma em [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md); leitura e embutimento com [fontkit](https://github.com/cantoo-scribe/fontkit) (MIT).
