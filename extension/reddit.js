// ContentLock: Reddit NSFW filter (config flag `blockRedditNsfw`).
//
// Reddit can't be DNS-blocked without losing all of it, and NSFW media is served from the same hosts
// as everything else (i.redd.it, v.redd.it, preview.redd.it). But Reddit labels NSFW itself: every
// NSFW subreddit carries `over18`, every NSFW post `over_18`, NSFW profiles `subreddit.over_18`. So
// rather than chasing subreddit names, this asks Reddit's own JSON API and acts on its answer:
//
//   (1) PAGE: opening an NSFW subreddit, profile or post (including via a direct link) goes to
//       blocked.html. The page is hidden while the answer is fetched (usually well under a second,
//       then cached for the session), and shown if Reddit doesn't answer within a few seconds.
//   (2) FEEDS: every post linked anywhere on a page (home, r/popular, search, normal subreddits,
//       sidebars) is looked up in batches of 100 and its card hidden if it is NSFW.
//   (3) CSS: Reddit's own NSFW markers in the markup hide cards instantly, before (2) answers.
//       Layered on top, not relied on - markup changes more often than the API.
//   (4) Old Reddit's "are you over 18?" interstitial is only ever shown for NSFW, so it is blocked
//       outright, and an `include_over_18` search parameter is stripped.
//
// Fails OPEN on API errors (a broken Reddit is worse than a delayed answer), and that is the accepted
// gap, together with NSFW posts nobody tagged. Runs on reddit.com and its subdomains only; the
// generic keyword/path filter in content.js runs here too, as on every site.

