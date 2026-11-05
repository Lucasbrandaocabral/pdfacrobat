# Novidades

O que mudou em cada versão do PDF Acrobat, da mais nova para a mais antiga. A mesma lista aparece no programa (**Ajuda → Novidades**, ou **Novidades** na tela inicial e na janela **Sobre**) e na página de cada versão em [Releases](https://github.com/Lucasbrandaocabral/pdfacrobat/releases).

<!--
Para a próxima versão: escreva no topo uma parte "## " com o número que ela
vai ter (o mesmo da tag, sem o "v") e um item "- " por mudança, começando por
um título curto em **negrito**. Ao publicar a versão, essa parte vai para a
página dela no GitHub e para o aviso de novidades do programa.

Recurso novo com animação: termine o item com um comentário "demo: nome", com
o nome de uma das cenas de src/demos.js (veja os itens da 1.12.0). No programa,
ele vira um cartão com a animação e o botão Experimentar; na página do GitHub,
o comentário não aparece. Correções ficam sem animação.
-->

## 1.13.0

- **Girar objetos e textos**: em **Editar texto e imagens**, a alça redonda embaixo do que está selecionado gira qualquer objeto (imagem, desenho, parágrafo) em volta do meio dele, e os botões ↺ e ↻ da barra giram 90°. Perto de um ângulo reto, ele gruda; com Shift, gira de 15 em 15 graus. Ao escrever ou editar um texto, a mesma alça ao lado da de mover gira as letras, com a fonte escolhida. No celular, é só arrastar a alça com o dedo. <!-- demo: girar -->
- **Novidades com animações**: cada recurso novo aparece num cartão com uma animação curta mostrando como usar e um botão **Experimentar**, que já abre a ferramenta certa (sem documento aberto, pede um PDF antes). Um clique na animação pausa. As correções continuam numa lista simples.

## 1.12.0

- **Mover, copiar e colar objetos**: em **Editar texto e imagens**, como no Acrobat, qualquer objeto da página (parágrafo, imagem, desenho, degradê) pode ser arrastado para outro lugar, também os de dentro dos grupos dos PDFs do Canva. Vários de uma vez com Shift+clique ou arrastando uma área em volta; **Copiar**, **Recortar** e **Colar** (Ctrl+C, Ctrl+X, Ctrl+V) levam para outra página ou para outro documento aberto; Delete exclui e as setas movem aos poucos. O que estava por cima continua por cima. <!-- demo: mover -->
- **Duplicar com Alt**: arrastar um objeto com Alt (ou Ctrl) deixa o original no lugar e cria uma cópia. Editando um texto, arrastar a alça com Alt duplica o texto com a mesma fonte, o mesmo tamanho e as mesmas cores. <!-- demo: duplicar -->
- **No celular**: toque num desenho ou segure o dedo em qualquer objeto para selecionar, toque em outros para juntar e arraste a seleção; segure o dedo numa parte vazia da página para **Colar aqui**. <!-- demo: celular -->
- **Espaço com a fonte original do PDF**: em alguns PDFs (comum com fontes como a Avenir), o espaço digitado ao editar um texto aparecia como um quadrado, na caixa, na lista de fontes e no PDF salvo. Agora ele sai normal.
- **Edições no lugar certo**: em alguns PDFs, um texto, uma assinatura ou uma imagem acrescentados podiam sair deslocados ou em outro tamanho. E muitas edições na mesma página não deixam mais o conteúdo dela cada vez mais aninhado.

## 1.11.0

- **Novidades**: depois de atualizar, o programa avisa e mostra o que mudou. A lista de todas as versões fica em **Ajuda → Novidades**, na tela inicial e na janela **Sobre**.
- **Mais rápido em computador com HD**: editar, desfazer e refazer ficaram mais rápidos (o motor que desenha o PDF não é mais recriado a cada mudança), o programa abre mais leve e, ao abrir vários arquivos de uma vez, lê um de cada vez.
- **Proteção mantida ao editar**: editar um PDF protegido mantém as senhas e as restrições originais, sem perder o título e o autor.
- **Tarjas mais seguras**: o que fica debaixo da tarja não sobra em lugares escondidos do arquivo (formulários, texto de acessibilidade, marcadores), e as páginas que não dá para limpar pedaço por pedaço viram imagem.
- **Salvar com segurança**: no computador, o arquivo novo é gravado inteiro antes de substituir o antigo; edições feitas em sequência não se perdem; o que foi apagado (páginas, textos, imagens) sai mesmo do arquivo.
- **Páginas e imagens**: mover e inserir páginas mantém o tamanho e o giro; extrair e dividir levam só as páginas escolhidas; comprimir não estraga imagens com transparência; fotos do celular entram em pé.
- **Assinatura digital**: aviso antes de assinar de novo um documento que já tem assinatura.
- **Desenho à mão livre**: o traço não se perde ao trocar de ferramenta pelo teclado.
- **Mais seguro no computador e no Android**: o programa só lê e grava os arquivos que você escolheu, as assinaturas salvas no Android não vão para o backup na nuvem e o Electron foi atualizado com uma correção de segurança.
- **Versão web**: sem internet, ela não abre mais uma página de erro guardada por engano.

## 1.10.0

- **Largura da caixa de texto**: alças nas laterais, como no Canva, para mudar a largura ao editar ou adicionar texto. O texto quebra em linhas dentro da caixa e é gravado assim no PDF, inclusive em páginas giradas. <!-- demo: largura -->

## 1.9.0

- **Editar parágrafos inteiros**: um clique numa palavra seleciona o parágrafo todo, como no Acrobat. O texto se reorganiza na caixa enquanto você edita, mantendo o alinhamento (inclusive justificado) e o espaço entre as linhas. <!-- demo: paragrafo -->
- **Linhas inteiras**: a edição junta os pedaços de uma mesma linha, mesmo em PDFs que guardam cada palavra separada.

## 1.8.0

- **Visual novo**: logo, cores da marca, fonte Inter e tela inicial com os atalhos principais, no tema claro e no escuro.
- **Janelas do próprio programa**: salvar ao fechar, avisos e Sobre com a cara do app, no lugar das janelas do sistema.
- **Indicador de processamento** mais leve, também no celular.

## 1.7.0

- **Dividir PDF** numa tela como a do iLovePDF: por intervalos (personalizados, fixos ou no modo inteligente), por páginas ou por tamanho. Excluir várias páginas de uma vez. <!-- demo: dividir -->
- **Recortar páginas**: moldura ajustável, margens em centímetros e corte automático das margens brancas. <!-- demo: recortar -->
- **Tarjar informações**: marque áreas ou pesquise (CPF, CNPJ, e-mail, nomes); o que fica debaixo da tarja sai de verdade do arquivo. <!-- demo: tarjar -->
- **Reparar PDF**: recupera arquivos danificados e diz o que foi consertado. Um PDF com senha continua protegido.

## 1.6.0

- **Impressão**: janela própria, como a do Acrobat, com visualização: tamanho da página, pôster, várias páginas por folha e livreto. No computador, imprime direto na impressora escolhida. <!-- demo: imprimir -->

## 1.5.0

- **Edição de texto refeita**: o texto antigo sai do PDF e o novo entra com a fonte que você quiser, inclusive a original.
- **127 fontes do Google Fonts** para escrever no PDF.
- **Links**: ao editar texto, um link do PDF por cima não abre; o clique é para editar.
- **Celular**: a janela de assinatura não abre o teclado quando o nome já está preenchido.

## 1.4.0

- **App para Android**: APK nas Releases, com Abrir com, Compartilhar, salvar no mesmo arquivo e imprimir.
- **Miniaturas**: mover uma página não deixa mais páginas em branco, e dá para excluir e mover direto na miniatura.
- **Assinatura**: caixa ajustável antes de concluir e prévia exata ao editar imagens.

## 1.3.0

- **Preencher e assinar**, como no Acrobat: assinatura digitada (com estilos de letra), desenhada ou de imagem; assinatura e iniciais salvas; marcas ✓ ✗ ● e a data de hoje. <!-- demo: assinar -->

## 1.2.1

- **Segurança**: Electron atualizado com correções de segurança.

## 1.2.0

- **Atualização automática**: o programa procura versões novas, baixa em segundo plano e instala ao fechar (no macOS, baixa o instalador).
- **Versão web** atualizada a cada mudança, para usar no navegador e no celular.

## 1.1.0

- **Abas** para vários documentos, desfazer e refazer, e arquivos recentes.
- **Painel lateral**: miniaturas, marcadores e lista de comentários.
- **Comentar**: sublinhar, tachar, notas, formas (retângulo, elipse, linha e seta) e carimbos.
- **Editar texto e imagens**: clique no texto para editar; mova, redimensione, troque ou exclua imagens.
- **Marca d'água, cabeçalho, rodapé e numeração de páginas**.
- **Dividir, converter** (em imagens, texto ou Word) e **comprimir**.
- **Proteger com senha** (AES-256) e restrições, e remover a senha.
- **Assinatura digital** com certificado A1 (.pfx ou .p12).
- **OCR**: reconhece o texto de PDFs escaneados (português e inglês), sem internet.
- **Comparar** duas versões de um PDF, com as diferenças destacadas lado a lado.
- **Versão web e celular**, que pode ser instalada como app.

## 1.0.0

- **Primeira versão**: ler PDFs (rolagem contínua, miniaturas, zoom, busca, links e senha), destacar, escrever, desenhar e pôr imagens, preencher formulários e assinar.
- **Páginas**: girar, excluir, inserir, reordenar, extrair e combinar arquivos; criar PDF a partir de imagens e imprimir.
- **Instaladores** para Windows, macOS e Linux.
