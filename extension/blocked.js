// Explains WHY a page was blocked, from the ?r= reason the redirect carries. (MV3 extension pages
// can't run inline script, hence a file.)
const REASONS = {
  "reddit-nsfw": "Reddit marks this as NSFW. ContentLock's Reddit filter blocks NSFW subreddits, " +
                 "profiles and posts while leaving the rest of Reddit alone. To turn it off, open " +
                 "ContentLock and unlock it (the change waits out your countdown).",
  "keyword": "This page contains a word on your block list. To change what's blocked, open " +
             "ContentLock and unlock it (the change waits out your countdown)."
};
const why = REASONS[new URLSearchParams(location.search).get("r")];
if (why) document.getElementById("why").textContent = why;