(() => {
  "use strict";

  const BLOCKED = chrome.runtime.getURL("blocked.html") + "?r=reddit-nsfw";
  const TIMEOUT_MS = 4000;
  // Listings that aren't real subreddits (about.json 404s or means nothing for them).
  const SKIP_SUBS = new Set(["all", "popular", "friends", "mod", "home", "random", "myrandom",
                             "subreddits", "settings"]);
  // Exists only to hand out a random NSFW subreddit.
  const ALWAYS_BLOCK_SUBS = new Set(["randnsfw"]);

  let enabled = false;
  let blocked = false;
  let seq = 0;

  const subs = new Map();    // name  -> true/false, or a pending Promise
  const users = new Map();   // name  -> true/false, or a pending Promise
  const posts = new Map();   // id36  -> true/false (settled answers only)
  const inflight = new Set();
  let backoffUntil = 0;

  // ---------------------------------------------------------------- styles
  // Only selectors that can match a SINGLE post. A broader one ("any element whose tracking data says
  // nsfw:true") matched a wrapper around a whole page of search results and blanked it (1.0.4).
  const hideCss = document.createElement("style");
  hideCss.textContent = [
    "[data-cl-nsfw]",
    "shreddit-post[nsfw]",
    "article:has(shreddit-post[nsfw])",
    "shreddit-blurred-container[reason=\"nsfw\"]",
    ".thing.over18",
    ".thing[data-nsfw=\"true\"]",
    ".search-result:has(.nsfw-stamp)"
  ].join(",\n") + " { display: none !important; }";

  const checkingCss = document.createElement("style");
  checkingCss.textContent = "html { visibility: hidden !important; }";

  function attach(el, on) {
    if (on && !el.isConnected) (document.head || document.documentElement).appendChild(el);
    if (!on && el.isConnected) el.remove();
  }
  const setChecking = on => attach(checkingCss, on);

  // ---------------------------------------------------------------- config
  async function loadConfig() {
    try {
      const m = await chrome.storage.managed.get("configJson");
      const cfg = m && m.configJson ? JSON.parse(m.configJson) : {};
      enabled = cfg.blockRedditNsfw === true;
    } catch (e) {
      enabled = false;
    }
    attach(hideCss, enabled);
  }

  // ---------------------------------------------------------------- what is this page?
  const decode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };

  function classify(pathname) {
    const p = (pathname || "/").toLowerCase();
    const out = { block: false, subs: [], user: null, post: null };
    if (/^\/over18(\/|$)/.test(p)) out.block = true;

    let m = p.match(/\/comments\/([a-z0-9]+)/) || p.match(/^\/gallery\/([a-z0-9]+)/);
    if (m) out.post = m[1];

    m = p.match(/^\/r\/([^/]+)/);
    if (m) {
      for (const n of decode(m[1]).split("+")) {
        if (ALWAYS_BLOCK_SUBS.has(n)) out.block = true;
        else if (n && !SKIP_SUBS.has(n)) out.subs.push(n);
      }
    }

    m = p.match(/^\/(?:user|u)\/([^/]+)/);
    if (m && m[1] !== "me") out.user = decode(m[1]);
    return out;
  }

  const hasChecks = c => c.block || c.subs.length > 0 || c.user !== null || c.post !== null;

  // ---------------------------------------------------------------- Reddit's answers
  async function getJson(path) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(location.origin + path, {
        credentials: "include", signal: ctl.signal, headers: { "Accept": "application/json" }
      });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // Settled value straight from the cache, or a Promise. A failed lookup (null) isn't cached, so it is
  // asked again on the next visit.
  function cached(map, key, loader) {
    if (map.has(key)) return map.get(key);
    const pr = loader().then(v => {
      if (v === null) map.delete(key); else map.set(key, v);
      return v;
    });
    map.set(key, pr);
    return pr;
  }

  const subNsfw = name => cached(subs, name, async () => {
    const j = await getJson(`/r/${encodeURIComponent(name)}/about.json?raw_json=1`);
    const d = j && j.data;
    return d && typeof d.over18 === "boolean" ? d.over18 : null;
  });

  const userNsfw = name => cached(users, name, async () => {
    const j = await getJson(`/user/${encodeURIComponent(name)}/about.json?raw_json=1`);
    if (!j || !j.data) return null;
    const s = j.data.subreddit;                     // a profile's own page; absent on some accounts
    return !!(s && s.over_18 === true);
  });

  /** Look up to 100 post ids in one request. Records an answer for every id, or returns false. */
  async function fetchPosts(ids) {
    const j = await getJson(`/api/info.json?raw_json=1&id=${ids.map(i => "t3_" + i).join(",")}`);
    const kids = j && j.data && Array.isArray(j.data.children) ? j.data.children : null;
    if (!kids) return false;
    for (const k of kids) {
      const d = k && k.data;
      if (d && d.id) posts.set(String(d.id).toLowerCase(), d.over_18 === true || d.over18 === true);
    }
    for (const i of ids) if (!posts.has(i)) posts.set(i, false);   // deleted/removed: stop asking
    return true;
  }

  function postNsfw(id) {
    if (posts.has(id)) return posts.get(id);
    return fetchPosts([id]).then(ok => (ok ? posts.get(id) : null));
  }

  // ---------------------------------------------------------------- (1) the page itself
  function block() {
    if (blocked) return;
    blocked = true;
    location.replace(BLOCKED);
  }

  function stripNsfwSearchParam() {
    try {
      const u = new URL(location.href);
      const v = (u.searchParams.get("include_over_18") || "").toLowerCase();
      if (v && v !== "0" && v !== "off" && v !== "false") {
        u.searchParams.delete("include_over_18");
        location.replace(u.href);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function checkPage() {
    const my = ++seq;
    if (!enabled) { setChecking(false); return; }
    if (stripNsfwSearchParam()) return;

    const c = classify(location.pathname);
    if (c.block) { block(); return; }

    const checks = c.subs.map(subNsfw);
    if (c.user) checks.push(userNsfw(c.user));
    if (c.post) checks.push(postNsfw(c.post));
    if (checks.length === 0) { setChecking(false); return; }

    // Everything already known: decide without hiding the page at all.
    if (checks.every(x => typeof x === "boolean")) {
      if (checks.includes(true)) block(); else setChecking(false);
      return;
    }

    setChecking(true);
    await new Promise(resolve => {
      let pending = checks.length;
      const done = () => { if (--pending === 0) resolve(); };
      for (const x of checks) {
        Promise.resolve(x).then(v => { if (v === true && my === seq) block(); done(); }, done);
      }
      setTimeout(resolve, TIMEOUT_MS + 500);           // fail open rather than hang the page
    });
    if (my === seq && !blocked) setChecking(false);
  }

  // ---------------------------------------------------------------- (2) posts listed on the page
  const CANDIDATES = 'shreddit-post, .thing[data-fullname^="t3_"], [permalink*="/comments/"], a[href*="/comments/"]';

  function postIdOf(el) {
    const full = el.getAttribute("data-fullname") || el.getAttribute("id") || el.getAttribute("thingid") || "";
    if (/^t3_[a-z0-9]+$/i.test(full)) return full.slice(3).toLowerCase();
    const href = el.getAttribute("permalink") || el.getAttribute("href") || el.getAttribute("content-href") || "";
    const m = href.match(/\/comments\/([a-z0-9]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // The card to hide. Nearest-first matching would pick a tiny wrapper (old Reddit's "comments" link
  // sits in its own <li>), so look for the post-level containers in priority order. A link inside a
  // comment hides only the link, never the comment thread around it.
  //
  // Never hide a box holding more than one post. On search pages search-telemetry-tracker turned out to
  // wrap the WHOLE result list (16 posts), so hiding "the nearest known container" blanked the page in
  // 1.0.4. When the known containers are too big, climb from the link instead and take the largest
  // ancestor that still holds only this one post - the result's own card, whatever the markup.
  const STOP = new Set(["BODY", "HTML", "MAIN"]);
  const MAX_CLIMB = 12;

  function containerOf(el) {
    if (el.closest("shreddit-comment, .comment")) return el;
    const box = el.closest("shreddit-post") || el.closest(".thing") || el.closest("article") ||
                el.closest("search-telemetry-tracker") || el.closest("li");
    if (box && singlePost(box)) return box;
    let card = el;
    for (let i = 0, up = el.parentElement; i < MAX_CLIMB && up && !STOP.has(up.tagName); i++, up = up.parentElement) {
      if (!singlePost(up)) break;
      card = up;
    }
    return card;
  }

  function singlePost(box) {
    const ids = new Set();
    const own = postIdOf(box);
    if (own) ids.add(own);
    for (const c of box.querySelectorAll(CANDIDATES)) {
      const id = postIdOf(c);
      if (id) ids.add(id);
      if (ids.size > 1) return false;
    }
    return true;
  }

  function scanFeed() {
    if (!enabled || blocked) return;
    attach(hideCss, true);                             // re-assert if the page dropped it
    const want = [];
    for (const el of document.querySelectorAll(CANDIDATES)) {
      const id = postIdOf(el);
      if (!id) continue;
      if (posts.has(id)) {
        if (posts.get(id)) {
          const box = containerOf(el);
          if (!box.hasAttribute("data-cl-nsfw")) box.setAttribute("data-cl-nsfw", "");
        }
      } else if (!inflight.has(id)) {
        inflight.add(id);
        want.push(id);
      }
    }
    if (want.length) lookup(want);
  }

  async function lookup(ids) {
    if (Date.now() < backoffUntil) { ids.forEach(i => inflight.delete(i)); return; }
    let anyOk = false;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const ok = await fetchPosts(chunk);
      chunk.forEach(x => inflight.delete(x));
      if (!ok) { backoffUntil = Date.now() + 30000; ids.slice(i + 100).forEach(x => inflight.delete(x)); break; }
      anyOk = true;
    }
    if (anyOk) scanFeed();
  }

  let debounce = null;
  const scheduleScan = () => { clearTimeout(debounce); debounce = setTimeout(scanFeed, 250); };

  // ---------------------------------------------------------------- wiring
  // Hide a subreddit/profile/post page from the very first paint, before the config is even read;
  // released straight away if the filter turns out to be off.
  if (hasChecks(classify(location.pathname))) setChecking(true);

  (async () => {
    await loadConfig();
    await checkPage();
    scanFeed();

    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });

    // Reddit is a single-page app. Its History API calls happen in the page's world, which a content
    // script can't hook, so watch the URL instead.
    let lastHref = location.href;
    const onNav = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      checkPage();
      scheduleScan();
    };
    setInterval(onNav, 150);
    window.addEventListener("popstate", onNav);

    chrome.storage.onChanged.addListener((_c, area) => {
      if (area !== "managed") return;
      loadConfig().then(() => { checkPage(); scanFeed(); });
    });
  })();
})();
