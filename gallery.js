/* =========================================================================
   みんなのラテアート — 一覧ページ
   -------------------------------------------------------------------------
   ブラウザが同時に持てる WebGL は 8〜16 個ほどしかないので、
   一覧は「ただの画像」、動くカップは上の 1 つだけにしてあります。
   作品が何百個に増えても重くなりません。

   いいねは、押したものを localStorage に覚えて二度押しを防いでいます。
   端末側の記録なので、消せばまた押せます。厳密な一人一票ではありません。
   ========================================================================= */
(function () {
  'use strict';

  var API   = (window.LATTE_API || '').replace(/[/]+$/, '');
  var LIKED = 'latte-art-breaker/liked';
  var MINE  = 'latte-art-breaker/posted';

  var wall    = document.querySelector('[data-wall]');
  var msg     = document.querySelector('[data-wall-msg]');
  var more    = document.querySelector('[data-act="more"]');
  var stateEl = document.querySelector('[data-pick-state]');
  var tools   = document.querySelector('[data-pick-tools]');
  var hint    = document.querySelector('[data-pick-hint]');
  var likeBtn = document.querySelector('[data-act="like"]');
  var likeNum = document.querySelector('[data-like-count]');
  var eraseBtn = document.querySelector('[data-act="erase-mine"]');

  if (!wall) return;

  if (!API) {
    msg.textContent = '投稿の置き場がまだ設定されていません（config.js の LATTE_API）。';
    msg.setAttribute('data-state', 'err');
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
  function likedIds() { return load(LIKED); }
  function isLiked(id) { return likedIds().indexOf(id) >= 0; }
  function setLiked(id, on) {
    var a = likedIds().filter(function (x) { return x !== id; });
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

  // ---- 上の大きなカップ ---------------------------------------------------
  var picked = null;
  var cup = (function () {
    var L = window.LatteArt;
    if (!L || !L.cups.length) return null;
    var cv = document.querySelector('.pick canvas[data-cup]');
    for (var i = 0; i < L.cups.length; i++) if (L.cups[i].canvas === cv) return L.cups[i];
    return null;
  })();

  function pick(post, imgEl) {
    if (!cup) return;
    picked = post;

    var im = new Image();
    im.onload = function () {
      cup.setPhoto(im);
      cup.setMode && cup.setMode('stir');
    };
    im.src = post.png;

    Array.prototype.forEach.call(wall.querySelectorAll('.card'), function (c) {
      c.classList.toggle('is-picked', c === (imgEl && imgEl.closest('.card')));
    });

    stateEl.textContent = when(post.created) + ' の一杯';
    tools.hidden = false;
    hint.hidden = false;
    paintLike(post);
    eraseBtn.hidden = !myToken(post.id);

    document.querySelector('.pick').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function paintLike(post) {
    var on = isLiked(post.id);
    likeBtn.setAttribute('aria-pressed', String(on));
    likeNum.textContent = post.likes;
  }

  function when(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return 'いつか';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // ---- 一覧 ---------------------------------------------------------------
  var next = null, loading = false;

  function card(post) {
    var el = document.createElement('div');
    el.className = 'card';
    el.innerHTML =
      '<button type="button" class="card__btn">' +
        '<img class="card__img" alt="だれかのラテアート" loading="lazy">' +
      '</button>' +
      '<div class="card__foot">' +
        '<span class="card__likes"><span aria-hidden="true">♥</span> ' +
          '<span class="card__n"></span></span>' +
        '<span class="card__when"></span>' +
      '</div>';
    var img = el.querySelector('.card__img');
    img.src = post.png;
    el.querySelector('.card__n').textContent = post.likes;
    el.querySelector('.card__when').textContent = when(post.created);
    if (myToken(post.id)) el.classList.add('is-mine');
    el.querySelector('.card__btn').addEventListener('click', function () { pick(post, img); });
    el.dataset.id = post.id;
    return el;
  }

  function fetchPage() {
    if (loading) return;
    loading = true;
    more.disabled = true;

    var url = API + '?action=list&limit=24' + (next ? '&after=' + encodeURIComponent(next) : '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        loading = false;
        more.disabled = false;
        if (j.error) { fail(j.error); return; }

        (j.posts || []).forEach(function (p) { wall.appendChild(card(p)); });
        next = j.next;
        more.hidden = !next;

        if (!wall.children.length) {
          msg.textContent = 'まだ一杯もありません。最初の一杯を描いてみませんか';
          msg.hidden = false;
        } else {
          msg.hidden = true;
        }
      })
      .catch(function () {
        loading = false;
        more.disabled = false;
        fail('読み込めませんでした。少し時間をおいてどうぞ');
      });
  }

  function fail(text) {
    msg.textContent = text;
    msg.setAttribute('data-state', 'err');
    msg.hidden = false;
  }

  more.addEventListener('click', fetchPage);

  // ---- いいね -------------------------------------------------------------
  likeBtn.addEventListener('click', function () {
    if (!picked) return;
    var on = !isLiked(picked.id);

    // 先に画面を動かして、失敗したら戻す
    picked.likes = Math.max(0, picked.likes + (on ? 1 : -1));
    setLiked(picked.id, on);
    paintLike(picked);
    syncCard(picked);

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: on ? 'like' : 'unlike', id: picked.id })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (typeof j.likes === 'number') {
          picked.likes = j.likes;
          paintLike(picked);
          syncCard(picked);
        }
      })
      .catch(function () {
        picked.likes = Math.max(0, picked.likes + (on ? -1 : 1));
        setLiked(picked.id, !on);
        paintLike(picked);
        syncCard(picked);
      });
  });

  function syncCard(post) {
    var el = wall.querySelector('.card[data-id="' + post.id + '"] .card__n');
    if (el) el.textContent = post.likes;
  }

  // ---- 自分の投稿を取り消す -----------------------------------------------
  eraseBtn.addEventListener('click', function () {
    if (!picked) return;
    var token = myToken(picked.id);
    if (!token) return;
    if (!window.confirm('この投稿を取り消します。元に戻せません。')) return;

    eraseBtn.disabled = true;
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: picked.id, token: token })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        eraseBtn.disabled = false;
        if (j.error) { stateEl.textContent = j.error; return; }
        var el = wall.querySelector('.card[data-id="' + picked.id + '"]');
        if (el) el.remove();
        forgetPost(picked.id);
        picked = null;
        tools.hidden = true;
        hint.hidden = true;
        eraseBtn.hidden = true;
        stateEl.textContent = '取り消しました';
      })
      .catch(function () {
        eraseBtn.disabled = false;
        stateEl.textContent = '取り消せませんでした';
      });
  });

  fetchPage();
})();
