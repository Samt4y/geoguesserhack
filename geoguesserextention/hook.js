// MAIN world: runs in page context (manifest "world": "MAIN"), so no CSP issue.
// Patches fetch/XHR and forwards matching captures to the ISOLATED content script.
(function () {
  const RULES = [
    { kind: "locations", label: "PUT /locations", method: "PUT", substr: "accounts.openguessr.com/locations" },
    { kind: "single-image-search", label: "SingleImageSearch", method: "POST", substr: "SingleImageSearch" },
  ];
  const EVENT_TYPE = "OG_LOCATION_CAPTURE";

  function matchKind(url, method) {
    if (!url) return null;
    const u = String(url);
    const m = String(method || "GET").toUpperCase();
    for (const r of RULES) {
      if (m === r.method && u.includes(r.substr)) return r;
    }
    // SingleImageSearch via XHR sometimes reports method "" until send; fallback on substr
    for (const r of RULES) {
      if (r.kind === "single-image-search" && u.includes(r.substr)) return r;
    }
    return null;
  }

  function emit(capture) {
    window.postMessage(Object.assign({ type: EVENT_TYPE }, capture), "*");
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    let reqBody;
    try { reqBody = init && init.body !== undefined ? String(init.body).slice(0, 20000) : undefined; } catch (e) {}
    let res;
    try {
      res = await origFetch.apply(this, arguments);
    } catch (err) { throw err; }
    const rule = matchKind(url, method);
    if (rule) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        emit({ kind: rule.kind, label: rule.label, url: String(url), method: String(method).toUpperCase(), requestBody: reqBody || null, status: res.status, responseText: text.slice(0, 500000) });
      } catch (e) {}
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._ogMethod = method;
    this._ogUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      try {
        const rule = matchKind(this._ogUrl, this._ogMethod || "POST");
        if (rule) {
          let resp = "";
          try { resp = this.responseText || ""; } catch (e) {}
          emit({ kind: rule.kind, label: rule.label, url: String(this._ogUrl), method: String(this._ogMethod || "POST").toUpperCase(), requestBody: body ? String(body).slice(0, 20000) : null, status: this.status, responseText: (resp || "").slice(0, 500000) });
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
