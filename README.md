# CorteSeco Studio

Editor de vídeo multitrack em HTML/CSS/JS puro. Roda como app desktop (Electron) e pode ser publicado como site.
Codificação e decodificação via [Mediabunny](https://mediabunny.dev/) (WebCodecs) + encoders WASM de AAC e MP3.

## Comandos

```bash
npm install
npm run dev         # app desktop com recarregamento (Vite na porta 5199 + Electron)
npm start           # build + abre o app desktop
npm run dist:appimage  # gera só o AppImage em release/
npm run dist:linux  # gera AppImage e .deb em release/
npm run dist:win    # gera instalador .exe (rodar no Windows)
npm run dev:web     # versão navegador (Chrome/Edge)
npm run build:web   # site estático em dist/
npm run build:pages # versão de navegador em docs/app/ (GitHub Pages serve a pasta docs/)
npm test            # testes unitários (Vitest)
```

## Recursos

- Tracks ilimitadas de vídeo e áudio (ocultar, mudo, travar, reordenar camadas).
- Vídeo, áudio, imagem (PNG/JPG/…) e texto.
- **Texto com estilo**: contorno e segundo contorno, gradiente, sombra, caixa de fundo (bloco ou por linha, com margem e cantos arredondados), espaçamento entre letras, altura da linha e maiúsculas. Vale para clipes de texto e camadas de texto do Motion.
- **Animação de texto** letra por letra, palavra por palavra ou linha por linha: entrada e saída (aparecer, subir, cair, deslizar, crescer, girar, desfocar, máquina de escrever), com ordem (do início, do fim, do centro, das pontas, aleatória), duração, atraso entre unidades e curva; e efeitos contínuos (onda, tremer, pulsar, piscar).
- **Entrada e saída** de elementos: além de combinar, deslizar e flash, as animações em shader (revelar, dissolver, zoom, pixels, subir e aparecer, ou criadas por você) servem para clipes e camadas do Motion.
- Keyframes de X, Y, largura, altura, rotação, opacidade e volume (linear, suave ou constante).
- Volume desenhado como linha no clipe: arraste para ajustar, Ctrl+clique cria ponto, duplo clique remove.
- **Atalhos no estilo CapCut**: `B` ferramenta de corte (clique no clipe divide ali), `A` seleção, `Q`/`W` apagam antes/depois do playhead, `S` ou `Ctrl+B` divide no playhead, `↑`/`↓` pulam entre cortes, `N` liga o ímã, `Shift+Z` ajusta o zoom. `?` mostra a lista completa.
- Arrastar clipes no tempo e entre tracks, aparar bordas, dividir (S). Alt+arrastar (ou "Modo inserção") reordena as cenas empurrando as demais.
- Dimensões do projeto em pixels e FPS (com predefinições 16:9, 9:16, 1:1, 4:5, 4K).
- Exportação MP4 (H.264 + AAC) ou só áudio MP3.
- **Efeitos** em clipes e em camadas do Motion: ajuste de cor, chroma key, preto e branco, vinheta, pixelizar, sombra, brilho externo e desfoque, com parâmetros animáveis por keyframe.
- **Máscaras** de clipe (retângulo, elipse e forma livre) com suavização, inversão e keyframes, editadas direto no preview.
- **Extensões**: efeitos, transições e animações de entrada/saída escritos em GLSL, com editor e pré-visualização dentro do app, instalação por arquivo e compatibilidade com o gl-transitions. Veja abaixo.
- **Motion design**: composições separadas (aba Motion) com camadas de forma, texto, imagem e caminho vetorial, que entram na timeline como um clipe transparente. Veja abaixo.
- Projetos salvos em JSON. No desktop as mídias são recarregadas pelo caminho; arquivos ausentes podem ser reapontados.

## Motion design

Crie uma composição em **+ Composição** (ou na biblioteca) e edite na aba **Motion**. Duplo clique num clipe de composição também abre o workspace.

- Formas (retângulo, elipse, polígono, estrela, linha), texto, imagens da biblioteca e caminhos desenhados com a caneta.
- Toda propriedade com ◆ é animável: posição, escala, rotação, opacidade, âncora, tamanho, arredondamento, cores e traço.
- Curvas de easing por keyframe: predefinições (acelerar, quicar, elástico…) ou curva bezier personalizada.
- Hierarquia pai/filho (coluna "pai" na timeline de camadas) e grupos para mover várias camadas juntas.
- Importar SVG: cada forma vira uma camada e cada `<g>` vira um grupo. Gradientes viram cor sólida; textos, filtros e recortes são ignorados.
- Traço animado (aparar início/fim), máscara por camada e animações prontas de entrada e saída.
- Caneta (P): clique cria pontos, arrastar cria curvas. Duplo clique num caminho edita os pontos; com ◆ ligado em "Caminho", mover pontos em outro instante cria o morph (os keyframes precisam ter a mesma quantidade de pontos).
- Composições não têm áudio nem vídeo, e não podem conter outras composições.

## Extensões (efeitos, transições e entradas/saídas em código)

O botão **Extensões** abre a lista de efeitos, transições e entradas/saídas, o editor de código e a instalação de arquivos. Arquivos `.csfx.json` e `.glsl` também podem ser arrastados para a janela.

Uma extensão é um shader de fragmento (GLSL ES 3.00) dentro de um JSON. Shaders só calculam a cor de cada pixel: não acessam arquivos, rede nem o resto do aplicativo, por isso é seguro instalar o que outras pessoas compartilham.

```json
{
  "format": "corteseco-fx", "version": 1,
  "id": "ana.negativo", "name": "Negativo", "author": "Ana", "kind": "effect",
  "params": [{ "name": "forca", "label": "Força", "type": "float", "default": 1, "min": 0, "max": 1 }],
  "glsl": "vec4 effect(vec2 uv) {\n  vec4 c = getColor(uv);\n  return vec4(mix(c.rgb, 1.0 - c.rgb, forca), c.a);\n}"
}
```

- **Efeito** (`"kind": "effect"`): defina `vec4 effect(vec2 uv)` e leia a imagem com `getColor(uv)`.
- **Transição** (`"kind": "transition"`): defina `vec4 transition(vec2 uv)` e leia as cenas com `getFromColor(uv)` e `getToColor(uv)`. É a mesma assinatura do [gl-transitions](https://gl-transitions.com/), cujos arquivos `.glsl` podem ser instalados direto.
- **Entrada/saída** (`"kind": "animation"`): defina `vec4 animate(vec2 uv)` e leia o elemento com `getColor(uv)`. `uv` de 0 a 1 cobre a caixa do elemento, com uma margem de 25% em volta para ele poder se mover ou crescer para fora dela; `progress` é quanto do elemento está visível (0 → 1 na entrada, 1 → 0 na saída, então o mesmo código serve para as duas) e `entering` diz qual está tocando; `resolution` é o tamanho do elemento. Escolha-as em "Entrada" e "Saída" no inspector do clipe ou da camada.
- Disponíveis no código: `time` (segundos), `progress` (0 a 1), `resolution`, `ratio` e os parâmetros declarados. `uv` vai de 0 a 1, com (0,0) no canto inferior esquerdo.
- Tipos de parâmetro: `float`, `int`, `bool`, `color` (com transparência), `color3`, `vec2`, `ivec2`. Em efeitos, números e cores podem ser animados por keyframe.
- O projeto salvo leva uma cópia das extensões que usa, então abre em outra máquina mesmo sem elas instaladas.
- Sombra, brilho externo e desfoque são sempre aplicados depois dos demais efeitos e das máscaras.

## Interface personalizável

- A barra superior tem só ícones; o nome de cada botão aparece ao passar o mouse.
- O botão **Painéis** (canto superior direito) mostra ou oculta Mídia, Preview, Inspector e Timeline, troca a ordem das colunas, põe qualquer coluna em altura inteira (ao lado da timeline) e move a timeline para cima ou para baixo. Os layouts prontos (Padrão, Vertical, Timeline grande) ficam no mesmo menu. O arranjo é lembrado nesta máquina.
- **Altura das tracks**: arraste a borda de baixo do cabeçalho de uma track. Duplo clique na borda volta ao padrão. A altura é salva no projeto.

## Desempenho em computador fraco

O botão **Desempenho** na barra superior reúne o que deixa o editor leve:

- **Qualidade do preview**: Automática (desenha no tamanho em que o preview aparece na tela), Cheia, 1/2 ou 1/4. A exportação é sempre na resolução cheia do projeto.
- **Usar a placa de vídeo** (desktop): ligado por padrão. Desligue se a tela piscar, ficar preta ou o app fechar sozinho; a troca vale depois de reiniciar. A tela mostra se a placa está de fato em uso.
- **Decodificar e codificar vídeo pela placa** (Linux, experimental): usa VA-API. Vem desligado porque depende do driver.
- **Exportação rápida**: codifica mais depressa, com um pouco menos de qualidade.
- **Arquivos proxy** (desktop): cópias leves dos vídeos (360, 540 ou 720 de altura), geradas em segundo plano e usadas só no preview. A exportação lê sempre o original. Ficam na pasta de dados do app, são reaproveitadas entre sessões e têm limite de espaço.
- **Medidor**: quadros desenhados por segundo e tempo gasto em cada parte, para ver onde a máquina sofre.

O que o app faz sozinho: só redesenha o preview quando algo muda; lê os vídeos direto do disco, sem carregá-los na memória (desktop); guarda só os picos da forma de onda, não o áudio; grava a exportação no disco aos poucos (desktop); e cria na timeline apenas os elementos da faixa visível.

## Conexão com IA (servidor MCP)

O Claude (ou outra IA compatível com MCP) pode se conectar ao app aberto, entender o projeto e editar o vídeo inteiro: importar arquivos, montar a timeline, cortar, aplicar efeitos, máscaras, chroma key e transições, criar composições de motion, escrever extensões GLSL, olhar quadros renderizados, salvar e exportar.

1. No app desktop, clique em **IA** na barra superior e ligue **Permitir conexão de IA**.
2. Copie o comando mostrado ali e configure o Claude uma vez:
   - **Claude Code**: rode o comando `claude mcp add …` no terminal.
   - **Claude Desktop**: cole o bloco JSON em `claude_desktop_config.json` e reinicie o Claude.
3. Peça em linguagem natural, por exemplo: "monte um vídeo com os arquivos de ~/Vídeos/viagem, com título animado e transições".

Como funciona e o que protege o seu computador:

- `mcp/server.mjs` é o servidor MCP (stdio, sem dependências). Ele roda com o executável do próprio app no papel de Node (`ELECTRON_RUN_AS_NODE=1`), então não precisa ter Node instalado. As ferramentas estão descritas em `mcp/tools.json` e implementadas em `src/mcp/tools.js`.
- Ao ligar a conexão, o app abre um servidor HTTP só em `127.0.0.1`, numa porta aleatória, com uma senha nova a cada vez. Porta e senha ficam em `~/.corteseco-studio/bridge.json`, legível só pelo seu usuário. Páginas da web são recusadas.
- Desligar a conexão (ou fechar o app) derruba o servidor e apaga o arquivo.
- Cada edição da IA é um passo de desfazer (Ctrl+Z) e aparece na hora. Uma chamada inválida não altera nada e volta com a explicação do erro para a IA corrigir.


- `src/mcp/` ferramentas que a IA usa; `mcp/` servidor MCP; `electron/aiBridge.cjs` ponte local entre os dois
- `src/fx/` efeitos, máscaras e extensões: motor WebGL2, efeitos nativos, registro/validação de extensões
- `src/motion/` motor do motion design: modelo de composições/camadas, geometria, renderização, easing, presets e import de SVG
- `src/ui/motion/` workspace de motion: palco, timeline de camadas, inspector, caneta

- `src/state/` modelo do projeto, histórico (desfazer/refazer) e interpolação de keyframes
- `src/engine/` compositor (mesmo desenho no preview e na exportação), player, mixer de áudio, exportador
- `src/ui/` timeline, preview, inspector, biblioteca de mídia, diálogos
- `src/platform/` único ponto que difere entre desktop e web (salvar/abrir arquivos)
- `electron/` processo principal e preload; `electron/media.cjs` protocolo `media://`, gravação por posição e pasta de proxies; `electron/config.cjs` configuração de partida (placa de vídeo)
- `src/perf.js` medidor; `src/prefs.js` preferências da máquina; `src/media/proxy.js` arquivos proxy; `src/media/peaks.js` picos da forma de onda
