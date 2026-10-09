/* The preview's doorkeeper. Every address under this folder is answered here: the sealed file that holds
   it is fetched, opened with the key this browser keeps, and handed to the page as if it had been
   served plainly. With no key, a page is sent to the sign-in and anything else is refused. */
'use strict';
var BASE = new URL(self.registration.scope).pathname;
var PLAIN = { '': 1, 'index.html': 1, '404.html': 1, 'sw.js': 1, 'm.bin': 1, 'robots.txt': 1, 'favicon.ico': 1 };
var state = null, stamp = 0, opening = null;
var held = new Map(), heldBytes = 0, ROOM = 96 * 1024 * 1024;   // opened files kept while the worker lives
var KEPT = 'sealed';                                            // the browser's own cache: sealed files, as they came
var PRESS = typeof DecompressionStream === 'function';          // text is sealed pressed (gzip) too: taken where it can be opened out

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (e) { if (e.data === 'fresh') { state = null; held.clear(); heldBytes = 0; } });

function kept() {
  return new Promise(function (yes, no) {
    var r = indexedDB.open('preview', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onerror = function () { no(r.error); };
    r.onsuccess = function () { var g = r.result.transaction('kv', 'readonly').objectStore('kv').get('k'); g.onsuccess = function () { yes(g.result); }; g.onerror = function () { no(g.error); }; };
  });
}
function unseal(key, buf) { var b = new Uint8Array(buf); return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)); }
function unpress(buf) { return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }

// A sealed file is named from what it holds, so one fetched once is good for as long as the list names it. It is kept in the
// browser's cache still sealed, and asked of the network only the first time; without a cache it is fetched as before.
function sealed(name) {
  var url = BASE + 'b/' + name;
  if (!self.caches) return fetch(url);
  return caches.open(KEPT).then(function (c) {
    return c.match(url).then(function (hit) {
      return hit || fetch(url).then(function (r) { if (r.ok) c.put(url, r.clone()).catch(function () {}); return r; });
    });
  }).catch(function () { return fetch(url); });
}
// What the list no longer names is dropped from that cache.
function prune(files) {
  if (!self.caches) return;
  var named = {};
  Object.keys(files).forEach(function (p) { named[files[p].b] = 1; if (files[p].z) named[files[p].z] = 1; });
  caches.open(KEPT).then(function (c) { return c.keys().then(function (all) { all.forEach(function (q) { if (!named[q.url.slice(q.url.lastIndexOf('/') + 1)]) c.delete(q); }); }); }).catch(function () {});
}

// The key and the list of what is here. Read again after a minute, so a new staging is picked up.
function open() {
  if (state && Date.now() - stamp < 60000) return Promise.resolve(state);
  if (opening) return opening;
  opening = kept().then(function (rec) {
    if (!rec || (rec.exp && rec.exp < Date.now())) { state = null; return null; }
    return fetch(BASE + 'm.bin', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) return state;
      return r.arrayBuffer().then(function (buf) { return unseal(rec.key, buf); }).then(function (plain) {
        state = { key: rec.key, files: JSON.parse(new TextDecoder().decode(plain)) }; stamp = Date.now(); prune(state.files); return state;
      }, function () { state = null; return null; });                       // the key no longer fits: the password was changed
    }, function () { return state; });                                      // off line: go on with what is held
  }).catch(function () { return state; }).then(function (s) { opening = null; return s; });
  return opening;
}
function hold(name, buf) {
  if (buf.byteLength > ROOM / 2) return;
  held.set(name, buf); heldBytes += buf.byteLength;
  held.forEach(function (b, k) { if (heldBytes > ROOM && k !== name) { held.delete(k); heldBytes -= b.byteLength; } });
}
function page(text, status) {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + text + '</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-content:center;background:#000;color:#f3f3f3;font:1rem/1.5 system-ui,sans-serif"><p>' + text + '</p>',
    { status: status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function serve(req, rel, url) {
  var nav = req.mode === 'navigate';
  return open().then(function (st) {
    if (!st) return nav ? Response.redirect(new URL(BASE + '?next=' + encodeURIComponent(rel + url.search), self.location).href, 302) : new Response('', { status: 401 });
    var path = rel; try { path = decodeURIComponent(rel); } catch (e) {}
    if (path === '' || path.slice(-1) === '/') path += 'index.html';
    var f = st.files[path];
    if (!f && st.files[path + '/index.html']) return Response.redirect(new URL(BASE + rel + '/' + url.search, self.location).href, 301);
    if (!f) return nav ? page('Nothing is staged at this address.', 404) : new Response('', { status: 404 });
    var name = f.z && PRESS ? f.z : f.b;
    var got = held.has(name) ? Promise.resolve(held.get(name)) : sealed(name).then(function (r) {
      if (!r.ok) throw new Error('missing');
      return r.arrayBuffer().then(function (buf) { return unseal(st.key, buf); }).then(function (plain) { return name === f.z ? unpress(plain) : plain; })
        .then(function (plain) { hold(name, plain); return plain; });
    });
    return got.then(function (buf) {
      var n = buf.byteLength, h = { 'Content-Type': f.t, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      var m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
      if (m && (m[1] || m[2])) {                                            // a film is asked for in pieces
        var s = m[1] === '' ? Math.max(0, n - +m[2]) : +m[1], e = m[1] === '' || m[2] === '' ? n - 1 : Math.min(+m[2], n - 1);
        if (s >= n || s > e) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + n } });
        h['Content-Range'] = 'bytes ' + s + '-' + e + '/' + n; h['Content-Length'] = String(e - s + 1);
        return new Response(buf.slice(s, e + 1), { status: 206, headers: h });
      }
      h['Content-Length'] = String(n);
      return new Response(buf, { status: 200, headers: h });
    }, function () { return nav ? page('This page could not be opened. Try again in a moment.', 502) : new Response('', { status: 502 }); });
  });
}

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(BASE) !== 0 || e.request.method !== 'GET') return;
  var rel = url.pathname.slice(BASE.length);
  if (PLAIN[rel] || rel.indexOf('b/') === 0) return;                        // the sign-in, this worker and the sealed files go out as they are
  e.respondWith(serve(e.request, rel, url));
});
