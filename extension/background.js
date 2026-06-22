// ContentLock background service worker.
// Reads the managed config (pushed by the Windows service into the browser's managed policy)
// and turns the site rules into declarativeNetRequest dynamic rules. Allow (whitelist) rules
// win over block rules via higher priority, so an allowed subpath survives a blocked parent.

const BLOCK_PRIORITY = 1;
const ALLOW_PRIORITY = 2;

async function readConfig() {
  try {
    const m = await chrome.storage.managed.get("configJson");
    if (m && m.configJson) return JSON.parse(m.configJson);
  } catch (e) { /* ignore */ }
  return { rules: [], keywords: [], genericPorn: true };
}

function urlFilterFor(rule) {
  // "||host^" matches the whole host; "||host/path" matches that path prefix.
  const host = (rule.host || "").toLowerCase();
  const path = rule.pathPrefix || "";
  return path ? `||${host}${path}` : `||${host}^`;
}

async function rebuildRules() {
  const cfg = await readConfig();
  const dynamic = [];
  let id = 1;

  for (const r of cfg.rules || []) {
    if (!r.host) continue;
    if (r.whitelist) {
      dynamic.push({
        id: id++,
        priority: ALLOW_PRIORITY,
        action: { type: "allow" },
        condition: { urlFilter: urlFilterFor(r), resourceTypes: ["main_frame", "sub_frame"] }
      });
    } else {
      dynamic.push({
        id: id++,
        priority: BLOCK_PRIORITY,
        action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
        condition: { urlFilter: urlFilterFor(r), resourceTypes: ["main_frame"] }
      });
    }
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(x => x.id),
    addRules: dynamic
  });
}

chrome.runtime.onInstalled.addListener(rebuildRules);
chrome.runtime.onStartup.addListener(rebuildRules);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "managed") rebuildRules();
});

// Build once on worker spin-up too.
rebuildRules();
