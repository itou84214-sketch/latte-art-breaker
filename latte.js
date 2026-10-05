/* =========================================================================
   Latte Art Breaker — WebGL2 流体シミュレーション
   -------------------------------------------------------------------------
   模様の作りかたについて（ここが要点）

   以前は「完成した絵」を数式で描いていました。いまは違います。
   本物と同じで、注ぎ口を動かしながらミルクを置いていきます。

     ・注ぎ口のまわりの液は、外へ押しのけられる（上から液が落ちてくるので、
       水面の面積は保存されません）
     ・押しのけられた古い泡は、新しい弧の外側に三日月として残る
     ・注ぎ口を左右に振りながら進めれば、その三日月が積み重なって葉になる

   つまり層構造は「描いて」いません。押しのけの結果として勝手にできます。
   最後に細く速く引き抜くと、模様が引きずられて葉先が尖ります。

   同じ仕組みを指に繋いだのが、いちばん下の「自分で描く」です。

   流体そのものは Stable Fluids（Jos Stam）の標準的な流れです。
     1. 速度の移流 + 指の力 + 粘性
     2. 発散を計算
     3. 圧力をヤコビ法で解く
     4. 圧力勾配を引いて非圧縮にする  ← 省くとミルクの面積が増えて破綻する
     5. ミルク濃度を MacCormack 法で移流
     6. 画面へ描画

   計算が回るのは触れている間とその直後だけです。指を離すと SETTLE 秒で
   静止し、そのあとは計算そのものを止めます。放っておいても崩れません。
   ========================================================================= */
