// Service worker: badge counter + keep last capture accessible.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "OG_CAPTURED") {
    if (msg.kind === "single-image-search") {
      chrome.action.setBadgeText({ text: "SIS" });
      chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    } else {
      chrome.action.setBadgeText({ text: "●" });
      chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ogLastSIS) {
    chrome.action.setBadgeText({ text: "SIS" });
    chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
  } else if (changes.ogLast) {
    chrome.action.setBadgeText({ text: "●" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
  }
});
