const metaEl = document.getElementById("meta");
const bodyEl = document.getElementById("body");
const roundsEl = document.getElementById("rounds");
const tabLoc = document.getElementById("tabLoc");
const tabSis = document.getElementById("tabSis");

let activeTab = "loc";
let cache = { loc: null, sis: null };

function mapsUrl(lat, lng) { return `https://www.google.com/maps?q=${lat},${lng}`; }
function streetUrl(lat, lng, heading) {
  const h = typeof heading === "number" ? `&heading=${heading}` : "";
  return `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}${h}`;
}

function coordBlock(tag, coordsText, lat, lng, heading) {
  const div = document.createElement("div");
  div.className = "round";
  const top = document.createElement("div");
  top.innerHTML = `<b>${tag}</b> <span>${coordsText}</span>`;
  const links = document.createElement("div");
  links.className = "links";
  const a1 = document.createElement("a");
  a1.href = mapsUrl(lat, lng); a1.target = "_blank"; a1.textContent = "Maps";
  const a2 = document.createElement("a");
  a2.href = streetUrl(lat, lng, heading); a2.target = "_blank"; a2.textContent = "Street View";
  const cp = document.createElement("button");
  cp.textContent = "Copy";
  cp.onclick = () => navigator.clipboard.writeText(coordsText);
  links.append(a1, a2, cp);
  div.append(top, links);
  roundsEl.appendChild(div);
}

function render() {
  roundsEl.innerHTML = "";
  const d = activeTab === "loc" ? cache.loc : cache.sis;
  tabLoc.classList.toggle("active", activeTab === "loc");
  tabSis.classList.toggle("active", activeTab === "sis");
  if (!d) {
    metaEl.textContent = activeTab === "loc"
      ? "No PUT /locations capture yet — play a round on openguessr.com."
      : "No SingleImageSearch capture yet — trigger a Street View image load.";
    bodyEl.textContent = "—";
    return;
  }
  const reqShort = (d.requestBody || "(empty)").slice(0, 2000);
  metaEl.textContent = `${d.method || ""} ${d.url || ""}\nstatus: ${d.status ?? "?"}\nreq: ${reqShort}\n${d.ts || ""}`;

  if (d.parsed && d.parsed.rounds) {
    d.parsed.rounds.forEach((r) => {
      const coords = `${r.lat}, ${r.lng}`;
      const hdg = r.heading != null ? `  hdg ${Number(r.heading).toFixed(1)}°` : "";
      coordBlock("R" + r.i, coords + hdg, r.lat, r.lng, r.heading);
    });
    if (d.parsed.bounds) {
      const b = document.createElement("div");
      b.className = "bounds";
      b.textContent = `bounds: lat ${d.parsed.bounds.lat}, lng ${d.parsed.bounds.lng}, zoom ${d.parsed.bounds.zoom}`;
      roundsEl.appendChild(b);
    }
  } else if (d.parsedSIS) {
    const sis = d.parsedSIS;
    (sis.reqCoords || []).forEach((c) => coordBlock("REQ", `${c.lat}, ${c.lng}`, c.lat, c.lng, null));
    (sis.respCoords || []).forEach((c, i) => coordBlock("RESP#" + (i + 1), `${c.lat}, ${c.lng}`, c.lat, c.lng, null));
    if ((sis.respIds || []).length) {
      const b = document.createElement("div");
      b.className = "bounds";
      b.textContent = "ids:\n" + sis.respIds.join("\n");
      roundsEl.appendChild(b);
    }
    if (!(sis.reqCoords || []).length && !(sis.respCoords || []).length && !(sis.respIds || []).length) {
      const b = document.createElement("div");
      b.className = "bounds";
      b.textContent = "No coords/ids extracted — see raw JSON below.";
      roundsEl.appendChild(b);
    }
  }

  bodyEl.textContent = d.responseText || "(empty response)";
}

function refresh() {
  chrome.storage.local.get(["ogLast", "ogLastSIS"], (v) => {
    cache.loc = v.ogLast || null;
    cache.sis = v.ogLastSIS || null;
    render();
  });
}

tabLoc.onclick = () => { activeTab = "loc"; render(); };
tabSis.onclick = () => { activeTab = "sis"; render(); };

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.ogLast) { cache.loc = c.ogLast.newValue || null; if (activeTab === "loc") render(); }
  if (c.ogLastSIS) { cache.sis = c.ogLastSIS.newValue || null; if (activeTab === "sis") render(); }
});

document.getElementById("copy").onclick = () => {
  navigator.clipboard.writeText(bodyEl.textContent || "");
};
document.getElementById("clear").onclick = () => {
  if (activeTab === "loc") chrome.storage.local.remove("ogLast", refresh);
  else chrome.storage.local.remove("ogLastSIS", refresh);
  chrome.action.setBadgeText({ text: "" });
};

refresh();