(function () {
  'use strict';

  var CONF = {
    SIM_HALF:   1.15,   // シミュレーション領域の半幅（カップ座標系）
    CUP_R:      0.80,   // カップの内径
    NEED:       1.43,   // 画面に必ず収めたい半径（受け皿・持ち手・小物まで）
    NV:         256,    // 速度グリッド解像度
    ND:         768,    // ミルク濃度グリッド解像度（狭い画面では下げる）
    ITERS:      24,     // 圧力ソルバの反復回数
    RADIUS:     0.060,  // かき混ぜる筆の半径
    DECAY:      0.988,  // 触れている間の速度の減衰
    DECAY_IDLE: 0.90,   // 指を離したあとの減衰（すばやく静止させる）
    SETTLE:     1.6,    // 最後に触れてから完全に停止するまでの秒数
    DRAG:       0.90,   // ドラッグ時の強さ
    HOVER:      0.32,   // ホバー時の強さ
    POUR_SEC:   2.2     // 注ぎきるまでの秒数
  };

  // すべてのカップに効く共通のつまみ
  var shared = { strength: 1, visc: 0.36, steam: 1 };

  var TAU = Math.PI * 2;

  // =======================================================================
  //  シェーダ
  // =======================================================================
  var VERT = [
    '#version 300 es',
    'in vec2 aPos;',
    'out vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var COMMON_GLSL = [
    'const float SIM_HALF = ' + CONF.SIM_HALF.toFixed(4) + ';',
    'const float CUP_R    = ' + CONF.CUP_R.toFixed(4) + ';',
    'vec2 simToCup(vec2 s){ return (s - 0.5) * 2.0 * SIM_HALF; }',
    'vec2 segNear(vec2 p, vec2 a, vec2 b){',
    '  vec2 pa = p - a, ba = b - a;',
    '  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);',
    '  return a + ba * h;',
    '}'
  ].join('\n');

  var NOISE_GLSL = [
    'float hash21(vec2 p){ return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
    'float fbm(vec2 p){',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, -0.9); a *= 0.5; }',
    '  return s;',
    '}'
  ].join('\n');


  // --- 模様の定義（三日月の積層）------------------------------------------
  // 本物のラテアートは、注ぐたびに置かれた泡の弧が次の弧に覆われ、外側だけが
  // 三日月として残ることで層になります。その一枚を lune()、積み上げを
  // rosetta() が受け持ちます。
  var PATTERN_GLSL = [
    COMMON_GLSL,
    'const float PI = 3.14159265;',
    '',
    '// ハートの陰関数：(x^2+y^2-1)^3 - x^2 y^3 < 0 が内側',
    'float heartF(vec2 p, float s, float cy){',
    '  float X = p.x / s;',
    '  float Y = (p.y - cy) / s;',
    '  float a = X*X + Y*Y - 1.0;',
    '  return -(a*a*a - X*X*Y*Y*Y);',
    '}',
    '',
    '// 三日月ひとつ。(±W, 0) を通り下へ h ふくらむ弧と、その内側 t だけ薄い',
    '// 弧に挟まれた領域。2 本とも同じ 2 点を通るので、両端が必ず尖ります。',
    'float lune(vec2 p, float W, float h, float t){',
    '  h = max(h, t * 1.28 + 1e-4);',
    '  float h2 = h - t;',
    '  float m1 = (W*W - h*h)   / (2.0 * h);',
    '  float m2 = (W*W - h2*h2) / (2.0 * h2);',
    '  float d1 = length(p - vec2(0.0, m1)) - (m1 + h);',
    '  float d2 = length(p - vec2(0.0, m2)) - (m2 + h2);',
    '  return min(-d1, d2);',
    '}',
    '',
    '// ロゼッタ：三日月を根元から先端へ積む。幅は釣鐘状に増減。',
    '// 白の厚みを間隔の 74% にすると、残りがクレマの細い筋になります。',
    '//',
    '// sweep は「反り」。本物は注いだ線がカップの中の流れに巻き込まれ、',
    '// 葉先が根元側へ寄ります。y に x^2 を足してから三日月を評価すると、',
    '// 葉先ほど下がった弓なりの葉になります。これが曲線の正体です。',
    'float rosetta(vec2 p, float yA, float yB, float Wmax, float N,',
    '              float bulge, float sweep, float stemOn){',
    '  float span = yB - yA;',
    '  float dy   = span / N;',
    '  float t    = dy * 0.74;',
    '  float F = -1e9;',
    '  for (int i = 0; i < 20; i++){',
    '    if (float(i) >= N) break;',
    '    float u = (float(i) + 0.5) / N;',
    '    float W = Wmax * pow(max(sin(PI * pow(u, 0.78)), 0.0), 0.55);',
    '    if (W < 0.012) continue;',
    '    vec2 q = p - vec2(0.0, yA + span * u);',
    '    q.y += sweep * q.x * q.x;',
    '    F = max(F, lune(q, W, W * bulge, t));',
    '  }',
    '  if (stemOn > 0.5){',
    '    float stem = min((0.015 - abs(p.x)) * 26.0,',
    '                     min((p.y - yA + 0.12) * 12.0, (yB + 0.10 - p.y) * 12.0));',
    '    F = max(F, stem);',
    '  }',
    '  return F;',
    '}',
    '',
    'float fRosetta(vec2 p){ return rosetta(p, -0.60, 0.60, 0.54, 12.0, 0.62, 0.62, 1.0); }',
    '',
    'float sdSeg2(vec2 p, vec2 a, vec2 b){',
    '  vec2 pa = p - a, ba = b - a;',
    '  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);',
    '  return length(pa - ba * h);',
    '}',
    'vec2 bezg(vec2 a, vec2 b, vec2 c, vec2 d, float t){',
    '  float u = 1.0 - t;',
    '  return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d;',
    '}',
    'vec2 rotp(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c*p.x + s*p.y, -s*p.x + c*p.y); }',
    '',
    '// 好きな向きに倒したハート。とがりの向きが ang（ラジアン）になります',
    'float heartAt(vec2 p, vec2 c, float s, float ang){',
    '  return heartF(rotp(p - c, ang + 1.5707963), s, 0.0);',
    '}',
    '',
    '// 白鳥：羽はロゼッタ。ただし茎は通さず、ミルクを羽の「脇」に沿って',
    '// 引き抜き、そのまま首へ伸ばして、最後にハートを置いて頭にします。',
    'float fSwan(vec2 p){',
    '  float F = rosetta(rotp(p - vec2(0.13, -0.09), 0.16), -0.48, 0.48, 0.44,',
    '                    10.0, 0.60, 0.70, 0.0);',
    '',
    '  // 羽の脇 → 首 → 頭 まで、ひと続きの引き抜き',
    '  vec2 A = vec2( 0.46,-0.42);',
    '  vec2 B = vec2( 0.62, 0.22);',
    '  vec2 C = vec2( 0.18, 0.66);',
    '  vec2 D = vec2(-0.30, 0.50);',
    '  float d = 1e9;',
    '  vec2 prev = A;',
    '  for (int i = 1; i <= 20; i++){',
    '    float t = float(i) / 20.0;',
    '    vec2 cur = bezg(A, B, C, D, t);',
    '    d = min(d, sdSeg2(p, prev, cur) - mix(0.046, 0.019, t - 0.5 / 20.0));',
    '    prev = cur;',
    '  }',
    '  F = max(F, -d * 4.0);',
    '',
    '  // 頭はハート。そのとがりがそのままくちばしになります',
    '  F = max(F, heartAt(p, vec2(-0.315, 0.505), 0.105, 3.4557) * 2.0);',
    '  return F;',
    '}',
    '',
    '// ハートリーフ：ハートの輪郭を置いてから、中へ小さくロゼッタを注ぐ',
    'float fWingHeart(vec2 p){',
    '  float ring  = min(heartF(p, 0.58, -0.05), -heartF(p, 0.487, -0.045));',
    '  float inner = rosetta(p - vec2(0.0, 0.03), -0.34, 0.36, 0.33, 9.0, 0.58, 0.80, 1.0);',
    '  float link  = min((0.017 - abs(p.x)) * 24.0,',
    '                    min((p.y + 0.58) * 12.0, (0.30 - p.y) * 12.0));',
    '  return max(max(ring, inner), link);',
    '}',
    '',
    'float patternF(vec2 p, int id){',
    '  if (id == 1) return fSwan(p);',
    '  if (id == 2) return fWingHeart(p);',
    '  return fRosetta(p);',
    '}'
  ].join('\n');

  // --- 模様をテクスチャに焼く（注ぎ直したときだけ）------------------------
  var FRAG_MASK = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform int   uPattern;',
    'uniform float uCell;',
    PATTERN_GLSL,
    'void main(){',
    '  vec2 p = simToCup(vUv);',
    '  // 3x3 のサブサンプル。三日月の細い筋をつぶさないよう多めに取る',
    '  float acc = 0.0;',
    '  for (int j = 0; j < 3; j++){',
    '    for (int i = 0; i < 3; i++){',
    '      vec2 o = (vec2(float(i), float(j)) - 1.0) * 0.34 * uCell;',
    '      acc += patternF(p + o, uPattern) > 0.0 ? 1.0 : 0.0;',
    '    }',
    '  }',
    '  fragColor = vec4(acc / 9.0, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // --- 手描きの絵を、そのまま模様として焼く --------------------------------
  // 画像は JS 側で「ミルクの濃さ」だけの正方形に直してから渡ってきます。
  // ここではカップの内側で切り抜くだけです。
  var FRAG_MASK_PHOTO = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uPhoto;',
    COMMON_GLSL,
    'void main(){',
    '  vec2 p = simToCup(vUv);',
    '  float milk = texture(uPhoto, vUv).r;',
    '  milk *= smoothstep(CUP_R, CUP_R - 0.02, length(p));',
    '  fragColor = vec4(milk, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // --- 注ぐ（焼いた模様を上から下へ現していく）----------------------------
  var FRAG_POUR = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uMask;',
    'uniform float uPour;',
    COMMON_GLSL,
    NOISE_GLSL,
    'void main(){',
    '  vec2 p = simToCup(vUv);',
    '  float milk = texture(uMask, vUv).x;',
    '  float h = (p.y + 0.75) / 1.5;',
    '  float front = mix(1.20, -0.20, uPour) + (fbm(p * 4.0) - 0.5) * 0.06;',
    '  milk *= smoothstep(front - 0.04, front + 0.04, h);',
    '  milk *= smoothstep(CUP_R, CUP_R - 0.02, length(p));',
    '  fragColor = vec4(milk, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // --- 注ぎの 1 ストローク ------------------------------------------------
  // 注ぎ口（線分 uP0→uP1）のまわりの液を外へ押しのけ、進行方向へ引きずり、
  // そこへ新しいミルクを置く。これを何百回も繰り返すと層ができる。
  // 指で描くときも同じシェーダを使う。
  var FRAG_STROKE = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uSrc;',
    'uniform vec2  uP0;',
    'uniform vec2  uP1;',
    'uniform vec2  uDrag;',
    'uniform float uR;',
    'uniform float uPush;',
    'uniform float uInk;',
    'uniform float uJit;',
    COMMON_GLSL,
    NOISE_GLSL,
    'void main(){',
    '  vec2 near = segNear(vUv, uP0, uP1);',
    '  vec2 d = vUv - near;',
    '  float dist = length(d);',
    '  float g = exp(-(dist * dist) / (uR * uR * 2.0));',
    '',
    '  // 押しのけ＋引きずりを、逆向きにたどって拾い直す（セミラグランジュ）',
    '  vec2 src = vUv - (d / max(dist, 1e-5)) * (uPush * g) - uDrag * g;',
    '  float v = texture(uSrc, clamp(src, 0.0015, 0.9985)).x;',
    '',
    '  // 注ぎ口に新しいミルクを置く。縁はノイズで少し不揃いにする',
    '  float edge = uR * (1.0 + (fbm(vUv * 60.0) - 0.5) * uJit);',
    '  float a = smoothstep(edge, edge * 0.45, dist);',
    '  if (uInk > 0.0) v = max(v, a * uInk);',
    '  else if (uInk < 0.0) v = min(v, 1.0 - a);',
    '',
    '  v *= smoothstep(CUP_R, CUP_R - 0.015, length(simToCup(vUv)));',
    '  fragColor = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // --- 速度の移流 + 力 + 粘性 --------------------------------------------
  var FRAG_VEL = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uVel;',
    'uniform vec2  uTexel;',
    'uniform vec2  uP0;',
    'uniform vec2  uP1;',
    'uniform float uStrength;',
    'uniform float uRadius;',
    'uniform float uDecay;',
    'uniform float uVisc;',
    COMMON_GLSL,
    'void main(){',
    '  vec2 v = texture(uVel, vUv).xy;',
    '  vec2 nv = texture(uVel, clamp(vUv - v, 0.0, 1.0)).xy;',
    '  vec2 avg = 0.25 * (texture(uVel, vUv + vec2(uTexel.x, 0.0)).xy',
    '                   + texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy',
    '                   + texture(uVel, vUv + vec2(0.0, uTexel.y)).xy',
    '                   + texture(uVel, vUv - vec2(0.0, uTexel.y)).xy);',
    '  nv = mix(nv, avg, uVisc);',
    '  if (uStrength > 0.0){',
    '    float dd = length(vUv - segNear(vUv, uP0, uP1));',
    '    float fa = exp(-(dd * dd) / (uRadius * uRadius));',
    '    nv = mix(nv, uP1 - uP0, clamp(fa * uStrength, 0.0, 1.0));',
    '  }',
    '  nv *= uDecay;',
    '  nv *= smoothstep(CUP_R, CUP_R - 0.06, length(simToCup(vUv)));',
    '  fragColor = vec4(nv, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_DIV = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uVel;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;',
    '  float r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;',
    '  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;',
    '  float t = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;',
    '  fragColor = vec4(0.5 * ((r - l) + (t - b)), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_JACOBI = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;',
    '  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;',
    '  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;',
    '  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;',
    '  float d = texture(uDivergence, vUv).x;',
    '  fragColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_GRAD = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVel;',
    'uniform vec2 uTexel;',
    COMMON_GLSL,
    'void main(){',
    '  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;',
    '  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;',
    '  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;',
    '  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;',
    '  vec2 v = texture(uVel, vUv).xy - 0.5 * vec2(r - l, t - b);',
    '  v *= smoothstep(CUP_R, CUP_R - 0.06, length(simToCup(vUv)));',
    '  fragColor = vec4(v, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_ADVECT = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uSrc;',
    'uniform sampler2D uVel;',
    'uniform float uSign;',
    'void main(){',
    '  vec2 v = texture(uVel, vUv).xy;',
    '  fragColor = vec4(texture(uSrc, clamp(vUv - uSign * v, 0.0, 1.0)).x, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // MacCormack: 前進 + 後退の誤差を打ち消しつつ、近傍値でクランプして振動を防ぐ
  var FRAG_MACCORMACK = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uD;',
    'uniform sampler2D uDF;',
    'uniform sampler2D uDB;',
    'uniform sampler2D uVel;',
    'uniform vec2 uSize;',
    'void main(){',
    '  vec2 v = texture(uVel, vUv).xy;',
    '  vec2 back = clamp(vUv - v, 0.0, 1.0);',
    '  vec2 st = back * uSize - 0.5;',
    '  vec2 base = (floor(st) + 0.5) / uSize;',
    '  vec2 tx = 1.0 / uSize;',
    '  float a = texture(uD, base).x;',
    '  float b = texture(uD, base + vec2(tx.x, 0.0)).x;',
    '  float c = texture(uD, base + vec2(0.0, tx.y)).x;',
    '  float d = texture(uD, base + tx).x;',
    '  float lo = min(min(a, b), min(c, d));',
    '  float hi = max(max(a, b), max(c, d));',
    '  float val = texture(uDF, vUv).x + 0.5 * (texture(uD, vUv).x - texture(uDB, vUv).x);',
    '  fragColor = vec4(clamp(val, lo, hi), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // --- 画面への描画 -------------------------------------------------------
  var FRAG_RENDER = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 fragColor;',
    'uniform sampler2D uDye;',
    'uniform vec2  uRes;',
    'uniform vec2  uDyeTexel;',
    'uniform float uTime;',
    'uniform float uSteam;',
    'uniform float uView;',
    'uniform vec2  uCenter;',
    'uniform float uMatcha;',
    'uniform vec2  uProps;',
    COMMON_GLSL,
    NOISE_GLSL,
    '',
    'float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }',
    'vec2  rot2(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }',
    '',
    'float sdSugar(vec2 p, vec2 c, float a, float s){ return sdBox(rot2(p - c, a), vec2(s)) - 0.016; }',
    '',
    'float sdSpoon(vec2 p, vec2 B, vec2 E){',
    '  vec2 ax = normalize(E - B);',
    '  vec2 q  = p - B;',
    '  vec2 e  = vec2(dot(q, vec2(-ax.y, ax.x)), dot(q, ax));',
    '  float bowl = (length(e / vec2(0.105, 0.150)) - 1.0) * 0.105;',
    '  vec2 A2 = B + ax * 0.09;',
    '  vec2 pa = p - A2, ba = E - A2;',
    '  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
    '  float stem = length(pa - ba * h) - mix(0.024, 0.046, h * h);',
    '  return min(bowl, stem);',
    '}',
    '',
    'float sdHandle(vec2 p){',
    '  float ring = abs(length(p - vec2(0.95, 0.0)) - 0.27) - 0.065;',
    '  return max(ring, 0.90 - p.x);',
    '}',
    '',
    'float dyeAt(vec2 p){ return texture(uDye, p / (2.0 * SIM_HALF) + 0.5).x; }',
    '',
    'const vec2  SUGAR_A  = vec2(-1.00, 0.74);',
    'const vec2  SUGAR_B  = vec2(-1.22, 0.42);',
    'const vec2  SPOON_B  = vec2( 0.44,-1.12);',
    'const vec2  SPOON_E  = vec2( 1.18,-0.58);',
    'const float SAUCER_R = 1.22;',
    '',
    'void main(){',
    '  vec2 sc = vUv * 2.0 - 1.0;',
    '  sc.x *= uRes.x / uRes.y;',
    '  vec2 p = sc * uView - uCenter;',
    '  float r = length(p);',
    '',
    '  vec3 col = vec3(0.0);',
    '',
    '  // 液面の内側では、机や小物の計算はまるごと要らない',
    '  if (r > CUP_R - 0.02){',
    '    vec2 sh = vec2(0.055, -0.055);',
    '    float lit = 0.80 + 0.30 * (-p.x * 0.35 + p.y * 0.45);',
    '',
    '    float grain = fbm(vec2(p.x * 1.1, p.y * 13.0));',
    '    float band  = fbm(vec2(p.x * 0.45 + 3.0, p.y * 0.45));',
    '    col = mix(vec3(0.140, 0.102, 0.080), vec3(0.083, 0.059, 0.047), grain * 0.9);',
    '    col *= 0.90 + band * 0.20;',
    '    vec2 lp = p - vec2(-1.1, 1.2);',
    '    col *= 0.70 + 0.46 * exp(-dot(lp, lp) / 6.0);',
    '',
    '    col *= 1.0 - smoothstep(0.11, -0.02, length(p - sh) - SAUCER_R) * 0.55;',
    '    float saucer = smoothstep(SAUCER_R, SAUCER_R - 0.014, r);',
    '    vec3 sauCol = vec3(0.885, 0.870, 0.848) * lit;',
    '    sauCol *= 1.0 - smoothstep(SAUCER_R - 0.10, SAUCER_R, r) * 0.20;',
    '    sauCol *= 1.0 - smoothstep(0.030, 0.0, abs(r - 1.03)) * 0.10;',
    '    col = mix(col, sauCol, saucer);',
    '',
    '    col *= 1.0 - smoothstep(0.065, -0.01, sdHandle(p - sh)) * 0.45;',
    '    {',
    '      float d = sdHandle(p);',
    '      vec3 c = vec3(0.955, 0.940, 0.918) * lit;',
    '      c *= 1.0 - smoothstep(-0.050, 0.0, d) * 0.28;',
    '      col = mix(col, c, smoothstep(0.005, -0.005, d));',
    '    }',
    '',
    '    if (uProps.y > 0.5){',
    '      float dsh = min(sdSugar(p - sh, SUGAR_A, 0.22, 0.096), sdSugar(p - sh, SUGAR_B, -0.38, 0.086));',
    '      col *= 1.0 - smoothstep(0.075, -0.01, dsh) * 0.55;',
    '      float d = min(sdSugar(p, SUGAR_A, 0.22, 0.096), sdSugar(p, SUGAR_B, -0.38, 0.086));',
    '      vec3 c = vec3(0.960, 0.945, 0.925) * (0.86 + fbm(p * 110.0) * 0.30);',
    '      c *= 1.0 - smoothstep(-0.028, 0.0, d) * 0.30;',
    '      col = mix(col, c, smoothstep(0.005, -0.005, d));',
    '    }',
    '',
    '    if (uProps.x > 0.5){',
    '      col *= 1.0 - smoothstep(0.070, -0.01, sdSpoon(p - sh, SPOON_B, SPOON_E)) * 0.50;',
    '      float d = sdSpoon(p, SPOON_B, SPOON_E);',
    '      float bev = smoothstep(-0.040, 0.0, d);',
    '      vec3 c = mix(vec3(0.880, 0.895, 0.925), vec3(0.400, 0.420, 0.475), bev);',
    '      c *= 0.72 + 0.60 * smoothstep(-0.9, 1.1, -p.x * 0.5 + p.y * 0.9);',
    '      col = mix(col, c, smoothstep(0.005, -0.005, d));',
    '    }',
    '',
    '    col *= 1.0 - smoothstep(0.075, -0.01, length(p - sh * 0.65) - 0.985) * 0.38;',
    '    col = mix(col, vec3(0.960, 0.945, 0.922) * lit, smoothstep(0.985, 0.972, r));',
    '    col *= 1.0 - smoothstep(0.80, 0.86, r) * (1.0 - smoothstep(0.86, 0.93, r)) * 0.35;',
    '  }',
    '',
    '  // ---- 液面 ----',
    '  float inside = smoothstep(CUP_R + 0.004, CUP_R - 0.004, r);',
    '  if (inside > 0.001){',
    '    float mk = clamp(dyeAt(p), 0.0, 1.0);',
    '    float n  = fbm(p * 9.0 + vec2(3.1, 7.7));',
    '    float nn = fbm(p * 26.0);',
    '    float rr = min(r / CUP_R, 1.0);',
    '    float dark = smoothstep(0.55, 1.0, rr);',
    '    vec3 baseLit  = mix(vec3(0.455, 0.255, 0.135), vec3(0.372, 0.478, 0.196), uMatcha);',
    '    vec3 baseDark = mix(vec3(0.235, 0.122, 0.065), vec3(0.170, 0.255, 0.098), uMatcha);',
    '    vec3 midCol   = mix(vec3(0.640, 0.452, 0.290), vec3(0.652, 0.729, 0.455), uMatcha);',
    '    vec3 crema = mix(baseLit, baseDark, dark) + (n - 0.5) * vec3(0.075, 0.050, 0.030);',
    '    vec3 foam  = vec3(0.965, 0.918, 0.828) + (n - 0.5) * vec3(0.04, 0.04, 0.05);',
    '    // 本物は白と茶がはっきり分かれる。中間の帯を狭くして縁を立てる',
    '    float k = smoothstep(0.30, 0.56, mk);',
    '    vec3 liq = mix(crema, foam, k);',
    '    float blend = 4.0 * mk * (1.0 - mk);',
    '    liq = mix(liq, midCol, blend * 0.32);',
    '',
    '    float e = 1.6;',
    '    vec2 t2 = uDyeTexel * 2.0 * SIM_HALF * e;',
    '    float hx = dyeAt(p + vec2(t2.x, 0.0)) - dyeAt(p - vec2(t2.x, 0.0));',
    '    float hy = dyeAt(p + vec2(0.0, t2.y)) - dyeAt(p - vec2(0.0, t2.y));',
    '    float lam = clamp(1.0 + (-hx * 1.2 + hy * 1.2) + (nn - 0.5) * 0.22, 0.55, 1.7);',
    '    liq *= lam;',
    '',
    '    vec2 hp = p - vec2(-0.30, 0.36);',
    '    liq += exp(-dot(hp, hp) / 0.10) * vec3(0.15, 0.146, 0.135);',
    '    liq *= 1.0 - smoothstep(0.86, 1.0, rr) * 0.45;',
    '    col = mix(col, liq, inside);',
    '  }',
    '',
    '  if (uSteam > 0.001){',
    '    float sn = fbm(vec2(p.x * 2.2, p.y * 1.5 - uTime * 0.16) + vec2(0.0, uTime * 0.05));',
    '    float sb = smoothstep(0.62, 1.05, p.y) * (1.0 - smoothstep(1.15, 1.85, p.y));',
    '    col += smoothstep(0.52, 0.86, sn) * sb * exp(-p.x * p.x / 0.26) * 0.20 * uSteam;',
    '  }',
    '',
    '  col *= 1.0 - smoothstep(1.15, 2.7, r) * 0.45;',
    '  col += (hash21(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.018;',
    '  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  // =======================================================================
  //  1 杯ぶんをつくる
  // =======================================================================
  function createCup(canvas) {
    var noteEl = canvas.parentNode.querySelector('.gl-note');

    function fail(msg) {
      if (noteEl) { noteEl.textContent = msg; noteEl.hidden = false; }
      canvas.style.display = 'none';
    }

    var gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) {
      fail('このブラウザでは WebGL2 が使えないため、カップを表示できませんでした。');
      return null;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      fail('浮動小数点テクスチャ（EXT_color_buffer_float）が使えないため、シミュレーションを実行できませんでした。');
      return null;
    }
    gl.getExtension('OES_texture_float_linear');

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        console.error('shader compile error:\n' + log + '\n---\n' +
          src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n'));
        throw new Error(log);
      }
      return s;
    }

    function Program(fragSrc) {
      var p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      this.p = p;
      this.u = {};
      var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var name = gl.getActiveUniform(p, i).name;
        this.u[name] = gl.getUniformLocation(p, name);
      }
    }
    Program.prototype.use = function () { gl.useProgram(this.p); return this; };

    function makeFBO(w, h, internal, format, type) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);

      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('framebuffer incomplete (' + w + 'x' + h + ')');
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        tex: tex, fbo: fbo, w: w, h: h, texel: [1 / w, 1 / h],
        bind: function (unit) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          return unit;
        }
      };
    }

    function makeDouble(w, h, internal, format, type) {
      var a = makeFBO(w, h, internal, format, type);
      var b = makeFBO(w, h, internal, format, type);
      return {
        w: w, h: h, texel: a.texel,
        get read() { return a; },
        get write() { return b; },
        swap: function () { var t = a; a = b; b = t; }
      };
    }

    var quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    function blit(target) {
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.w, target.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    var progStroke, progMask, progMaskPhoto, progPour, progVel, progDiv, progJacobi, progGrad, progAdvect, progMac, progRender;
    var vel, pressure, divergence, dye, dyeF, dyeB, mask;
    var ND = (canvas.clientWidth >= 380 ? CONF.ND : 512);

    try {
      progStroke = new Program(FRAG_STROKE);
      progMask   = new Program(FRAG_MASK);
      progMaskPhoto = new Program(FRAG_MASK_PHOTO);
      progPour   = new Program(FRAG_POUR);
      progVel    = new Program(FRAG_VEL);
      progDiv    = new Program(FRAG_DIV);
      progJacobi = new Program(FRAG_JACOBI);
      progGrad   = new Program(FRAG_GRAD);
      progAdvect = new Program(FRAG_ADVECT);
      progMac    = new Program(FRAG_MACCORMACK);
      progRender = new Program(FRAG_RENDER);

      var NV = CONF.NV;
      vel        = makeDouble(NV, NV, gl.RG16F, gl.RG, gl.HALF_FLOAT);
      pressure   = makeDouble(NV, NV, gl.R16F, gl.RED, gl.HALF_FLOAT);
      divergence = makeFBO(NV, NV, gl.R16F, gl.RED, gl.HALF_FLOAT);
      dye        = makeDouble(ND, ND, gl.R16F, gl.RED, gl.HALF_FLOAT);
      dyeF       = makeFBO(ND, ND, gl.R16F, gl.RED, gl.HALF_FLOAT);
      dyeB       = makeFBO(ND, ND, gl.R16F, gl.RED, gl.HALF_FLOAT);
      mask       = makeFBO(ND, ND, gl.R16F, gl.RED, gl.HALF_FLOAT);
    } catch (e) {
      console.error(e);
      fail('シェーダの初期化に失敗しました（詳細はブラウザのコンソールを見てください）: ' + e.message);
      return null;
    }

    var state = {
      pattern: parseInt(canvas.dataset.pattern || '0', 10),  // -1 = まっさら（自分で描く）
      hero:    canvas.dataset.hero === '1',
      matcha:  canvas.dataset.matcha === '1' ? 1 : 0,
      props:   [canvas.dataset.spoon === '1' ? 1 : 0, canvas.dataset.sugar === '1' ? 1 : 0],
      mode:    canvas.dataset.pattern === '-1' ? 'draw' : 'stir',
      photo:   false,   // true = 手描きの絵を模様として使っている
      brush:   0.055,
      view: 1.52,
      center: [0, 0],
      pourS: 0,
      pouring: false,
      armed: false,
      visible: true,
      time: 0,
      energy: 0,
      auto: null,
      pointer: { x: 0.5, y: 0.5, px: 0.5, py: 0.5, down: false, inside: false, moved: false }
    };

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      var w = Math.round(canvas.clientWidth * dpr);
      var h = Math.round(canvas.clientHeight * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      var aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
      // 見出しのカップだけは、横長のとき右へ寄せて左に文章を置く
      var wide = state.hero && canvas.clientWidth >= 900 && aspect > 1.15;
      // body.wide は見出しのカップだけが決める（他の杯が打ち消さないように）
      if (state.hero) document.body.classList.toggle('wide', wide);
      if (wide) {
        state.view = Math.max(1.52, CONF.NEED / Math.max(aspect * 0.60, 0.01));
        state.center = [aspect * state.view * 0.40, 0];
      } else {
        state.view = Math.max(1.52, CONF.NEED / Math.max(aspect, 0.30));
        state.center = [0, state.hero ? -0.02 : 0];
      }
    }

    function toSimUV(clientX, clientY) {
      var b = canvas.getBoundingClientRect();
      var sx = (clientX - b.left) / b.width * 2 - 1;
      var sy = -((clientY - b.top) / b.height * 2 - 1);
      sx *= b.width / b.height;
      var p = [sx * state.view - state.center[0], sy * state.view - state.center[1]];
      return [p[0] / (2 * CONF.SIM_HALF) + 0.5, p[1] / (2 * CONF.SIM_HALF) + 0.5];
    }

    function clearVelocity() {
      [vel.read, vel.write, pressure.read, pressure.write].forEach(function (f) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.viewport(0, 0, f.w, f.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
    }

    function clearDye() {
      [dye.read, dye.write].forEach(function (f) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.viewport(0, 0, f.w, f.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
    }

    // 注ぎ／指描き、共通の 1 ストローク
    function stroke(p0, p1, r, push, ink, jit, dragK) {
      progStroke.use();
      gl.uniform1i(progStroke.u.uSrc, dye.read.bind(0));
      gl.uniform2fv(progStroke.u.uP0, p0);
      gl.uniform2fv(progStroke.u.uP1, p1);
      gl.uniform2f(progStroke.u.uDrag, (p1[0] - p0[0]) * dragK, (p1[1] - p0[1]) * dragK);
      gl.uniform1f(progStroke.u.uR, r);
      gl.uniform1f(progStroke.u.uPush, push);
      gl.uniform1f(progStroke.u.uInk, ink);
      gl.uniform1f(progStroke.u.uJit, jit);
      blit(dye.write);
      dye.swap();
    }

    // 手描きの絵の置き場。カップごとに WebGL の文脈が別なので、杯ごとに持ちます。
    var photoTex = null;

    function uploadPhoto(src) {
      if (!photoTex) {
        photoTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, photoTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.bindTexture(gl.TEXTURE_2D, photoTex);
      // canvas の上下と uv の上下は逆なので、ここで裏返します
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    // 模様を一度だけテクスチャに焼く
    function drawMask() {
      if (state.photo && photoTex) {
        progMaskPhoto.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, photoTex);
        gl.uniform1i(progMaskPhoto.u.uPhoto, 0);
        blit(mask);
        return;
      }
      progMask.use();
      gl.uniform1i(progMask.u.uPattern, state.pattern);
      gl.uniform1f(progMask.u.uCell, (2 * CONF.SIM_HALF) / mask.w);
      blit(mask);
    }

    // 焼いた模様を上から下へ現していく
    function drawPour(amount) {
      progPour.use();
      gl.uniform1i(progPour.u.uMask, mask.bind(0));
      gl.uniform1f(progPour.u.uPour, amount);
      blit(dye.write);
      dye.swap();
    }

    function restart() {
      state.auto = null;
      state.energy = 0;
      clearVelocity();
      clearDye();
      if (state.pattern < 0 && !state.photo) { state.pouring = false; state.pourS = 1; return; }
      state.pourS = 0;
      state.pouring = true;
      drawMask();
      drawPour(0);
    }

    function stirInput() {
      var pt = state.pointer;
      var strength = 0;
      if (pt.inside && pt.moved) strength = (pt.down ? CONF.DRAG : CONF.HOVER) * shared.strength;
      if (state.auto) strength = CONF.DRAG * shared.strength;

      var dx = pt.x - pt.px, dy = pt.y - pt.py;
      var len = Math.hypot(dx, dy), MAXD = 0.05;
      if (len > MAXD) { dx *= MAXD / len; dy *= MAXD / len; }
      if (len < 1e-5) strength = 0;

      return { s: strength, p0: [pt.px, pt.py], p1: [pt.px + dx, pt.py + dy] };
    }

    function simulate(stir) {
      progVel.use();
      gl.uniform1i(progVel.u.uVel, vel.read.bind(0));
      gl.uniform2fv(progVel.u.uTexel, vel.texel);
      gl.uniform2fv(progVel.u.uP0, stir.p0);
      gl.uniform2fv(progVel.u.uP1, stir.p1);
      gl.uniform1f(progVel.u.uStrength, stir.s);
      gl.uniform1f(progVel.u.uRadius, CONF.RADIUS);
      gl.uniform1f(progVel.u.uDecay, stir.s > 0 ? CONF.DECAY : CONF.DECAY_IDLE);
      gl.uniform1f(progVel.u.uVisc, shared.visc);
      blit(vel.write); vel.swap();

      progDiv.use();
      gl.uniform1i(progDiv.u.uVel, vel.read.bind(0));
      gl.uniform2fv(progDiv.u.uTexel, vel.texel);
      blit(divergence);

      gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.read.fbo);
      gl.viewport(0, 0, pressure.w, pressure.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      progJacobi.use();
      gl.uniform2fv(progJacobi.u.uTexel, pressure.texel);
      gl.uniform1i(progJacobi.u.uDivergence, divergence.bind(1));
      for (var i = 0; i < CONF.ITERS; i++) {
        gl.uniform1i(progJacobi.u.uPressure, pressure.read.bind(0));
        blit(pressure.write); pressure.swap();
      }

      progGrad.use();
      gl.uniform2fv(progGrad.u.uTexel, vel.texel);
      gl.uniform1i(progGrad.u.uPressure, pressure.read.bind(0));
      gl.uniform1i(progGrad.u.uVel, vel.read.bind(1));
      blit(vel.write); vel.swap();

      progAdvect.use();
      gl.uniform1i(progAdvect.u.uVel, vel.read.bind(1));
      gl.uniform1f(progAdvect.u.uSign, 1.0);
      gl.uniform1i(progAdvect.u.uSrc, dye.read.bind(0));
      blit(dyeF);
      gl.uniform1f(progAdvect.u.uSign, -1.0);
      gl.uniform1i(progAdvect.u.uSrc, dyeF.bind(0));
      blit(dyeB);

      progMac.use();
      gl.uniform2f(progMac.u.uSize, dye.w, dye.h);
      gl.uniform1i(progMac.u.uD, dye.read.bind(0));
      gl.uniform1i(progMac.u.uDF, dyeF.bind(1));
      gl.uniform1i(progMac.u.uDB, dyeB.bind(2));
      gl.uniform1i(progMac.u.uVel, vel.read.bind(3));
      blit(dye.write); dye.swap();
    }

    function draw() {
      progRender.use();
      gl.uniform1i(progRender.u.uDye, dye.read.bind(0));
      gl.uniform2f(progRender.u.uRes, canvas.width, canvas.height);
      gl.uniform2fv(progRender.u.uDyeTexel, dye.texel);
      gl.uniform1f(progRender.u.uTime, state.time);
      gl.uniform1f(progRender.u.uSteam, shared.steam);
      gl.uniform1f(progRender.u.uView, state.view);
      gl.uniform2fv(progRender.u.uCenter, state.center);
      gl.uniform1f(progRender.u.uMatcha, state.matcha);
      gl.uniform2fv(progRender.u.uProps, state.props);
      blit(null);
    }

    function tick(dt) {
      if (!state.visible) return;
      state.time += dt;
      resize();

      if (state.auto) {
        state.auto.t += dt;
        var ang = state.auto.t * 5.0;
        var rad = 0.10 + state.auto.t * 0.035;
        state.pointer.px = state.pointer.x;
        state.pointer.py = state.pointer.y;
        state.pointer.x = 0.5 + Math.cos(ang) * rad;
        state.pointer.y = 0.5 + Math.sin(ang) * rad;
        if (state.auto.t > state.auto.dur) state.auto = null;
      }

      if (state.pouring) {
        state.pourS = Math.min(1, state.pourS + dt / CONF.POUR_SEC);
        drawPour(state.pourS);
        if (state.pourS >= 1) state.pouring = false;
        clearVelocity();
      } else if (state.mode !== 'stir') {
        // 指で描く／消す
        var pt = state.pointer;
        if (pt.down && pt.moved) {
          var rb = state.brush / (2 * CONF.SIM_HALF);
          stroke([pt.px, pt.py], [pt.x, pt.y], rb, 0.0022,
                 state.mode === 'erase' ? -1 : 1, 0.25, 0.30);
        }
      } else {
        var stir = stirInput();
        if (stir.s > 0) state.energy = CONF.SETTLE;
        if (state.energy > 0) {
          simulate(stir);
          state.energy = Math.max(0, state.energy - dt);
        }
      }

      draw();

      state.pointer.px = state.pointer.x;
      state.pointer.py = state.pointer.y;
      state.pointer.moved = false;
    }

    canvas.addEventListener('pointermove', function (e) {
      var uv = toSimUV(e.clientX, e.clientY);
      state.pointer.x = uv[0];
      state.pointer.y = uv[1];
      state.pointer.moved = true;
      state.pointer.inside = true;
    });
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      state.pointer.down = true;
      var uv = toSimUV(e.clientX, e.clientY);
      state.pointer.px = state.pointer.x = uv[0];
      state.pointer.py = state.pointer.y = uv[1];
      canvas.classList.add('stirring');
    });
    window.addEventListener('pointerup', function () {
      state.pointer.down = false;
      canvas.classList.remove('stirring');
    });
    canvas.addEventListener('pointerleave', function () { state.pointer.inside = false; });
    canvas.addEventListener('pointerenter', function () { state.pointer.inside = true; });
    canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

    resize();

    return {
      canvas: canvas,
      state: state,
      tick: tick,
      restart: restart,
      setPattern: function (id) { state.pattern = id; restart(); },
      // src は「ミルクの濃さ」だけにした正方形の canvas か img
      setPhoto: function (src) { uploadPhoto(src); state.photo = true; restart(); },
      clearPhoto: function () { state.photo = false; restart(); },
      setMode: function (m) { state.mode = m; canvas.dataset.mode = m; },
      setBrush: function (b) { state.brush = b; },
      arm: function () {
        if (state.armed) return;
        state.armed = true;
        restart();
      },
      spoon: function () {
        if (state.pouring) return;
        state.mode = 'stir';
        state.auto = { t: 0, dur: 2.2 };
        state.pointer.inside = true;
      },
      setVisible: function (v) { state.visible = v; }
    };
  }

  // =======================================================================
  //  起動
  // =======================================================================
  var cups = [];
  var canvases = document.querySelectorAll('canvas[data-cup]');
  for (var i = 0; i < canvases.length; i++) {
    var cup = createCup(canvases[i]);
    if (cup) cups.push(cup);
  }
  if (!cups.length) return;

  function cupOf(el) {
    var cv = el.querySelector('canvas[data-cup]');
    for (var k = 0; k < cups.length; k++) if (cups[k].canvas === cv) return cups[k];
    return null;
  }

  // 画面に入ったら注ぎはじめる／出たら描画も止める
  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        for (var k = 0; k < cups.length; k++) {
          if (cups[k].canvas !== en.target) continue;
          cups[k].setVisible(en.isIntersecting);
          if (en.isIntersecting) cups[k].arm();
        }
      });
    }, { rootMargin: '140px 0px' });
    cups.forEach(function (c) { io.observe(c.canvas); });
  } else {
    cups.forEach(function (c) { c.arm(); });
  }

  var last = performance.now();
  function frame(now) {
    var dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!document.hidden) {
      for (var k = 0; k < cups.length; k++) cups[k].tick(dt);
    }
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) last = performance.now();
  });
  requestAnimationFrame(frame);

  // ---- カップごとのボタン -------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('[data-cupbox]'), function (box) {
    var cup = cupOf(box);
    if (!cup) return;

    Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.dataset.act;
        if (act === 'reset') cup.restart();
        else if (act === 'spoon') cup.spoon();
        // 「まっさらにする」は、指で描いた跡も入れた画像も両方消します
        else if (act === 'clear') { cup.state.pattern = -1; cup.clearPhoto(); }
      });
    });

    // 模様の切り替え（見出しのカップだけ）
    var pats = box.querySelectorAll('[data-pat]');
    Array.prototype.forEach.call(pats, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(pats, function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        cup.setPattern(parseInt(btn.dataset.pat, 10));
      });
    });

    // 描く／消す／崩す
    var modes = box.querySelectorAll('[data-mode]');
    Array.prototype.forEach.call(modes, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(modes, function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        cup.setMode(btn.dataset.mode);
      });
    });

    var brush = box.querySelector('[data-brush]');
    if (brush) {
      var applyB = function () { cup.setBrush(parseFloat(brush.value)); };
      brush.addEventListener('input', applyB);
      applyB();
    }
  });

  // =======================================================================
  //  手描きの絵を「注ぐための型」に変換する
  //  -----------------------------------------------------------------------
  //  やっていることは 3 つだけです。
  //    1. どこが絵で、どこが紙かを分ける（大津の二値化）
  //    2. 絵のある四角を切り出す（写真の余白を捨てる）
  //    3. カップの内側いっぱいに置き直す
  //  透明のある PNG は、透明度をそのまま絵の濃さとして使います。
  // =======================================================================
  var MASK_PX = 768;

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = -1, thr = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  function buildMask(img, flip) {
    var sw = img.naturalWidth || img.width;
    var sh = img.naturalHeight || img.height;
    if (!sw || !sh) return { err: '画像を読み込めませんでした。' };

    var k = Math.min(1, 900 / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * k));
    var h = Math.max(1, Math.round(sh * k));

    var src = document.createElement('canvas');
    src.width = w; src.height = h;
    var sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, w, h);

    var data;
    try { data = sctx.getImageData(0, 0, w, h).data; }
    catch (e) { return { err: 'この画像は読み取れませんでした。' }; }

    var n = w * h, i, j, x, y;

    // 透明があるか
    var minA = 255;
    for (i = 3; i < data.length; i += 4) { if (data[i] < minA) { minA = data[i]; if (minA === 0) break; } }

    var cov = new Float32Array(n);
    if (minA < 240) {
      for (j = 0; j < n; j++) cov[j] = data[j * 4 + 3] / 255;
    } else {
      var lum = new Uint8Array(n), hist = new Uint32Array(256);
      for (j = 0; j < n; j++) {
        var g = (data[j * 4] * 299 + data[j * 4 + 1] * 587 + data[j * 4 + 2] * 114) / 1000 | 0;
        lum[j] = g; hist[g]++;
      }
      var thr = otsu(hist, n);

      // 画像のふちを「紙」とみなす。紙の反対側が絵です。
      var bs = 0, bn = 0;
      for (x = 0; x < w; x++) { bs += lum[x] + lum[(h - 1) * w + x]; bn += 2; }
      for (y = 0; y < h; y++) { bs += lum[y * w] + lum[y * w + w - 1]; bn += 2; }
      var paperIsDark = (bs / bn) < thr;

      var soft = 14;   // 境目をこの階調ぶんだけぼかす
      for (j = 0; j < n; j++) {
        var t = (thr - lum[j]) / soft;
        if (paperIsDark) t = -t;
        cov[j] = Math.min(1, Math.max(0, t * 0.5 + 0.5));
      }
    }
    if (flip) { for (j = 0; j < n; j++) cov[j] = 1 - cov[j]; }

    // 絵のある四角と、絵の量
    var minx = w, miny = h, maxx = -1, maxy = -1, ink = 0;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var c = cov[y * w + x];
        ink += c;
        if (c > 0.5) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    var frac = ink / n;
    if (maxx < 0 || frac < 0.002) return { err: '絵が見つかりませんでした。「白と黒が逆のときはここ」を試してみてください。' };
    if (frac > 0.93) return { err: 'ほとんど塗りつぶしに見えます。「白と黒が逆のときはここ」を試してみてください。' };

    var bw = maxx - minx + 1, bh = maxy - miny + 1;

    // 濃さを白黒の画像に戻す
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    var tctx = tmp.getContext('2d');
    var id = tctx.createImageData(w, h);
    for (j = 0; j < n; j++) {
      var v = Math.round(cov[j] * 255);
      id.data[j * 4] = v; id.data[j * 4 + 1] = v; id.data[j * 4 + 2] = v; id.data[j * 4 + 3] = 255;
    }
    tctx.putImageData(id, 0, 0);

    // カップの内側いっぱい（直径の 86%）に収まるよう、中央へ置き直す
    var S = MASK_PX;
    var out = document.createElement('canvas');
    out.width = S; out.height = S;
    var octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, S, S);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';

    var cupD = (CONF.CUP_R / CONF.SIM_HALF) * S;   // カップの直径（ピクセル）
    var box  = cupD * 0.86;
    var s    = Math.min(box / bw, box / bh);
    var dw   = bw * s, dh = bh * s;
    octx.drawImage(tmp, minx, miny, bw, bh, (S - dw) / 2, (S - dh) / 2, dw, dh);

    return { canvas: out };
  }

  // ---- 貼った絵を覚えておく（この端末のブラウザの中だけ）------------------
  var STORE = 'latte-art-breaker/drawing/';
  function saveSlot(slot, cv) {
    try {
      var small = document.createElement('canvas');
      small.width = small.height = 384;
      small.getContext('2d').drawImage(cv, 0, 0, 384, 384);
      localStorage.setItem(STORE + slot, small.toDataURL('image/png'));
    } catch (e) { /* 保存できなくても、そのときの表示には影響しません */ }
  }
  function loadSlot(slot) { try { return localStorage.getItem(STORE + slot); } catch (e) { return null; } }
  function dropSlot(slot) { try { localStorage.removeItem(STORE + slot); } catch (e) {} }

  // ---- 絵を貼る操作 -------------------------------------------------------
  var slotCups = {}, slotShow = {};

  function applySlot(slot, src) {
    var list = slotCups[slot] || [];
    for (var i = 0; i < list.length; i++) list[i].setPhoto(src);
  }
  function resetSlot(slot) {
    var list = slotCups[slot] || [];
    for (var i = 0; i < list.length; i++) list[i].clearPhoto();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-cupbox]'), function (box) {
    var cup = cupOf(box);
    var slot = box.dataset.slot;
    if (!cup || !slot) return;
    (slotCups[slot] = slotCups[slot] || []).push(cup);

    var input = box.querySelector('[data-photo]');
    if (!input) return;   // 見出しのカップのように、操作を持たない杯

    var flipEl = box.querySelector('[data-photo-invert]');
    var undo   = box.querySelector('[data-act="unphoto"]');
    var note   = box.querySelector('[data-photo-note]');
    var help   = note ? note.textContent : '';
    var last   = null;    // 直近に選んだ画像（反転のやり直し用に持っておく）

    function say(msg, kind) {
      if (!note) return;
      note.textContent = msg || help;
      if (kind) note.setAttribute('data-state', kind);
      else note.removeAttribute('data-state');
    }

    slotShow[slot] = function () { if (undo) undo.hidden = false; };

    function run() {
      if (!last) return;
      var r = buildMask(last, !!(flipEl && flipEl.checked));
      if (r.err) { say(r.err, 'err'); return; }
      applySlot(slot, r.canvas);
      saveSlot(slot, r.canvas);
      if (undo) undo.hidden = false;
      say('あなたの絵を注ぎました。カップの上をなぞると崩せます。', 'ok');
    }

    function take(file) {
      if (!file || String(file.type).indexOf('image/') !== 0) {
        say('画像のファイルをえらんでください。', 'err');
        return;
      }
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload  = function () { URL.revokeObjectURL(url); last = im; run(); };
      im.onerror = function () { URL.revokeObjectURL(url); say('この形式は開けませんでした。PNG か JPEG でお願いします。', 'err'); };
      im.src = url;
    }

    // 入れた画像を忘れる（表示を戻すのは呼ぶ側の仕事）
    function forget() {
      last = null;
      if (flipEl) flipEl.checked = false;
      input.value = '';
      dropSlot(slot);
      if (undo) undo.hidden = true;
      say('');
    }

    input.addEventListener('change', function () {
      if (input.files && input.files[0]) take(input.files[0]);
    });
    if (flipEl) flipEl.addEventListener('change', run);
    if (undo) undo.addEventListener('click', function () { forget(); resetSlot(slot); });

    // 「まっさらにする」を持つ杯では、そのボタンが入れた画像も消します
    var clearBtn = box.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.addEventListener('click', forget);

    // カップの上へ絵をドラッグしても入ります
    var dropEl = box.querySelector('.stage__cup') || box;
    ['dragenter', 'dragover'].forEach(function (t) {
      dropEl.addEventListener(t, function (e) { e.preventDefault(); dropEl.classList.add('drop'); });
    });
    ['dragleave', 'dragend'].forEach(function (t) {
      dropEl.addEventListener(t, function () { dropEl.classList.remove('drop'); });
    });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      dropEl.classList.remove('drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) take(e.dataTransfer.files[0]);
    });
  });

  // =======================================================================
  //  同梱の絵を、既定のラテアートとして使う
  //  -----------------------------------------------------------------------
  //  canvas に data-art="…png" があれば、その画像をその杯の模様にします。
  //  画像は「ミルクの濃さだけの正方形（白＝ミルク／黒＝コーヒー）」に
  //  仕上げたものを置いてください。読み込みに失敗したときは、
  //  data-pattern の組み込み図形がそのまま残ります。
  // =======================================================================
  (function bakedArt() {
    var byUrl = {};
    Array.prototype.forEach.call(document.querySelectorAll('canvas[data-cup][data-art]'), function (cv) {
      var url = cv.dataset.art;
      if (!url) return;
      for (var i = 0; i < cups.length; i++) {
        if (cups[i].canvas === cv) { (byUrl[url] = byUrl[url] || []).push(cups[i]); break; }
      }
    });
    Object.keys(byUrl).forEach(function (url) {
      var im = new Image();
      im.onload = function () {
        byUrl[url].forEach(function (c) { c.setPhoto(im); });
      };
      im.onerror = function () {
        console.warn('data-art を読み込めませんでした: ' + url + '（組み込みの模様のままにします）');
      };
      im.src = url;
    });
  })();

  // 前に貼った絵があれば、そのまま出す
  Object.keys(slotCups).forEach(function (slot) {
    var saved = loadSlot(slot);
    if (!saved) return;
    var im = new Image();
    im.onload = function () {
      applySlot(slot, im);
      if (slotShow[slot]) slotShow[slot]();
    };
    im.src = saved;
  });

  // ---- スライダーの塗り分け ----------------------------------------------
  // つまみが左から何 % のところにあるかを CSS 変数 --p に入れます。
  // style.css はこれを使って、通った跡だけを色で塗ります。
  (function paintRanges() {
    function paint(el) {
      var lo = parseFloat(el.min), hi = parseFloat(el.max), v = parseFloat(el.value);
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo || !isFinite(v)) return;
      el.style.setProperty('--p', ((v - lo) / (hi - lo) * 100).toFixed(2));
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[type="range"]'), function (el) {
      paint(el);
      el.addEventListener('input', function () { paint(el); });
    });
  })();

  // ---- 共通のつまみ -------------------------------------------------------
  function bindRange(id, outId, apply) {
    var el = document.getElementById(id);
    var out = document.getElementById(outId);
    if (!el) return;
    var run = function () {
      apply(parseFloat(el.value));
      if (out) out.textContent = el.value;
    };
    el.addEventListener('input', run);
    run();
  }

  bindRange('rng-strength', 'out-strength', function (v) { shared.strength = v; });
  bindRange('rng-visc', 'out-visc', function (v) { shared.visc = v; });

  var steam = document.getElementById('chk-steam');
  if (steam) {
    var applySteam = function () { shared.steam = steam.checked ? 1 : 0; };
    steam.addEventListener('change', applySteam);
    applySteam();
  }

  // ---- BGM ---------------------------------------------------------------
  // 音声つきの自動再生はブラウザが止めるため、必ずボタンを押してから鳴らす
  (function bindBgm() {
    var audio = document.getElementById('bgm');
    var btn   = document.getElementById('btn-bgm');
    if (!audio || !btn) return;

    var host  = btn.closest ? btn.closest('.jazz') : btn.parentNode;
    var title = btn.querySelector('[data-bgm-title]');
    var sub   = btn.querySelector('[data-bgm-sub]');

    audio.volume = 0.35;

    // ラッパの中の文字だけ差し替える（SVG は消さない）
    function say(t, u) {
      if (title) title.textContent = t;
      if (sub)   sub.textContent   = u;
    }
    function off(t, u) {
      btn.setAttribute('aria-pressed', 'false');
      say(t || 'いい感じのジャズ流しますか？', u || '押すと流れます');
    }
    function on() {
      btn.setAttribute('aria-pressed', 'true');
      say('ジャズをお楽しみください〜♪', 'もう一度押すと止まります');
    }

    // ここに来る前に読み込みが終わっていることがあるので、状態も直接見る
    function reveal() { if (!audio.error && host) host.hidden = false; }
    if (audio.readyState >= 1) reveal();
    audio.addEventListener('loadedmetadata', reveal);
    audio.addEventListener('canplay', reveal);
    audio.addEventListener('ended', function () { off(); });
    audio.addEventListener('pause', function () {
      if (btn.getAttribute('aria-pressed') === 'true') off();
    });
    // 音源が無い環境では、蓄音機ごと出しません
    audio.addEventListener('error', function () { if (host) host.hidden = true; });

    btn.addEventListener('click', function () {
      if (audio.paused) {
        var r = audio.play();
        if (r && r.then) {
          r.then(on).catch(function () {
            off('いまは鳴らせませんでした', 'ブラウザが再生を止めたようです もう一度どうぞ');
          });
        } else {
          on();
        }
      } else {
        audio.pause();
        off();
      }
    });
  })();

  window.LatteArt = { conf: CONF, shared: shared, cups: cups, buildMask: buildMask };
})();
