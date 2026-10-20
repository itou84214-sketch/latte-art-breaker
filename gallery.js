/* =========================================================================
   みんなのラテアート — 机の上を流れていく席
   -------------------------------------------------------------------------
   見た目の狙い
     区切りの無い 1 枚の机に、カップが無造作に置かれていて、ゆっくり
     流れていきます。カップの上をなぞると、その場で崩れます。
     みんなの作品ページは 3 段。2 段目だけ左から右へ流れます。

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
  //  余裕を見て、この机で使う数を決めます。
  //   data-lanes  何段にするか（みんなの作品ページは 3、トップは 1）
  //   data-seats  トップのように杯が先にいるページで、使う数を抑える
  var CAP   = parseInt(desk.dataset.seats || '0', 10) || 0;
  var LANES = Math.max(1, parseInt(desk.dataset.lanes || '1', 10) || 1);

  function layout() {
    var vw = Math.max(document.documentElement.clientWidth, 320);
    var vh = Math.max(document.documentElement.clientHeight, 420);
    var narrow = vw < 700;
    var base = narrow ? 200 : 272;   // 1 枠の幅の下限
    var cap1 = narrow ? 240 : 360;   // 1 段のときの枠の幅の上限
    var budget = narrow ? 9 : 12;    // この机で使う WebGL の数
    if (CAP) budget = Math.min(budget, CAP);

    var lanes = Math.max(1, Math.min(LANES, Math.floor(budget / 2)));
    var per = Math.max(2, Math.floor(budget / lanes));

    // 「見えるぶん ＋ 袖 1 枠ぶん」。袖が無いと、次の一杯が画面の中で現れます。
    var slot = Math.max(base, Math.ceil(vw / (per - 1)) + 1);
    if (lanes === 1) slot = Math.min(cap1, slot);

    // 杯の大きさ。段を重ねるので、画面の高さからも頭打ちにします。
    var cup;
    if (lanes === 1) {
      cup = slot - 20;
    } else {
      var room = (vh * 0.86 - (lanes - 1) * 14) / lanes;
      cup = Math.min(slot - 24, Math.floor(room / 1.26) - 19);
      cup = Math.max(120, Math.min(cup, 260));
    }
    return { lanes: lanes, per: per, slot: slot, cup: cup };
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
    // 下へずらすだけにします。上へ持ち上げると帯の縁で切れてしまいます。
    // 6px から始めるのは、杯を 2 度ほど傾けてあるぶん（実測 4.5px）
    // 角が上に出るためです。下は 30px 以上余っています。
    el.style.setProperty('--lift', 6 + ((i * 37) % 9) * 3 + 'px');
    el.style.setProperty('--tilt', ((((i * 53) % 7) - 3) * 0.7).toFixed(2) + 'deg');

    el.innerHTML =
      '<div class="seat__cup">' +
        '<canvas data-cup data-pattern="-1" data-spoon="' + (i % 3 === 0 ? 1 : 0) + '"' +
                ' data-sugar="' + (i % 4 === 1 ? 1 : 0) + '"' +
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
  var glide  = 0;         // あと何 px 寄せるか（右へ送るなら ＋）
  var last = 0;

  function place(seat) {
    seat.el.style.transform = 'translateX(' + seat.x.toFixed(1) + 'px)';
  }

  // dx だけ横へずらす。左右どちらにも回り込みます。
  // auto が真のときは段ごとの向きを掛けます（2 段目だけ左から右へ）。
  // 手で払うときは向きを掛けません。指について来ないと変なので。
  function shift(dx, auto) {
    for (var L = 0; L < lanes.length; L++) {
      var lane = lanes[L];
      var d = auto ? dx * lane.dir : dx;
      if (!d) continue;
      for (var i = 0; i < lane.seats.length; i++) {
        var s = lane.seats[i];
        s.x += d;
        // 端から出たら、反対の端へ回して次の一杯を注ぐ
        while (s.x + SLOT < -4) { s.x += lane.total; serve(s, pickPost()); }
        while (s.x > lane.total - SLOT + 4) { s.x -= lane.total; serve(s, pickPost()); }
        place(s);
      }
    }
  }

  function roll(now) {
    var dt = last ? Math.min((now - last) / 1000, 1 / 15) : 0;
    last = now;

    // 手を置いていても止めません。崩しながらでも流れ続けます。
    // つかんでいるあいだだけは、指の動きだけで動かします。
    if (!still && !drag) shift(SPEED * dt, true);

    var dx = 0;
    if (fling && !drag) {
      dx += fling * dt;
      fling *= Math.pow(0.0022, dt);           // 1 秒でほぼ止まる
      if (Math.abs(fling) < 8) fling = 0;
    }
    if (glide && !drag) {
      var g = glide * Math.min(1, dt * 8);        // 残りを少しずつ食べてなめらかに
      glide -= g;
      if (Math.abs(glide) < 0.5) { g += glide; glide = 0; }
      dx += g;
    }
    if (dx) shift(dx, false);
    requestAnimationFrame(roll);
  }

  // ---- 手で送る -----------------------------------------------------------
  //  つかんで払います。カップの上でも、押したまま動かせば机が動きます。
  //  押さずにカーソルを乗せるだけなら、今までどおり崩れます。
  //  押しているあいだはカップに指を渡さないので、払いながら崩れません。
  var drag = null;
  var fling = 0;          // 離したあとに残る勢い（px/秒）
  function nowMs() { return window.performance ? performance.now() : Date.now(); }

  band.addEventListener('pointerdown', function (e) {
    if (e.button) return;                      // 右クリックなどは拾わない
    drag = { id: e.pointerId, last: e.clientX, t: nowMs(), v: 0 };
    fling = 0;
    glide = 0;
    band.setAttribute('data-drag', '1');
    try { band.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();                       // カップに渡さない
  }, true);

  band.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.last;
    drag.last = e.clientX;
    var t = nowMs();
    var dt = Math.max(t - drag.t, 1) / 1000;
    drag.t = t;
    // 1 コマぶんの速さは跳ねやすいので、ならしてから勢いにします
    drag.v = drag.v * 0.6 + (dx / dt) * 0.4;
    if (dx) shift(dx, false);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    fling = Math.max(-2600, Math.min(2600, drag.v || 0));
    drag = null;
    band.removeAttribute('data-drag');
  }
  ['pointerup', 'pointercancel'].forEach(function (t) {
    band.addEventListener(t, endDrag, true);
  });

  // 横向きのホイール（Shift ＋ ホイールでも）。
  // 縦のホイールは取りません。取ると机の上でページを下に送れなくなります。
  band.addEventListener('wheel', function (e) {
    var dx = e.deltaX;
    if (!dx && e.shiftKey) dx = e.deltaY;
    if (!dx) return;
    e.preventDefault();
    glide -= dx;
  }, { passive: false });

  // キーボードでも送れるように。帯に焦点を当てて左右キー。
  band.tabIndex = 0;
  band.setAttribute('role', 'group');
  band.setAttribute('aria-label', 'みんなのラテアート。左右キーで送れます');
  band.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); glide += SLOT; }
    if (e.key === 'ArrowRight') { e.preventDefault(); glide -= SLOT; }
  });

  // ---- 読み込み -----------------------------------------------------------
  function build() {
    var L = layout();
    SLOT = L.slot;
    band.style.setProperty('--seatw', SLOT + 'px');
    band.style.setProperty('--cupw', L.cup + 'px');
    band.setAttribute('data-lanes', String(L.lanes));

    // 段は「見えるぶん ＋ 袖 1 枠ぶん」必要です。袖が取れないほど横長な
    // 画面では、段のほうを 1 枠ぶん狭めて中央に寄せます。止めてしまうと
    // 「流れていく机」でなくなるので、狭めてでも流します。
    var run = L.per * SLOT;
    var fills = run - SLOT >= document.documentElement.clientWidth;
    band.style.setProperty('--bandw', fills ? '100%' : (run - SLOT) + 'px');
    band.setAttribute('data-narrow', fills ? '0' : '1');

    // 動きを控える設定の人だけ、止めたままにします
    still = slow;
    band.setAttribute('data-still', still ? '1' : '0');

    var made = 0;
    for (var li = 0; li < L.lanes; li++) {
      var laneEl = document.createElement('div');
      laneEl.className = 'lane';
      // 2 段目だけ左から右へ流します
      var dir = (li === 1) ? 1 : -1;
      laneEl.setAttribute('data-dir', dir > 0 ? 'right' : 'left');
      band.appendChild(laneEl);

      var lane = { el: laneEl, dir: dir, seats: [], total: 0 };
      for (var i = 0; i < L.per; i++) {
        var s = makeSeat(made++, laneEl);
        if (!s) continue;
        // 控えの 1 枠は、流れてくる側の外に置きます。
        // 左へ流れる段は右端の外、右へ流れる段は左端の外。
        // 右へ流れる段で右端に置くと、始まってすぐ回り込んでしまいます。
        s.x = i * SLOT - (dir > 0 ? SLOT : 0);
        place(s);
        lane.seats.push(s);
        seats.push(s);
        serve(s, pickPost());
      }
      if (!lane.seats.length) { band.removeChild(laneEl); continue; }
      lane.total = lane.seats.length * SLOT;
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
