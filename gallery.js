/* =========================================================================
   みんなのラテアート — 机の上を流れていく席
   -------------------------------------------------------------------------
   見た目の狙い
     区切りの無い 1 枚の机に、カップが無造作に置かれていて、右から左へ
     ゆっくり流れていきます。カップの上をなぞると、その場で崩れます。

   作りの都合
     ブラウザが同時に持てる WebGL は 8〜16 個ほどしかありません。
     そこで「席」の数を画面幅から決め打ちし、左端から出ていった席に
     次の作品を注ぎ直して回します。作品が何百件になっても重くなりません。

   いいねは、押したものを localStorage に覚えて二度押しを防いでいます。
   端末側の記録なので、消せばまた押せます。厳密な一人一票ではありません。
   ========================================================================= */
(function () {
  'use strict';

  var API   = (window.LATTE_API || '').replace(/[/]+$/, '');
  var LIKED = 'latte-art-breaker/liked';
  var MINE  = 'latte-art-breaker/posted';

  var band = document.querySelector('[data-band]');
  var msg  = document.querySelector('[data-msg]');
  var hint = document.querySelector('[data-hint]');
  if (!band) return;

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

  // ---- 席の数と大きさ -----------------------------------------------------
  // 幅の狭い端末では WebGL の数を減らします
  function layout() {
    var vw = Math.max(document.documentElement.clientWidth, 320);
    var seatW = vw < 700 ? 200 : 272;
    var most  = vw < 700 ? 4 : 8;
    var need  = Math.ceil(vw / seatW) + 2;
    return { seatW: seatW, seats: Math.min(most, Math.max(3, need)) };
  }

  function when(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return 'いつか';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // ---- 机をこしらえる -----------------------------------------------------
  var posts = [];
  var seats = [];
  var feed  = 0;          // 次に注ぐ作品の番号
  var SEATW = 0;
  var total = 0;
  var rolling = true;     // 手を置いているあいだは止める
  var still = false;      // 作品が少なくて流す必要が無いとき

  function nextPost() {
    if (!posts.length) return null;
    var p = posts[feed % posts.length];
    feed++;
    return p;
  }

  function makeSeat(i) {
    var el = document.createElement('div');
    el.className = 'seat';
    // 机に無造作に置かれた感じを出すための、席ごとのばらつき
    el.style.setProperty('--lift', (((i * 37) % 9) - 4) * 4 + 'px');
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
        '<button type="button" class="seat__drop" hidden>取り消す</button>' +
      '</div>';

    band.appendChild(el);

    var seat = {
      el: el,
      cup: window.LatteArt.addCup(el.querySelector('canvas')),
      heart: el.querySelector('.heart'),
      num: el.querySelector('.heart__n'),
      whenEl: el.querySelector('.seat__when'),
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

  function serve(seat, post) {
    seat.post = post;
    if (!post) return;
    var im = new Image();
    im.onload = function () {
      if (seat.post !== post) return;      // 注いでいる間に入れ替わったら捨てる
      seat.cup.setPhoto(im);
      seat.cup.setMode('stir');
    };
    im.src = post.png;

    paintHeart(seat);
    seat.whenEl.textContent = when(post.created);
    seat.dropBtn.hidden = !myToken(post.id);
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
    if (!window.confirm('この投稿を取り消します。元に戻せません。')) return;

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
        seats.forEach(function (s) {
          if (s.post && s.post.id === post.id) { s.post = null; s.dropBtn.hidden = true; }
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
  var SPEED = 26;         // 1 秒あたりに流れる px
  var last = 0;

  function place(seat) {
    seat.el.style.transform = 'translateX(' + seat.x.toFixed(1) + 'px)';
  }

  function roll(now) {
    var dt = last ? Math.min((now - last) / 1000, 1 / 15) : 0;
    last = now;

    if (rolling && !still && !document.hidden) {
      for (var i = 0; i < seats.length; i++) {
        var s = seats[i];
        s.x -= SPEED * dt;
        if (s.x + SEATW < -4) {            // 左端から出た席に、次の一杯を注ぐ
          s.x += total;
          serve(s, nextPost());
        }
        place(s);
      }
    }
    requestAnimationFrame(roll);
  }

  // 手を置いているあいだは止める。崩している最中に逃げないように。
  ['pointerenter', 'pointerdown'].forEach(function (t) {
    band.addEventListener(t, function () { rolling = false; }, true);
  });
  ['pointerleave', 'pointercancel'].forEach(function (t) {
    band.addEventListener(t, function () { rolling = true; }, true);
  });
  band.addEventListener('pointerup', function () { rolling = true; }, true);

  // ---- 読み込み -----------------------------------------------------------
  function build() {
    var L = layout();
    SEATW = L.seatW;
    band.style.setProperty('--seatw', SEATW + 'px');

    var n = Math.min(L.seats, Math.max(posts.length, 1));
    total = n * SEATW;

    // 机の幅に足りないときは、流さずに置いたままにします
    still = slow || total <= document.documentElement.clientWidth;
    band.setAttribute('data-still', still ? '1' : '0');

    for (var i = 0; i < n; i++) {
      var s = makeSeat(i);
      if (!s) continue;
      s.x = i * SEATW;
      place(s);
      seats.push(s);
      serve(s, nextPost());
    }

    if (!seats.length) {
      fail('このブラウザではカップを表示できませんでした。');
      return;
    }
    msg.hidden = true;
    hint.hidden = false;
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
