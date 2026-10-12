// ISOLATED world: hook.js (world: MAIN) patches fetch/XHR in page context and
// forwards matches via window.postMessage. This file only listens + UI + storage.
(function () {
  const EVENT_TYPE = "OG_LOCATION_CAPTURE";

  // --- 2a. Parse PUT /locations shape ---
  // {"locations":[[lat,lng,{heading}],...],"bounds":{zoom,lat,lng,diameter}}
  function parseLocations(text) {
    try {
      const j = JSON.parse(text);
      const locs = Array.isArray(j.locations) ? j.locations : [];
      const out = locs.map((arr, i) => {
        if (!Array.isArray(arr)) return null;
        const lat = Number(arr[0]);
        const lng = Number(arr[1]);
        const heading = arr[2] && typeof arr[2].heading === "number" ? arr[2].heading : null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { i: i + 1, lat, lng, heading };
      }).filter(Boolean);
      const bounds = j.bounds || null;
      return out.length ? { rounds: out, bounds } : null;
    } catch { return null; }
  }

  // --- 2b. Parse SingleImageSearch (json+protobuf, nested arrays) ---
  // Request ex: [...,[[null,null,37.75,138.88],50],...] -> req lat/lng at depth.
  // Response: unknown shape -> deep-scan for lat/lng pairs + pano-ish strings.
  function deepFindLatLng(node, out, depth) {
    if (out.length >= 25 || depth > 12) return;
    if (Array.isArray(node)) {
      // adjacent numeric pair [lat, lng] possibly followed by more elements
      for (let i = 0; i + 1 < node.length; i++) {
        const a = node[i], b = node[i + 1];
        if (typeof a === "number" && typeof b === "number" &&
            a >= -90 && a <= 90 && b >= -180 && b <= 180 &&
            (Math.abs(a) > 0.001 || Math.abs(b) > 0.001) &&
            (String(a).includes(".") || String(b).includes("."))) {
          out.push({ lat: a, lng: b });
          if (out.length >= 25) return;
        }
      }
      for (const v of node) deepFindLatLng(v, out, depth + 1);
    } else if (node && typeof node === "object") {
      // {lat,lng} / {latitude,longitude} style objects
      const la = node.lat ?? node.latitude;
      const ln = node.lng ?? node.lon ?? node.longitude;
      if (typeof la === "number" && typeof ln === "number" &&
          la >= -90 && la <= 90 && ln >= -180 && ln <= 180) {
        out.push({ lat: la, lng: ln });
      }
      for (const k of Object.keys(node)) deepFindLatLng(node[k], out, depth + 1);
    }
  }

  function deepFindStrings(node, out, depth) {
    if (out.length >= 25 || depth > 12) return;
    if (typeof node === "string") {
      // pano ids / place ids are long alnum/_/- strings; skip tiny ones and urls
      if (/^[A-Za-z0-9_\-]{12,}$/.test(node) && !/^https?:/.test(node)) out.push(node.slice(0, 200));
      return;
    }
    if (Array.isArray(node)) { for (const v of node) deepFindStrings(v, out, depth + 1); }
    else if (node && typeof node === "object") { for (const k of Object.keys(node)) deepFindStrings(node[k], out, depth + 1); }
  }

  function dedupeCoords(arr) {
    const seen = new Set(); const out = [];
    for (const c of arr) {
      const k = c.lat.toFixed(5) + "," + c.lng.toFixed(5);
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
    return out.slice(0, 10);
  }

  function parseSIS(reqBody, respText) {
    let reqCoords = [];
    try { if (reqBody) { const j = JSON.parse(reqBody); const tmp = []; deepFindLatLng(j, tmp, 0); reqCoords = dedupeCoords(tmp); } } catch {}
    let respCoords = [];
    let respIds = [];
    let respJson = null;
    try {
      // response may have ")]}'\n" XSSI prefix (Google RPC); strip it
      let t = (respText || "").replace(/^\)\]\}'\s*\n?/, "");
      respJson = JSON.parse(t);
      const tmp = []; deepFindLatLng(respJson, tmp, 0); respCoords = dedupeCoords(tmp);
      const s2 = []; deepFindStrings(respJson, s2, 0); respIds = [...new Set(s2)].slice(0, 10);
    } catch {
      // fall back: regex scan raw text for float pairs
      const re = /(-?\d{1,2}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})/g;
      const tmp = []; let m;
      while ((m = re.exec(respText || "")) && tmp.length < 10) {
        const la = parseFloat(m[1]), ln = parseFloat(m[2]);
        if (la >= -90 && la <= 90 && ln >= -180 && ln <= 180) tmp.push({ lat: la, lng: ln });
      }
      respCoords = dedupeCoords(tmp);
    }
    return { reqCoords, respCoords, respIds };
  }

  function pretty(text) {
    try {
      const t = String(text || "").replace(/^\)\]\}'\s*\n?/, "");
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch { return text; }
  }

  function mapsUrl(lat, lng) { return `https://www.google.com/maps?q=${lat},${lng}`; }
  function streetUrl(lat, lng, heading) {
    const h = typeof heading === "number" ? `&heading=${heading}` : "";
    return `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}${h}`;
  }

  // --- 3. Overlay UI (shared panel, kind-aware) ---
  let panel = null, bodyEl = null, metaEl = null, roundsEl = null, titleEl = null;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "og-location-inspector";
    panel.innerHTML = `
      <div class="og-header">
        <span class="og-dot"></span>
        <span class="og-title"><span class="og-kind"></span> → <span class="og-status"></span></span>
        <span class="og-btns">
          <button class="og-btn" data-act="copy">Copy JSON</button>
          <button class="og-btn" data-act="toggle">_</button>
          <button class="og-btn" data-act="close">×</button>
        </span>
      </div>
      <div class="og-meta"></div>
      <div class="og-rounds"></div>
      <pre class="og-body"></pre>
    `;
    const style = document.createElement("style");
    style.textContent = `
      #og-location-inspector { position: fixed; right: 12px; bottom: 12px; width: 420px; max-height: 72vh;
        display: flex; flex-direction: column; z-index: 2147483647; font-family: ui-monospace, Menlo, monospace;
        font-size: 12px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0,0,0,.5); overflow: hidden; }
      #og-location-inspector .og-header { display:flex; align-items:center; gap:8px; padding:8px 10px;
        background:#1f2937; border-bottom:1px solid #374151; cursor:move; user-select:none; }
      #og-location-inspector .og-dot { width:9px; height:9px; border-radius:50%; background:#22c55e; flex-shrink:0; }
      #og-location-inspector .og-dot.sis { background:#60a5fa; }
      #og-location-inspector .og-title { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #og-location-inspector .og-btns { display:flex; gap:4px; }
      #og-location-inspector .og-btn { background:#374151; color:#fff; border:none; border-radius:6px;
        padding:2px 8px; cursor:pointer; font-size:11px; }
      #og-location-inspector .og-btn:hover { background:#4b5563; }
      #og-location-inspector .og-meta { padding:6px 10px; color:#9ca3af; font-size:11px; border-bottom:1px solid #1f2937;
        word-break:break-all; max-height:90px; overflow:auto; white-space:pre-wrap; }
      #og-location-inspector .og-rounds { padding:6px 10px; display:flex; flex-direction:column; gap:6px;
        overflow:auto; max-height:32vh; }
      #og-location-inspector .og-round { background:#1f2937; border-radius:8px; padding:6px 8px; }
      #og-location-inspector .og-round b { color:#fff; }
      #og-location-inspector .og-round .og-coords { color:#e5e7eb; }
      #og-location-inspector .og-round .og-links, #og-location-inspector .og-kv-links { margin-top:4px; display:flex; gap:6px; flex-wrap:wrap; }
      #og-location-inspector .og-round a, #og-location-inspector .og-round button,
      #og-location-inspector .og-kv a, #og-location-inspector .og-kv button {
        font-size:11px; color:#fff; background:#374151; border-radius:6px; padding:2px 8px;
        text-decoration:none; border:none; cursor:pointer; }
      #og-location-inspector .og-round a:hover, #og-location-inspector .og-round button:hover,
      #og-location-inspector .og-kv a:hover, #og-location-inspector .og-kv button:hover { background:#4b5563; }
      #og-location-inspector .og-kv { background:#1f2937; border-radius:8px; padding:6px 8px; }
      #og-location-inspector .og-kv .og-tag { color:#93c5fd; font-size:10px; text-transform:uppercase; }
      #og-location-inspector .og-body { margin:0; padding:10px; overflow:auto; white-space:pre-wrap; word-break:break-word;
        max-height:24vh; border-top:1px solid #1f2937; color:#9ca3af; }
      #og-location-inspector.collapsed .og-meta, #og-location-inspector.collapsed .og-rounds,
      #og-location-inspector.collapsed .og-body { display:none; }
    `;
    document.head.appendChild(style);
    document.documentElement.appendChild(panel);

    bodyEl = panel.querySelector(".og-body");
    metaEl = panel.querySelector(".og-meta");
    roundsEl = panel.querySelector(".og-rounds");
    titleEl = panel.querySelector(".og-kind");

    panel.querySelectorAll(".og-header .og-btn").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === "close") { panel.remove(); panel = null; }
        if (act === "toggle") panel.classList.toggle("collapsed");
        if (act === "copy" && bodyEl) navigator.clipboard.writeText(bodyEl.textContent || "");
      });
    });

    const header = panel.querySelector(".og-header");
    let sx, sy, ox, oy, drag = false;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".og-btn")) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.left = ox + "px"; panel.style.right = "auto";
      panel.style.top = oy + "px"; panel.style.bottom = "auto";
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      panel.style.left = ox + e.clientX - sx + "px";
      panel.style.top = oy + e.clientY - sy + "px";
    });
    window.addEventListener("mouseup", () => (drag = false));
  }

  function coordRow(container, tag, c, heading) {
    const div = document.createElement("div");
    div.className = "og-kv";
    const coordText = `${c.lat}, ${c.lng}`;
    div.innerHTML = `<div class="og-tag">${tag}</div><div>${coordText}` +
      (heading != null ? ` hdg ${Number(heading).toFixed(1)}°` : "") + `</div><div class="og-kv-links"></div>`;
    const links = div.querySelector(".og-kv-links");
    const a1 = document.createElement("a");
    a1.href = mapsUrl(c.lat, c.lng); a1.target = "_blank"; a1.textContent = "Maps";
    const a2 = document.createElement("a");
    a2.href = streetUrl(c.lat, c.lng, heading); a2.target = "_blank"; a2.textContent = "Street View";
    const cp = document.createElement("button");
    cp.textContent = "Copy";
    cp.onclick = () => navigator.clipboard.writeText(coordText);
    links.append(a1, a2, cp);
    container.appendChild(div);
  }

  function renderLocations(parsed) {
    parsed.rounds.forEach((r) => {
      const div = document.createElement("div");
      div.className = "og-round";
      const coordText = `${r.lat}, ${r.lng}`;
      div.innerHTML = `<b>R${r.i}</b> <span class="og-coords">${coordText}</span>` +
        (r.heading != null ? ` <span class="og-coords">hdg ${r.heading.toFixed(1)}°</span>` : "") +
        `<div class="og-links"></div>`;
      const links = div.querySelector(".og-links");
      const a1 = document.createElement("a");
      a1.href = mapsUrl(r.lat, r.lng); a1.target = "_blank"; a1.textContent = "Maps";
      const a2 = document.createElement("a");
      a2.href = streetUrl(r.lat, r.lng, r.heading); a2.target = "_blank"; a2.textContent = "Street View";
      const cp = document.createElement("button");
      cp.textContent = "Copy";
      cp.onclick = () => navigator.clipboard.writeText(coordText);
      links.append(a1, a2, cp);
      roundsEl.appendChild(div);
    });
  }

  window.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== EVENT_TYPE) return;
    const { kind, label, url, method, requestBody, status, responseText } = e.data;
    const ts = new Date().toISOString();
    const formatted = pretty(responseText || "");

    let storePayload = { kind, label, url, method, requestBody, status, responseText: formatted, ts };
    let metaText = `${method} ${url}\nreq: ${(requestBody || "(empty)").slice(0, 2000)}\n${ts}`;

    ensurePanel();
    if (!panel) return;
    roundsEl.innerHTML = "";
    panel.querySelector(".og-status").textContent = `${status}`;
    panel.querySelector(".og-kind").textContent = label || kind;
    panel.querySelector(".og-dot").className = "og-dot" + (kind === "single-image-search" ? " sis" : "");

    if (kind === "locations") {
      const parsed = parseLocations(responseText || "");
      storePayload.parsed = parsed;
      if (parsed) {
        const b = parsed.bounds;
        metaText = `${method} ${url}\nreq: ${requestBody || "(empty)"}` +
          (b ? `\nbounds: lat ${b.lat}, lng ${b.lng}, zoom ${b.zoom}` : "") + `\n${ts}`;
        renderLocations(parsed);
      } else {
        roundsEl.innerHTML = "<div style='color:#9ca3af'>Could not parse locations.</div>";
      }
    } else if (kind === "single-image-search") {
      const sis = parseSIS(requestBody, responseText);
      storePayload.parsedSIS = sis;
      metaText = `${method} ${url}\nreq: ${(requestBody || "(empty)").slice(0, 2000)}\n${ts}`;
      if (sis.reqCoords.length) sis.reqCoords.forEach((c) => coordRow(roundsEl, "request coords", c, null));
      else {
        const d = document.createElement("div");
        d.style.color = "#9ca3af"; d.textContent = "No coords found in request body.";
        roundsEl.appendChild(d);
      }
      if (sis.respCoords.length) sis.respCoords.forEach((c, i) => coordRow(roundsEl, "response coords #" + (i + 1), c, null));
      if (sis.respIds.length) {
        const d = document.createElement("div");
        d.className = "og-kv";
        d.innerHTML = `<div class="og-tag">response ids (${sis.respIds.length})</div>`;
        const pre = document.createElement("div");
        pre.style.wordBreak = "break-all"; pre.style.color = "#e5e7eb";
        pre.textContent = sis.respIds.join("\n");
        d.appendChild(pre);
        roundsEl.appendChild(d);
      }
      if (!sis.respCoords.length && !sis.respIds.length) {
        const d = document.createElement("div");
        d.style.color = "#9ca3af"; d.textContent = "Response parsed as JSON but no coords/ids extracted — see raw JSON below.";
        roundsEl.appendChild(d);
      }
    }

    metaEl.textContent = metaText;
    bodyEl.textContent = formatted;

    try {
      if (kind === "locations") chrome.storage.local.set({ ogLast: storePayload });
      else chrome.storage.local.set({ ogLastSIS: storePayload });
      chrome.runtime.sendMessage({ type: "OG_CAPTURED", kind, status }).catch?.(() => {});
    } catch (_) {}

    panel.classList.remove("collapsed");
    panel.style.display = "flex";
    console.log("[OpenGuessr Inspector]", kind, method, url, status, storePayload.parsed || storePayload.parsedSIS || formatted);
  });
})();
