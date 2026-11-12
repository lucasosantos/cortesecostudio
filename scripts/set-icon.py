#!/usr/bin/env python3
"""Troca o ícone do CorteSeco Studio a partir de uma imagem qualquer.

Uso:
  npm run icon -- caminho/da/imagem.png [opções]
  python3 scripts/set-icon.py caminho/da/imagem.png [opções]

Gera um PNG quadrado e grava em:
  build/icon.png  -> app desktop, barra de tarefas e instaladores (electron-builder)
  docs/icon.png   -> site do GitHub Pages e FX Lab

Opções:
  --mode fit|crop   fit (padrão): a imagem inteira cabe no quadrado e sobra fundo
                    crop: preenche o quadrado e corta o excesso pelo centro
  --bg COR          fundo das sobras: transparent (padrão) ou #rrggbb
  --padding N       margem em % do lado (padrão 0)
  --trim            corta antes as bordas vazias (transparentes ou da cor do canto)
  --size N          lado em pixels (padrão 512; mínimo 256)

Precisa do Pillow (pip install pillow). Para desfazer: git checkout build/icon.png docs/icon.png
"""
import argparse
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit('Falta o Pillow: rode  pip install pillow')

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [ROOT / 'build' / 'icon.png', ROOT / 'docs' / 'icon.png']
ICO_CACHE = ROOT / 'release' / '.icon-ico'  # .ico gerado pelo electron-builder a partir do ícone antigo


def parse_color(s):
    if s == 'transparent':
        return (0, 0, 0, 0)
    s = s.lstrip('#')
    if len(s) not in (6, 8):
        sys.exit(f'Cor inválida: {s} (use #rrggbb ou transparent)')
    rgba = [int(s[i:i + 2], 16) for i in range(0, len(s), 2)]
    return tuple(rgba + [255] * (4 - len(rgba)))


def trim(img):
    """Corta as bordas transparentes ou da mesma cor do canto superior esquerdo."""
    alpha = img.getchannel('A')
    box = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
    if box and box != (0, 0, *img.size):
        return img.crop(box)
    bg = Image.new('RGBA', img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, bg).convert('L').point(lambda v: 255 if v > 24 else 0)
    box = diff.getbbox()
    return img.crop(box) if box else img


def main():
    ap = argparse.ArgumentParser(description='Troca o ícone do CorteSeco Studio.')
    ap.add_argument('image', help='imagem de origem (PNG, JPG, WEBP...)')
    ap.add_argument('--mode', choices=['fit', 'crop'], default='fit')
    ap.add_argument('--bg', default='transparent')
    ap.add_argument('--padding', type=float, default=0)
    ap.add_argument('--trim', action='store_true')
    ap.add_argument('--size', type=int, default=512)
    a = ap.parse_args()

    src = Path(a.image).expanduser()
    if not src.is_file():
        sys.exit(f'Arquivo não encontrado: {src}')
    if a.size < 256:
        sys.exit('--size precisa ser pelo menos 256 (exigência do instalador do Windows).')
    if not 0 <= a.padding < 50:
        sys.exit('--padding vai de 0 a 49.')

    img = Image.open(src).convert('RGBA')
    if a.trim:
        img = trim(img)

    size = a.size
    inner = round(size * (1 - 2 * a.padding / 100))
    w, h = img.size
    scale = (max if a.mode == 'crop' else min)(inner / w, inner / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    if a.mode == 'crop':
        left, top = (nw - inner) // 2, (nh - inner) // 2
        img = img.crop((left, top, left + inner, top + inner))

    out = Image.new('RGBA', (size, size), parse_color(a.bg))
    out.alpha_composite(img, ((size - img.width) // 2, (size - img.height) // 2))

    for t in TARGETS:
        t.parent.mkdir(parents=True, exist_ok=True)
        out.save(t, optimize=True)
        print(f'ok  {t.relative_to(ROOT)}  ({size}x{size})')
    if ICO_CACHE.exists():
        shutil.rmtree(ICO_CACHE)
        print(f'ok  apagado {ICO_CACHE.relative_to(ROOT)} (o próximo build gera o .ico novo)')
    print('\nPronto. Reinicie o app para ver; rode npm run dist para os instaladores; faça commit de docs/ para o site.')


if __name__ == '__main__':
    main()
