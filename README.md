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
- Keyframes de X, Y, largura, altura, rotação, opacidade e volume (linear, suave ou constante).
- Volume desenhado como linha no clipe: arraste para ajustar, Ctrl+clique cria ponto, duplo clique remove.
- Arrastar clipes no tempo e entre tracks, aparar bordas, dividir (S). Alt+arrastar (ou "Modo inserção") reordena as cenas empurrando as demais.
- Dimensões do projeto em pixels e FPS (com predefinições 16:9, 9:16, 1:1, 4:5, 4K).
- Exportação MP4 (H.264 + AAC) ou só áudio MP3.
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

## Estrutura

- `src/motion/` motor do motion design: modelo de composições/camadas, geometria, renderização, easing, presets e import de SVG
- `src/ui/motion/` workspace de motion: palco, timeline de camadas, inspector, caneta

- `src/state/` modelo do projeto, histórico (desfazer/refazer) e interpolação de keyframes
- `src/engine/` compositor (mesmo desenho no preview e na exportação), player, mixer de áudio, exportador
- `src/ui/` timeline, preview, inspector, biblioteca de mídia, diálogos
- `src/platform/` único ponto que difere entre desktop e web (salvar/abrir arquivos)
- `electron/` processo principal e preload
