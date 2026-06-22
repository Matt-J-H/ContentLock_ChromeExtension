// ContentLock keyword scanner. Reads blocked words from the managed config and, if any
// appears as a whole word in the page text, sends the tab to the blocked page. Whole-word
// matching mirrors the Android behavior (so "sex" won't catch "essex"; add stems explicitly).

let regex = null;
let scanning = false;

function buildRegex(words) {
  const cleaned = (words || []).map(w => (w || "").trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(" + escaped.join("|") + ")\\b", "i");
}

async function loadWords() {
  try {
    const m = await chrome.storage.managed.get("configJson");
    if (m && m.configJson) {
      const cfg = JSON.parse(m.configJson);
      regex = buildRegex(cfg.keywords);
    }
  } catch (e) { regex = null; }
}

function scan() {
  if (!regex || scanning) return;
  scanning = true;
  try {
    const text = (document.body && document.body.innerText) ? document.body.innerText : "";
    if (regex.test(text)) {
      location.replace(chrome.runtime.getURL("blocked.html") + "?r=keyword");
    }
  } finally {
    scanning = false;
  }
}

let debounce = null;
function scheduleScan() {
  clearTimeout(debounce);
  debounce = setTimeout(scan, 400);
}

(async () => {
  await loadWords();
  scan();
  const obs = new MutationObserver(scheduleScan);
  if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  chrome.storage.onChanged.addListener((_c, area) => { if (area === "managed") loadWords().then(scan); });
})();

