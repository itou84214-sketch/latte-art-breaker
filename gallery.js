/* =========================================================================
   みんなのラテアート — 机の上を流れていく席
   -------------------------------------------------------------------------
   見た目の狙い
     区切りの無い 1 枚の机に、カップが無造作に置かれていて、ゆっくり
     流れていきます。カップの上をなぞると、その場で崩れます。
     みんなの作品ページは 3 段。2 段目だけ左から右へ流れます。
     段はそれぞれ別の机として動きます。1 段をつかんで払っても、
     ほかの段はそのまま流れ続けます。

   作りの都合
     ブラウザが同時に持てる WebGL は 16 個まで（実測）。17 個目を作ると
     いちばん古いものが黙って壊されます。そこで使う数を決め打ちし、
     端から出ていった席に次の作品を注ぎ直して回します。
     作品が何百件に増えても重さは変わりません。

   いいねは、押したものを localStorage に覚えて二度押しを防いでいます。
   端末側の記録なので、消せばまた押せます。厳密な一人一票ではありません。
   ========================================================================= */
(function () {
  'use strict';

  var API   = (window.LATTE_API || '').replace(/[/]+$/, '');
  var LIKED = 'latte-art-breaker/liked';
  var MINE  = 'latte-art-breaker/posted';

  // この区画は gallery.html にも index.html にも置けます
  var desk = document.querySelector('[data-desk]');
  if (!desk) return;
  var band = desk.querySelector('[data-band]');
  var msg  = desk.querySelector('[data-msg]');
  var hint = document.querySelector('[data-hint]');
  if (!band || !msg) return;

  function fail(text) {
    msg.textContent = text;
    msg.setAttribute('data-state', 'err');
    msg.hidden = false;
  }

  if (!API) {
    fail('投稿の置き場がまだ設定されていません（config.js の LATTE_API）。');
    return;
  }
  if (!window.LatteArt || !window.LatteArt.addCup) {
    fail('このブラウザではカップを表示できませんでした。');
    return;
  }

  // ---- 端末に覚えていること ---------------------------------------------
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); }
    catch (e) { return []; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }
  function isLiked(id) { return load(LIKED).indexOf(id) >= 0; }
  function setLiked(id, on) {
    var a = load(LIKED).filter(function (x) { return x !== id; });
    if (on) a.push(id);
    save(LIKED, a.slice(-500));
  }
  function myToken(id) {
    var hit = load(MINE).filter(function (p) { return p.id === id; })[0];
    return hit ? hit.token : null;
  }
  function forgetPost(id) {
    save(MINE, load(MINE).filter(function (p) { return p.id !== id; }));
  }

  // ---- 段と枠の数 ---------------------------------------------------------
  //  ブラウザが同時に持てる WebGL は 16 個まで（このページで実測）。
  //  17 個目を作ると、いちばん古いものが黙って壊されます。
  //  1 つ余らせて 15 個までにし、段ごとに割り振ります。
  //   data-lanes  何段にするか（みんなの作品ページは 3、トップは 1）
  //   data-seats  トップのように杯が先にいるページで、使う数を抑える
  var CAP   = parseInt(desk.dataset.seats || '0', 10) || 0;
  var LANES = Math.max(1, parseInt(desk.dataset.lanes || '1', 10) || 1);

  var SCALE = [1, 1.5, 1, 1, 1];  // 2 段目だけ 1.5 倍
  var PAD   = 14;    // 杯と杯のあいだ。ここを広げると机が空いて見えます
  var VGAP  = 10;    // 段と段のあいだ（style.css の gap と合わせる）
  var FOOT  = 36;    // 杯の下（ハートの帯とそのすき間）
  var TILT  = 1.037; // 2 度ほど傾けるので、席の箱がこれだけ縦に広がる

  // 無造作に置いた感じを出すための、下へのずらし。
  // 傾けたぶん杯の角が上に出るので、その逃げを先に取ります。
  // 逃げは杯の大きさに比例します（杯 191px で 3.5px、338px で 6.2px）。
  // 固定の 6px にしていたころは、トップの帯（杯 338px）で 1.1px 切れていました。
  function liftBase(cup) { return Math.ceil(cup * 0.0183) + 2; }
  function liftOf(cup, i) { return liftBase(cup) + ((i * 37) % 4) * 2; }
  function laneH(cup) { return Math.round(cup * TILT + liftBase(cup) + 6 + FOOT); }

  function layout() {
    var vw = Math.max(document.documentElement.clientWidth, 320);
    var vh = Math.max(document.documentElement.clientHeight, 420);
    var narrow = vw < 700;
    var budget = narrow ? 9 : 15;         // この机で使う WebGL の数
    if (CAP) budget = Math.min(budget, CAP);
    var lanes = Math.max(1, Math.min(LANES, Math.floor(budget / 3)));
    var i;

    // 1 段のとき（トップページ）は、これまでどおり画面幅から決めます
    if (lanes === 1) {
      var s1 = Math.max(narrow ? 200 : 272, Math.ceil(vw / (budget - 1)) + 1);
      s1 = Math.min(narrow ? 240 : 360, s1);
      var run = budget * s1;
      var fills = run - s1 >= vw;
      return { lanes: 1, cup: [s1 - 20], slot: [s1], seats: [budget],
               width: [fills ? 0 : run - s1], laneh: [laneH(s1 - 20)], trays: false };
    }

    // 杯の大きさは縦から決まります。段を積むので、ここがいちばんきついところ。
    // 2 段目を 1.5 倍にすると、ほかの段はそのぶん小さくなります。
    var room = vh * 0.90 - (lanes - 1) * VGAP;
    var sum = 0;
    // 1.0553 ＝ 傾きの広がり 1.037 ＋ 逃げのぶん 0.0183
    for (i = 0; i < lanes; i++) sum += SCALE[i] * 1.0553;
    var c = Math.floor((room - lanes * (8 + FOOT)) / sum);
    c = Math.max(110, Math.min(c, 260));

    var cup = [], slot = [];
    for (i = 0; i < lanes; i++) {
      cup[i]  = Math.round(c * SCALE[i]);
      slot[i] = cup[i] + PAD;
    }

    // 段の長さは「席が埋めきれるところまで」にします。
    // 席の数は WebGL の持ち分で決まるので、長さもそれで決まります。
    // 画面幅まで届かないぶんは、段を短くして中央に寄せます
    // （段を広げて席を散らすと、杯のあいだが空いて見えます。
    //   以前は 1 枠 476px に杯 189px で、6 割が空きでした）。
    var W = 0;
    for (var w = Math.min(vw, 2400); w >= 200; w -= 2) {
      var tot = 0;
      for (i = 0; i < lanes; i++) tot += Math.ceil(w / slot[i]) + 1;
      if (tot <= budget) { W = w; break; }
    }
    if (!W) W = 200;

    var seats = [], laneh = [], width = [];
    for (i = 0; i < lanes; i++) {
      seats[i] = Math.ceil(W / slot[i]) + 1;
      laneh[i] = laneH(cup[i]);
      width[i] = W >= vw ? 0 : W;         // 0 = 画面いっぱい
    }
    return { lanes: lanes, cup: cup, slot: slot, seats: seats,
             width: width, laneh: laneh, trays: true };
  }

  function when(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return 'いつか';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // ---- 机をこしらえる -----------------------------------------------------
  var posts = [];
  var seats = [];         // 全部の段の席をまとめたもの（ハートの塗り直しなどで使う）
  var lanes = [];         // { el, dir, seats, total }
  var SLOT = 0;
  var still = false;      // 動きを控える設定のときだけ、ひとりでには流さない

  // 出す順番は「袋から引いて戻さない」方式です。
  // ひと回りするあいだ、同じ作品は 1 回だけ出ます。袋が空いたら混ぜ直します。
  // 引くときは、いま机に出ているものを避けます。
  // 作品より席のほうが多いときは避けきれないので、そのときは袋の順に従います
  // （同じ作品どうしが、いちばん離れた順番になります）。
  var bag = [];
  function refill() {
    bag = posts.slice();
    for (var i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
  }
  function countOn(id) {
    var n = 0;
    for (var i = 0; i < seats.length; i++) {
      if (seats[i].post && seats[i].post.id === id) n++;
    }
    return n;
  }
  var recent = [];        // 直前に出した作品（袋の継ぎ目で繰り返さないため）
  function pickPost() {
    if (!posts.length) return null;
    if (!bag.length) refill();

    // いま机に出ている数がいちばん少ないものを候補にします。
    // 作品が席より多ければ、候補は「出ていないもの」になります。
    var min = Infinity, i;
    for (i = 0; i < bag.length; i++) min = Math.min(min, countOn(bag[i].id));
    var cand = [];
    for (i = 0; i < bag.length; i++) if (countOn(bag[i].id) === min) cand.push(i);

    // 直前に出したものは、ほかに選べるなら避けます。
    // 袋が空いて混ぜ直した直後、同じ作品が続けて出ることがあったためです。
    var fresh = [];
    for (i = 0; i < cand.length; i++) {
      if (recent.indexOf(bag[cand[i]].id) < 0) fresh.push(cand[i]);
    }
    var pool = fresh.length ? fresh : cand;

    // 袋はすでに混ぜてあるので、候補の先頭で足ります（順番はでたらめです）
    var p = bag.splice(pool[0], 1)[0];
    recent.push(p.id);
    if (recent.length > 3) recent.shift();
    return p;
  }

  function makeSeat(i, laneEl) {
    var el = document.createElement('div');
    el.className = 'seat';
    // 机に無造作に置かれた感じを出すための、席ごとのばらつき
    // 下へずらすだけにします。上へ持ち上げると段の縁で切れてしまいます。
    // 5px から始めるのは、杯を 2 度ほど傾けてあるぶん角が上に出るためです。
    // ずらしの幅は段の高さにそのまま乗るので、5〜11px に抑えています。
    el.style.setProperty('--tilt', ((((i * 53) % 7) - 3) * 0.7).toFixed(2) + 'deg');

    el.innerHTML =
      '<div class="seat__cup">' +
        // data-zoom で寄ります。絵は枠の 53% → 78% になります。
        // 角砂糖と匙は枠の外（半径 1.2 より先）なので置きません。
        // 置くと角で欠けて見えます。
        '<canvas data-cup data-pattern="-1" data-zoom="1.02"' +
                ' data-spoon="0" data-sugar="0"' +
                ' aria-label="だれかのラテアート。なぞると崩れます。"></canvas>' +
        '<p class="gl-note" hidden></p>' +
      '</div>' +
      '<div class="seat__foot">' +
        '<button type="button" class="heart" aria-pressed="false">' +
          '<span class="heart__mark" aria-hidden="true">♥</span>' +
          '<span class="heart__n">0</span>' +
          '<span class="vh">この一杯にハートを送る</span>' +
        '</button>' +
        '<span class="seat__when"></span>' +
        // 自分が描いた一杯だけに出ます。ほかの人の一杯には出ません。
        '<span class="seat__mine" hidden>あなたの一杯</span>' +
        '<button type="button" class="seat__drop" hidden>取り消す</button>' +
      '</div>';

    laneEl.appendChild(el);

    var seat = {
      el: el,
      cup: window.LatteArt.addCup(el.querySelector('canvas')),
      heart: el.querySelector('.heart'),
      num: el.querySelector('.heart__n'),
      whenEl: el.querySelector('.seat__when'),
      mineEl: el.querySelector('.seat__mine'),
      dropBtn: el.querySelector('.seat__drop'),
      post: null,
      x: 0
    };
    if (!seat.cup) return null;
    seat.cup.setMode('stir');

    seat.heart.addEventListener('click', function () { tapHeart(seat); });
    seat.dropBtn.addEventListener('click', function () { dropPost(seat); });
    return seat;
  }

  // 自分が描いた一杯かどうかを、席の見た目に反映します。
  // 判断のもとは、投稿したときにこの端末へ控えた「消すための鍵」です。
  // 鍵を持っていない人には札もボタンも出ませんし、持っていない人が
  // 消そうとしても置き場が断ります（鍵なし 400／違う鍵 403）。
  function markMine(seat) {
    var mine = !!(seat.post && myToken(seat.post.id));
    seat.el.setAttribute('data-mine', mine ? '1' : '0');
    seat.mineEl.hidden = !mine;
    seat.dropBtn.hidden = !mine;
    var cv = seat.cup && seat.cup.canvas;
    if (cv) {
      cv.setAttribute('aria-label', (mine ? 'あなたが描いたラテアート。' : 'だれかのラテアート。')
                                  + 'なぞると崩れます。');
    }
  }

  function serve(seat, post) {
    seat.post = post;
    // どの作品がどの席に出ているかを、札としても残しておきます
    // （同じ作品が重なっていないかを、外から確かめられるように）
    if (post) seat.el.setAttribute('data-post', post.id);
    else seat.el.removeAttribute('data-post');
    // 席を使い回すので、絵が無いときも札とボタンを片づけます
    markMine(seat);
    if (!post) return;
    var im = new Image();
    im.onload = function () {
      if (seat.post !== post) return;      // 注いでいる間に入れ替わったら捨てる
      // 第 2 引数が「注ぐところを見せない」。席が入れ替わるのは画面の外なので、
      // 流れてくるときにはもう出来上がっています。
      seat.cup.setPhoto(im, true);
      seat.cup.setMode('stir');
    };
    im.src = post.png;

    paintHeart(seat);
    seat.whenEl.textContent = when(post.created);
  }

  function paintHeart(seat) {
    if (!seat.post) return;
    var on = isLiked(seat.post.id);
    seat.heart.setAttribute('aria-pressed', String(on));
    seat.num.textContent = seat.post.likes;
  }

  // ---- ハート -------------------------------------------------------------
  function tapHeart(seat) {
    var post = seat.post;
    if (!post) return;
    var on = !isLiked(post.id);

    // 先に画面を動かして、失敗したら戻す
    post.likes = Math.max(0, post.likes + (on ? 1 : -1));
    setLiked(post.id, on);
    sync(post);
    seat.el.classList.remove('pop');
    void seat.el.offsetWidth;
    if (on) seat.el.classList.add('pop');

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: on ? 'like' : 'unlike', id: post.id })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (typeof j.likes === 'number') { post.likes = j.likes; sync(post); }
      })
      .catch(function () {
        post.likes = Math.max(0, post.likes + (on ? -1 : 1));
        setLiked(post.id, !on);
        sync(post);
      });
  }

  // 同じ作品が複数の席に出ていることがあるので、まとめて塗り直す
  function sync(post) {
    seats.forEach(function (s) { if (s.post && s.post.id === post.id) paintHeart(s); });
  }

  // ---- 自分の投稿を取り消す -----------------------------------------------
  function dropPost(seat) {
    var post = seat.post;
    if (!post) return;
    var token = myToken(post.id);
    if (!token) return;
    if (!window.confirm('あなたが描いたこの一杯を、みんなのラテアートから'
                      + '取り消します。元に戻せません。')) return;

    seat.dropBtn.disabled = true;
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: post.id, token: token })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        seat.dropBtn.disabled = false;
        if (j.error) { msg.textContent = j.error; msg.hidden = false; return; }
        forgetPost(post.id);
        posts = posts.filter(function (p) { return p.id !== post.id; });
        bag = bag.filter(function (p) { return p.id !== post.id; });
        seats.forEach(function (s) {
          if (s.post && s.post.id === post.id) { s.post = null; markMine(s); }
        });
        if (!posts.length) {
          fail('机が空になりました。もう一度描いてみませんか');
          band.hidden = true;
        }
      })
      .catch(function () {
        seat.dropBtn.disabled = false;
        msg.textContent = '取り消せませんでした';
        msg.hidden = false;
      });
  }

  // ---- 机を流す -----------------------------------------------------------
  var slow = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPEED  = 26;        // ひとりでに流れる速さ（1 秒あたり px）
  var last = 0;
  // 「つかむ」「勢い」「寄せる」は段ごとに持ちます（lanes の中）。
  // 机ひとつぶんで持っていたころは、1 段を払うと 3 段ついて来ていました。

  function place(seat) {
    seat.el.style.transform = 'translateX(' + seat.x.toFixed(1) + 'px)';
  }

  // ひとつの段を dx だけ横へずらす。左右どちらにも回り込みます。
  function move(lane, dx) {
    if (!dx) return;
    for (var i = 0; i < lane.seats.length; i++) {
      var s = lane.seats[i];
      s.x += dx;
      // 端から出たら、反対の端へ回して次の一杯を注ぐ
      while (s.x + lane.slot < -4) { s.x += lane.total; serve(s, pickPost()); }
      while (s.x > lane.total - lane.slot + 4) { s.x -= lane.total; serve(s, pickPost()); }
      place(s);
    }
  }

  // 段ごとに勘定します。つかんでいる段だけが指に従い、ほかの段は
  // そのまま流れ続けます（3 段がひとつにつながって動かないように）。
  function roll(now) {
    var dt = last ? Math.min((now - last) / 1000, 1 / 15) : 0;
    last = now;

    for (var L = 0; L < lanes.length; L++) {
      var lane = lanes[L];
      var dx = 0;
      if (lane.drag === null) {
        // ひとりでに流れるぶん。手を乗せていても止めません
        // （乗せるだけなら崩れるので、止まると崩しづらくなります）。
        if (!still) dx += SPEED * dt * lane.dir;
        // 離したあとに残る勢い
        if (lane.fling) {
          dx += lane.fling * dt;
          lane.fling *= Math.pow(0.0022, dt);     // 1 秒でほぼ止まる
          if (Math.abs(lane.fling) < 8) lane.fling = 0;
        }
        // ホイールやキーで指定したぶんを、少しずつ食べてなめらかに
        if (lane.glide) {
          var g = lane.glide * Math.min(1, dt * 8);
          lane.glide -= g;
          if (Math.abs(lane.glide) < 0.5) { g += lane.glide; lane.glide = 0; }
          dx += g;
        }
      }
      move(lane, dx);
    }
    requestAnimationFrame(roll);
  }

  // 段ごとの左右キー。閉じ込みを作るので、段を作るときに渡します。
  function keyLane(lane) {
    return function (e) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); lane.glide += lane.slot; }
      if (e.key === 'ArrowRight') { e.preventDefault(); lane.glide -= lane.slot; }
    };
  }

  // ---- 手で送る -----------------------------------------------------------
  //  つかんで払います。カップの上でも、押したまま動かせば机が動きます。
  //  押さずにカーソルを乗せるだけなら、今までどおり崩れます。
  //  押しているあいだはカップに指を渡さないので、払いながら崩れません。
  //  動くのはつかんだ段だけです。指は何本でも、段ごとに別々に扱います。
  function nowMs() { return window.performance ? performance.now() : Date.now(); }

  // 触られたところが、どの段か。段と段のすき間をつかんだときは、
  // いちばん近い段にします（どこをつかんでも何かが動くように）。
  function laneOf(node, y) {
    while (node && node !== band) {
      for (var i = 0; i < lanes.length; i++) if (lanes[i].el === node) return lanes[i];
      node = node.parentNode;
    }
    var best = null, near = Infinity;
    for (var k = 0; k < lanes.length; k++) {
      var r = lanes[k].el.getBoundingClientRect();
      var d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      if (d < near) { near = d; best = lanes[k]; }
    }
    return best;
  }

  var drags = {};         // 指ごとの、つかんでいる段

  band.addEventListener('pointerdown', function (e) {
    if (e.button) return;                      // 右クリックなどは拾わない
    var lane = laneOf(e.target, e.clientY);
    if (!lane) return;
    drags[e.pointerId] = { lane: lane, last: e.clientX, t: nowMs(), v: 0 };
    lane.drag = e.pointerId;
    lane.fling = 0;
    lane.glide = 0;
    lane.el.setAttribute('data-drag', '1');
    try { band.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();                       // カップに渡さない
  }, true);

  band.addEventListener('pointermove', function (e) {
    var d = drags[e.pointerId];
    if (!d) return;
    var dx = e.clientX - d.last;
    d.last = e.clientX;
    var t = nowMs();
    var dt = Math.max(t - d.t, 1) / 1000;
    d.t = t;
    // 1 コマぶんの速さは跳ねやすいので、ならしてから勢いにします
    d.v = d.v * 0.6 + (dx / dt) * 0.4;
    move(d.lane, dx);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function endDrag(e) {
    var d = e && drags[e.pointerId];
    if (!d) return;
    delete drags[e.pointerId];
    // 同じ段をほかの指がまだつかんでいたら、その指に任せます
    if (d.lane.drag !== e.pointerId) return;
    d.lane.fling = Math.max(-2600, Math.min(2600, d.v || 0));
    d.lane.drag = null;
    d.lane.el.removeAttribute('data-drag');
  }
  ['pointerup', 'pointercancel'].forEach(function (t) {
    band.addEventListener(t, endDrag, true);
  });

  // 横向きのホイール（Shift ＋ ホイールでも）。カーソルが乗っている段だけ。
  // 縦のホイールは取りません。取ると机の上でページを下に送れなくなります。
  band.addEventListener('wheel', function (e) {
    var dx = e.deltaX;
    if (!dx && e.shiftKey) dx = e.deltaY;
    if (!dx) return;
    var lane = laneOf(e.target, e.clientY);
    if (!lane) return;
    e.preventDefault();
    lane.glide -= dx;
  }, { passive: false });

  // ---- 読み込み -----------------------------------------------------------
  function build() {
    var L = layout();
    SLOT = L.slot[0];
    // 段ごとに違う値を使いますが、既定として帯にも置いておきます
    band.style.setProperty('--seatw', SLOT + 'px');
    band.style.setProperty('--cupw', L.cup[0] + 'px');
    band.setAttribute('data-lanes', String(L.lanes));
    // 段を別の板に見せるかどうか（1 段のトップページは机そのままです）
    desk.setAttribute('data-trays', L.trays ? '1' : '0');

    // 動きを控える設定の人だけ、止めたままにします
    still = slow;
    band.setAttribute('data-still', still ? '1' : '0');

    var made = 0;
    for (var li = 0; li < L.lanes; li++) {
      var laneEl = document.createElement('div');
      laneEl.className = 'lane';
      laneEl.style.setProperty('--seatw', L.slot[li] + 'px');
      laneEl.style.setProperty('--cupw',  L.cup[li] + 'px');
      laneEl.style.setProperty('--laneh', L.laneh[li] + 'px');
      laneEl.style.setProperty('--lanew', L.width[li] ? L.width[li] + 'px' : '100%');
      laneEl.setAttribute('data-narrow', L.width[li] ? '1' : '0');
      // 2 段目だけ左から右へ流します
      var dir = (li === 1) ? 1 : -1;
      laneEl.setAttribute('data-dir', dir > 0 ? 'right' : 'left');
      // キーボードでも送れるように。段ごとに焦点を当てて左右キー。
      laneEl.tabIndex = 0;
      laneEl.setAttribute('role', 'group');
      laneEl.setAttribute('aria-label', L.lanes > 1
        ? 'みんなのラテアート ' + (li + 1) + ' 段目。左右キーで送れます'
        : 'みんなのラテアート。左右キーで送れます');
      band.appendChild(laneEl);

      var lane = { el: laneEl, dir: dir, seats: [], total: 0, slot: L.slot[li],
                   drag: null, fling: 0, glide: 0 };
      laneEl.addEventListener('keydown', keyLane(lane));
      for (var i = 0; i < L.seats[li]; i++) {
        var s = makeSeat(made++, laneEl);
        if (!s) continue;
        // 控えの 1 枠は、流れてくる側の外に置きます。
        // 左へ流れる段は右端の外、右へ流れる段は左端の外。
        // 右へ流れる段で右端に置くと、始まってすぐ回り込んでしまいます。
        s.el.style.setProperty('--lift', liftOf(L.cup[li], made - 1) + 'px');
        s.x = i * L.slot[li] - (dir > 0 ? L.slot[li] : 0);
        place(s);
        lane.seats.push(s);
        seats.push(s);
        serve(s, pickPost());
      }
      if (!lane.seats.length) { band.removeChild(laneEl); continue; }
      lane.total = lane.seats.length * L.slot[li];
      lanes.push(lane);
    }

    if (!seats.length) {
      fail('このブラウザではカップを表示できませんでした。');
      return;
    }
    msg.hidden = true;
    if (hint) hint.hidden = false;
    requestAnimationFrame(roll);
  }

  fetch(API + '?action=list&limit=48')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.error) { fail(j.error); return; }
      posts = j.posts || [];
      if (!posts.length) {
        msg.textContent = 'まだ一杯もありません。最初の一杯を描いてみませんか';
        msg.hidden = false;
        return;
      }
      build();
    })
    .catch(function () {
      fail('読み込めませんでした。少し時間をおいてどうぞ');
    });
})();
