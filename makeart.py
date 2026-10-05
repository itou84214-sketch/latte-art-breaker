# -*- coding: utf-8 -*-
"""手描きのラテアートを、サイト同梱用の「型」に焼き付ける。

    python makeart.py 手描き.jpg art/leaf.png
    python makeart.py 手描き.jpg art/leaf.png --invert     # 白黒が逆のとき

やっていることは latte.js の buildMask() とまったく同じです。

  1. 絵と紙を分ける  … 透明つき PNG は透明度をそのまま使う。
                       持たない画像は輝度を大津の二値化でしきい分けし、
                       画像のふちの平均輝度を「紙」とみなして反対側を絵とする。
  2. 絵のある四角を切り出す … 写真の余白を捨てる。
  3. カップの内側いっぱい（直径の 86%）に置き直す。

出来上がりは 768×768 の白黒 PNG（白＝ミルク／黒＝コーヒー）です。
これを index.html の canvas に data-art="…" で指させると、その杯の既定の絵になります。
"""
import sys, os
from PIL import Image, ImageOps

MASK_PX  = 768
SIM_HALF = 1.15    # latte.js の CONF と合わせること
CUP_R    = 0.80
FILL     = 0.86    # カップ直径に対する絵の入る割合
SOFT     = 14      # 境目をぼかす階調幅
WORK     = 900     # 解析するときの長辺


def otsu(hist, total):
    s = sum(i * h for i, h in enumerate(hist))
    sb = wb = 0
    best, thr = -1.0, 128
    for i in range(256):
        wb += hist[i]
        if wb == 0:
            continue
        wf = total - wb
        if wf == 0:
            break
        sb += i * hist[i]
        mb, mf = sb / wb, (s - sb) / wf
        v = wb * wf * (mb - mf) ** 2
        if v > best:
            best, thr = v, i
    return thr


def build(src_path, invert=False):
    im = ImageOps.exif_transpose(Image.open(src_path))   # 写真の向きを直す
    im = im.convert('RGBA')
    k = min(1.0, float(WORK) / max(im.size))
    if k < 1.0:
        im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    w, h = im.size
    px = im.load()

    alpha = im.getchannel('A')
    if alpha.getextrema()[0] < 240:
        src = alpha                       # 透明度がそのまま絵の濃さ
        cov = [v / 255.0 for v in src.tobytes()]
    else:
        g = im.convert('L')
        lum = list(g.tobytes())
        thr = otsu(g.histogram(), w * h)
        # ふちを「紙」とみなす
        edge = ([lum[x] for x in range(w)] +
                [lum[(h - 1) * w + x] for x in range(w)] +
                [lum[y * w] for y in range(h)] +
                [lum[y * w + w - 1] for y in range(h)])
        paper_dark = (sum(edge) / len(edge)) < thr
        cov = []
        for v in lum:
            t = (thr - v) / float(SOFT)
            if paper_dark:
                t = -t
            cov.append(min(1.0, max(0.0, t * 0.5 + 0.5)))

    if invert:
        cov = [1.0 - c for c in cov]

    frac = sum(cov) / (w * h)
    if frac > 0.93:
        raise SystemExit('ほとんど塗りつぶしに見えます。--invert を試してください。')
    if frac < 0.002:
        raise SystemExit('絵が見つかりませんでした。--invert を試してください。')

    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row = y * w
        for x in range(w):
            if cov[row + x] > 0.5:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        raise SystemExit('絵が見つかりませんでした。')

    mask = Image.new('L', (w, h))
    mask.putdata([int(round(c * 255)) for c in cov])
    crop = mask.crop((minx, miny, maxx + 1, maxy + 1))

    cup_d = (CUP_R / SIM_HALF) * MASK_PX
    box = cup_d * FILL
    s = min(box / crop.width, box / crop.height)
    dw, dh = max(1, int(round(crop.width * s))), max(1, int(round(crop.height * s)))
    crop = crop.resize((dw, dh), Image.LANCZOS)

    out = Image.new('L', (MASK_PX, MASK_PX), 0)
    out.paste(crop, ((MASK_PX - dw) // 2, (MASK_PX - dh) // 2))
    return out, frac, (crop.width, crop.height)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        print(__doc__)
        raise SystemExit(2)
    src, dst = args
    out, frac, size = build(src, '--invert' in sys.argv)
    d = os.path.dirname(dst)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    out.save(dst, optimize=True)
    print('%s -> %s  (%dx%d, 絵の占める割合 %.1f%%, 配置 %dx%d px)'
          % (src, dst, MASK_PX, MASK_PX, frac * 100, size[0], size[1]))
