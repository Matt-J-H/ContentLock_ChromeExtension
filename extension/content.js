// ContentLock content script.
//   (1) Keyword scanner: if a blocked word appears as a whole word in the page text, block.
//   (2) SPA path guard: declarativeNetRequest only blocks real main_frame navigations, so a
//       single-page app that goes from an allowed subpath (poe.com/123) to a blocked one
//       (poe.com/111) via the History API never triggers DNR. This watches client-side URL
//       changes and blocks non-whitelisted paths, mirroring the site-rule semantics.

let regex = null;
let rules = [];
let scanning = false;

function buildRegex(words) {
  const cleaned = (words || []).map(w => (w || "").trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(" + escaped.join("|") + ")\\b", "i");
}

async function loadConfig() {
  try {
    const m = await chrome.storage.managed.get("configJson");
    if (m && m.configJson) {
      const cfg = JSON.parse(m.configJson);
      regex = buildRegex(cfg.keywords);
      rules = Array.isArray(cfg.rules) ? cfg.rules : [];
      return;
    }
  } catch (e) { /* fall through */ }
  regex = null; rules = [];
}

// ---- site-rule path evaluation (mirrors BlockEngine + the DNR allow > block priority) ----
function hostMatches(ruleHost, host) {
  ruleHost = (ruleHost || "").toLowerCase();
  return host === ruleHost || host.endsWith("." + ruleHost);
}

function pathShouldBlock() {
  const host = location.hostname.toLowerCase();
  const path = location.pathname || "/";
  // A whitelist rule wins, like the higher-priority allow DNR rule. Empty pathPrefix = whole host.
  const allowed = rules.some(r => r.whitelist && hostMatches(r.host, host) && path.startsWith(r.pathPrefix || ""));
  if (allowed) return false;
  return rules.some(r => !r.whitelist && hostMatches(r.host, host) && path.startsWith(r.pathPrefix || ""));
}

function checkPath() {
  if (pathShouldBlock()) location.replace(chrome.runtime.getURL("blocked.html") + "?r=path");
}

// ---- keyword scan ----
function scan() {
  if (!regex || scanning) return;
  scanning = true;
  try {
    const text = (document.body && document.body.innerText) ? document.body.innerText : "";
    if (regex.test(text)) location.replace(chrome.runtime.getURL("blocked.html") + "?r=keyword");
  } finally {
    scanning = false;
  }
}

let debounce = null;
function scheduleScan() { clearTimeout(debounce); debounce = setTimeout(scan, 400); }

// ---- SPA navigation detection ----
function hookHistory() {
  const fire = () => setTimeout(() => { checkPath(); scheduleScan(); }, 0);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    if (typeof orig === "function") {
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    }
  }
  window.addEventListener("popstate", fire);
  window.addEventListener("hashchange", fire);
  // Safety net for routers that mutate the URL without the hooked methods.
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; fire(); } }, 700);
}

(async () => {
  await loadConfig();
  checkPath();   // also covers the initial load (DNR covers direct navigations too)
  scan();
  hookHistory();
  const obs = new MutationObserver(scheduleScan);
  if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === "managed") loadConfig().then(() => { checkPath(); scan(); });
  });
})();
