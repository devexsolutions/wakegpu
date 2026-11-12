"use strict";
// ---------------- ComfyUI user-data backup: status line under the GPU session card ----------------
// Relies on app.js globals: $, esc, api, toast, gst, page, renderStatus.

const UD = { st: null, busy: false };

function udTime(t) {
  if (!t) return "";
  const d = new Date(t * 1000), now = new Date();
  const hm = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

function udRender() {
  const st = UD.st, ready = gst && gst.state === "ready";
  const text = $("#udText"), dot = $("#udDot");
  if (!text) return;
  let s = i18n.t("console_userdata").replace("—", ""), cls = "";
  if (!st) s += "—";
  else if (!st.enabled) s += "desactivada (actívala en Ajustes)";
  else if (st.running === "restore" || (UD.busy && !st.running)) { s += st.running === "restore" ? "restaurando…" : "respaldando…"; cls = "busy"; }
  else if (st.running === "backup") { s += "respaldando…"; cls = "busy"; }
  else if (st.last_backup) { s += `última ${udTime(st.last_backup)} · ${st.files} archivo${st.files === 1 ? "" : "s"}`; cls = "ok"; }
  else s += st.files ? `${st.files} archivo${st.files === 1 ? "" : "s"}` : "sin copia aún";
  let html = esc(s);
  if (st && st.enabled && st.error) { html += ` · <span class="ud-err">${esc(st.error)}</span>`; cls = "warn"; }
  text.innerHTML = html;
  text.title = st && st.skipped && st.skipped.length ? "No respaldados:\n" + st.skipped.slice(0, 20).join("\n") : (st && st.dir ? "Guardado en " + st.dir : "");
  dot.className = "ud-dot " + cls;
  const b = $("#btnUdBackup");
  b.disabled = UD.busy || !ready || !(st && st.enabled);
  b.title = !ready ? i18n.t("console_userdata_not_ready") : i18n.t("console_userdata_title");
}

async function udRefresh() {
  try { UD.st = await api("/api/userdata/status"); } catch { }
  udRender();
}

$("#btnUdBackup").onclick = async () => {
  UD.busy = true; udRender();
  try {
    const r = await api("/api/userdata/backup", { json: {} });
    UD.st = r.status;
    const n = r.result.downloaded, t = r.result.trashed;
    toast(n || t ? `Respaldado: ${n} archivo${n === 1 ? "" : "s"} actualizado${n === 1 ? "" : "s"}${t ? `, ${t} eliminado${t === 1 ? "" : "s"} movido${t === 1 ? "" : "s"} a la papelera` : ""}` : "Respaldado, sin cambios");
  } catch (e) { toast("Error al respaldar: " + e.message); await udRefresh(); }
  finally { UD.busy = false; udRender(); }
};
$("#btnUdOpen").onclick = () => api("/api/userdata/open", { json: {} }).catch(e => toast(e.message));

// follow the GPU state (renderStatus runs on every status change) and poll while the console is visible
const _udRS = renderStatus;
renderStatus = function () { _udRS(); udRender(); };
setInterval(() => { if (page === "console") udRefresh(); }, 15000);
udRefresh();
