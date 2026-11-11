#!/usr/bin/env bash
# Compila o CorteSeco Studio para todas as plataformas, a partir do Linux:
#   - Linux .deb
#   - Linux AppImage
#   - Windows (instalador .exe e .zip portátil)
#
# Uso:
#   scripts/build-all.sh                 # tudo
#   scripts/build-all.sh appimage win    # só os alvos pedidos (deb | appimage | win)
#
# Os arquivos saem em release/.
set -euo pipefail

cd "$(dirname "$0")/.."

# alguns terminais (como o do VS Code) definem isto, e o electron-builder passa a rodar o Electron como Node
unset ELECTRON_RUN_AS_NODE

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(deb appimage win)
for t in "${targets[@]}"; do
  case "$t" in
    deb | appimage | win) ;;
    *) echo "Alvo desconhecido: $t (use deb, appimage ou win)" >&2; exit 2 ;;
  esac
done

command -v npm > /dev/null || { echo "npm não encontrado: instale o Node.js." >&2; exit 1; }
[ -d node_modules ] || { echo "==> Instalando dependências"; npm install; }

version=$(node -p "require('./package.json').version")
echo "==> CorteSeco Studio $version — alvos: ${targets[*]}"

echo "==> Compilando a interface (vite build)"
npx vite build

ok=()
failed=()
build() { # nome, argumentos do electron-builder...
  local name=$1
  shift
  echo
  echo "==> $name"
  if npx electron-builder "$@" --publish never; then ok+=("$name"); else failed+=("$name"); fi
}

for t in "${targets[@]}"; do
  case "$t" in
    deb) build "Linux .deb" --linux deb ;;
    appimage) build "Linux AppImage" --linux AppImage ;;
    win)
      extra=()
      if ! command -v wine > /dev/null && ! command -v wine64 > /dev/null; then
        # gravar o ícone e os dados do app dentro do .exe exige o Wine; sem ele o app funciona igual,
        # mas o executável fica com o ícone padrão do Electron
        echo "    Aviso: Wine não instalado — o .exe ficará com o ícone padrão do Electron."
        echo "    Para o ícone do app: sudo apt install wine   (e rode de novo)"
        extra=(-c.win.signAndEditExecutable=false)
      fi
      build "Windows (instalador e zip)" --win nsis zip --x64 "${extra[@]}"
      ;;
  esac
done

echo
echo "==> Arquivos em release/"
find release -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.exe' -o -name '*.zip' \) -newer package.json -printf '    %f  (%s bytes)\n' 2> /dev/null | sort || true

echo
[ ${#ok[@]} -gt 0 ] && printf 'Concluído: %s\n' "${ok[@]}"
if [ ${#failed[@]} -gt 0 ]; then
  printf 'FALHOU: %s\n' "${failed[@]}" >&2
  exit 1
fi
