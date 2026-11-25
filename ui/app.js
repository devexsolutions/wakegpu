"use strict";
const KEY = new URLSearchParams(location.search).get("k") || "";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const o = { ...opts, headers: { "X-Key": KEY, ...(opts.headers || {}) } };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers["Content-Type"] = "application/json"; o.method = o.method || "POST"; }
  const r = await fetch(path, o);
  let data = null;
  try { data = await r.json(); } catch { }
  if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
  return data;
}
const fileURL = p => "/api/file?k=" + KEY + "&path=" + encodeURIComponent(p);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2600); }
function fmtDur(s) { if (s == null) return "—"; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; }
function fmtTime(t) { if (!t) return ""; const d = new Date(t * 1000); return d.toLocaleString("es-ES", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function fmtSize(b) { return b > 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }

// ---------------- navigation ----------------
let page = "console";
$$("nav button, .mob-nav button").forEach(b => b.onclick = () => show(b.dataset.page));
function show(p) {
  page = p;
  $$("nav button, .mob-nav button").forEach(b => b.classList.toggle("on", b.dataset.page === p));
  $$(".page").forEach(s => s.classList.toggle("on", s.id === "page-" + p));
  if (p === "gen") {
    const banner = $("#genSimpleBanner");
    if (banner) banner.hidden = (typeof getExpMode === "function" && getExpMode() !== "simple");
  }
  if (p === "results") loadFiles();
  if (p === "queue") loadJobs();
  if (p === "lib") loadLib();
  if (p === "settings") loadLocal();
  if (p === "ai" && typeof aiRender === "function") aiRender();
}

// ---------------- gate status ----------------
const STATE_CN = new Proxy({}, { get: (_, k) => i18n.t("state_" + k) });
const BUSY = new Set(["allocating", "installing", "downloading", "booting", "smoke_testing", "switching", "stopping"]);
const STEPS = [["allocating", "Asignar máquina"], ["installing", "Instalar dependencias"], ["downloading", "Descargar modelos"], ["booting", "Iniciar"], ["smoke_testing", "Comprobación"], ["ready", "Listo"]];
const REASON_CN = new Proxy({}, { get: (_, k) => i18n.t("reason_" + k) });
let gst = null, gerr = "", kitReady = null;
const stepSeen = {}; // state -> first local time seen in this session
let stepSession = null;

async function pollStatus() {
  try { gst = await api("/api/gate/status"); gerr = ""; }
  catch (e) { gst = null; gerr = e.message; }
  renderStatus();
  const k = (gst ? "1" : "0") + (gst && gst.default_accelerator || "");
  if (!isLocal() && k !== pollStatus.accKey) { pollStatus.accKey = k; renderExtras(); }
}
function clock(sec) {
  if (sec == null || isNaN(sec)) return "--:--";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function human(sec) {
  if (sec == null) return "—";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + " s";
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}
function profileTitle(id) {
  const p = profiles && profiles.profiles && profiles.profiles.find(x => x.id === id);
  return p ? (p.title || p.id) : id;
}
function stateClass(s) { return s === "ready" ? "ok" : BUSY.has(s) ? "busy" : s === "failed" ? "bad" : "idle"; }

function renderStatus() {
  const s = gst && gst.state;
  const cls = gst ? stateClass(s) : "bad";
  const label = gst ? (STATE_CN[s] || s) : (gerr ? "Desconectado" : "—");
  const now = Date.now() / 1000;

  // chips / sidebar
  $("#dot").className = "dot s-" + cls;
  $("#stateChip").innerHTML = `<span class="dot s-${cls}"></span>GPU · ${esc(label)}`;
  $("#sideStateText").textContent = label;
  $("#dotBig").className = "ring " + cls;
  $("#stateBig").textContent = label;

  // subtitle: profile pill (+ stop reason when asleep)
  let sub = "";
  if (gst && gst.profile && s !== "sleeping") sub += `<span class="pill">${esc(profileTitle(gst.profile))}</span>`;
  if (gst && gst.zero_waste && gst.zero_waste.enabled && s === "ready") sub += ` <span class="pill sm zw" title="Guardián Zero-Waste activo: apagado rápido tras finalizar la cola">Zero-Waste</span>`;
  if (gst && (s === "sleeping" || s === "failed") && gst.reason) {
    const key = Object.keys(REASON_CN).find(k => gst.reason.includes(k));
    sub += `<span class="muted">${s === "failed" ? "Motivo del error" : "Última parada"}：${esc(key ? REASON_CN[key] : gst.reason)}</span>`;
  }
  if (!gst) sub = `<span class="muted">${esc(gerr.includes("网关地址") || gerr.includes("dirección de pasarela") ? "Configura la dirección de la pasarela en Ajustes" : "No se puede conectar con la pasarela")}</span>`;
  $("#stateSub").innerHTML = sub;

  // stepper & stage times
  const started = gst && gst.session_started;
  if (started && stepSession !== started) { stepSession = started; for (const k in stepSeen) delete stepSeen[k]; kitReady = kitReady && kitReady.session === started ? kitReady : null; }
  if (s && !stepSeen[s]) stepSeen[s] = s === "ready" && gst.since ? gst.since : now;
  const idx = STEPS.findIndex(x => x[0] === s);
  const showSteps = gst && (BUSY.has(s) || s === "ready" || s === "failed") && s !== "stopping";
  $("#steps").hidden = !showSteps;
  if (showSteps) {
    $("#steps").innerHTML = STEPS.map(([k, n], i) => {
      const st = s === "failed" ? (i < Math.max(idx, 0) ? "done" : "") : i < idx ? "done" : i === idx ? (k === "ready" ? "done" : "cur") : "";
      return `<li class="${st}"><span class="b">${st === "done" ? "✓" : i + 1}</span><span>${n}</span></li>`;
    }).join("");
  }

  // timer
  let tv = "--:--", tl = "Tiempo de inicio", tcls = "";
  if (gst && BUSY.has(s) && s !== "stopping" && started) { tv = clock(now - started); tl = "Iniciando · Transcurrido"; tcls = "live"; }
  else if (gst && s === "ready" && started) {
    const boot = (gst.since && gst.since >= started) ? gst.since - started : null;
    tv = boot != null ? clock(boot) : "--:--"; tl = "Tiempo de arranque actual";
    if (boot != null) try { localStorage.setItem("ckwb.lastBoot", String(boot)); } catch { }
  } else {
    let last = null; try { last = localStorage.getItem("ckwb.lastBoot"); } catch { }
    tv = last ? clock(+last) : "--:--"; tl = "Último tiempo de arranque";
  }
  $("#timerV").textContent = tv; $("#timerL").textContent = tl;
  $("#timerBox").className = "timer " + tcls;

  // download bar
  const dl = gst && gst.progress && gst.progress.download;
  const showDl = !!(dl && dl.total_gb > 0 && BUSY.has(s));
  $("#dlBox").hidden = !showDl;
  if (showDl) {
    $("#dlBar").style.width = Math.min(100, dl.done_gb / dl.total_gb * 100) + "%";
    $("#dlText").textContent = `Descargando modelos ${dl.done_gb.toFixed(1)} / ${dl.total_gb.toFixed(1)} GB · Archivos ${dl.files_done}/${dl.files_total}`;
    $("#dlEta").textContent = dl.gbps ? (dl.gbps / 8).toFixed(2) + " GB/s" : "";
  }

  // tiles
  const tiles = [];
  if (gst) {
    const running = !!started && s !== "sleeping";
    if (running) tiles.push(["Tiempo activo", clock(now - started), "Iniciado a las " + new Date(started * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })]);
    if (!running) { /* asleep: only CU tiles */ }
    else if (gst.remaining_s != null && s === "ready") {
      const total = gst.remaining_s + (now - started);
      tiles.push(["Tiempo restante", human(gst.remaining_s), `<div class="mini"><div style="width:${Math.max(0, Math.min(100, gst.remaining_s / total * 100))}%"></div></div>`, gst.warn ? "warn" : ""]);
    } else tiles.push(["Tiempo restante", "—", ""]);
    if (gst.cu) {
      tiles.push(["Saldo de CU", Number.isFinite(gst.cu.balance) ? gst.cu.balance.toFixed(2) : "—", gst.cu.error ? esc("No disponible temporalmente: " + gst.cu.error) : Number.isFinite(gst.cu.balance) && gst.cu.per_hour ? "Aprox. " + Math.floor(gst.cu.balance / gst.cu.per_hour) + " h restantes" : ""]);
      if (gst.cu.today != null) tiles.push(["Hoy / Este mes", `${(gst.cu.today || 0).toFixed(1)} / ${(gst.cu.month || 0).toFixed(1)}`, "CU"]);
      else if (isLocal()) {
        const rate = Number.isFinite(gst.cu.per_hour) && gst.cu.per_hour > 0 ? gst.cu.per_hour : 4.8;
        const estSpent = running ? ((now - started) / 3600) * rate : 0;
        const measSpent = (gst.zero_waste && gst.zero_waste.session_spent_cu) || 0;
        const liveCU = Math.max(estSpent, measSpent);
        const liveEUR = (liveCU * 0.10).toFixed(2);
        tiles.push(["Consumo sesión", running ? `${liveCU.toFixed(2)} CU` : "0.00 CU", running ? `≈ ${liveEUR} € · GPU ${gst.accelerator || "L4"}` : `GPU ${gst.accelerator || "—"}`]);
      }
      tiles.push(["Consumo estimado", Number.isFinite(gst.cu.per_hour) ? gst.cu.per_hour.toFixed(2) : "—", Number.isFinite(gst.cu.per_hour) ? `CU / h (≈ ${(gst.cu.per_hour * 0.10).toFixed(2)} €/h)` : "CU / hora"]);
    }
    if (!isLocal() && gst.default_accelerator) tiles.push(["Modelo GPU", running ? gst.accelerator : ($("#wakeAcc").value || gst.default_accelerator), running ? "Sesión actual" : "Próximo inicio"]);
    else if (gst.clients != null) tiles.push(["Clientes conectados", gst.clients, ""]);
  }
  $("#tiles").innerHTML = tiles.map(([k, v, x, c]) => `<div class="tile ${c || ""}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="x">${x || ""}</div></div>`).join("");
  $("#who").innerHTML = gst && gst.you ? `Sesión actual: ${esc(gst.you.email || "agente")}${gst.you.owner ? ' <span class="pill sm">Administrador</span>' : ""}` : "";
  $("#consoleErr").textContent = gerr && !gerr.includes("网关地址") && !gerr.includes("dirección de pasarela") ? "Error al conectar con la pasarela: " + gerr : "";

  // buttons
  const asleep = !gst || s === "sleeping" || s === "failed";
  const busy = gst && (gst.busy || BUSY.has(s));
  $("#wakeOpts").hidden = !asleep || !gst;
  $("#btnWake").hidden = !asleep; $("#btnWakeTop").hidden = !asleep;
  $("#btnWake").disabled = $("#btnWakeTop").disabled = !gst || wakePending;
  $("#btnStop").hidden = asleep; $("#btnStopTop").hidden = asleep;
  $("#btnStop").disabled = $("#btnStopTop").disabled = s === "stopping";
  $("#btnExtend").hidden = s !== "ready";
  $("#btnExtend").disabled = gst && gst.can_extend === false;
  $("#btnOpenComfy").hidden = s !== "ready";
  $("#topInfo").textContent = s === "ready" && gst.remaining_s != null ? "Restante " + human(gst.remaining_s) : busy && started ? "Iniciando " + clock(now - started) : "";
}
setInterval(() => { if (gst && gst.session_started && gst.state !== "sleeping") renderStatus(); }, 1000);

let profiles = null;
async function loadProfiles() {
  try { profiles = await api("/api/gate/profiles"); } catch { profiles = null; }
  const sel = $("#wakeProfile");
  if (!profiles || !profiles.profiles) { sel.innerHTML = `<option value="">` + i18n.t("sec_local_gpu_profile") + `</option>`; $("#wfBox").innerHTML = ""; return; }
  const cur = sel.value || (gst && gst.profile) || profiles.default;
  sel.innerHTML = profiles.profiles.map(p => `<option value="${esc(p.id)}">${esc(p.title || p.id)} · aprox. ${p.size_gb_default ?? "?"} GB</option>`).join("");
  if (cur) sel.value = cur;
  renderWf(); renderExtras();
  renderStatus();
}
function isLocal() { return (appCfg.mode || "gateway") === "local"; }
async function renderExtras() {
  const box = $("#extrasBox");
  if (!isLocal()) {
    const ok = !!(gst && gst.default_accelerator);   // gateway has the GPU-select patch
    $("#accWrap").hidden = !gst;
    $("#wakeAcc").disabled = !ok;
    if (!$("#wakeAcc").dataset.touched) {
      let last = ""; try { last = localStorage.getItem("ckwb.gwAcc") || ""; } catch { }
      $("#wakeAcc").value = ok ? (last || gst.default_accelerator) : ((gst && gst.accelerator) || "G4");
    }
    box.hidden = true;
    $("#localHint").hidden = ok || !gst;
    $("#localHint").innerHTML = ok ? "" : i18n.t("wake_local_hint");
    return;
  }
  $("#accWrap").hidden = false; $("#wakeAcc").disabled = false;
  const p = profiles && profiles.profiles && profiles.profiles.find(x => x.id === $("#wakeProfile").value);
  if (p && !$("#wakeAcc").dataset.touched) $("#wakeAcc").value = appCfg.local_accelerator || p.accelerator || "L4";
  let items = [];
  try { items = (await api("/api/gate/library")).items || []; } catch { }
  box.hidden = !items.length;
  box.innerHTML = items.length ? `<div class="eh"><span>Instalar durante el arranque (desde la Biblioteca)</span><span>Más elementos implicarán un inicio más lento</span></div>` + items.map(it => `<label><input type="checkbox" value="${esc(it.id)}" ${it.auto_wake ? "checked" : ""}><span class="kind ${it.kind}" style="width:48px">${i18n.it.kind === "node" ? i18n.t("lib_kind_node") : i18n.t("lib_kind_model")}</span>${esc(it.title)}<span class="x">${it.size_gb ? it.size_gb.toFixed(2) + " GB" : ""}</span></label>`).join("") : "";
  let st = { signed_in: true }; try { st = await api("/api/local/status"); } catch { }
  $("#localHint").hidden = st.signed_in;
  $("#localHint").innerHTML = st.signed_in ? "" : i18n.t("wake_local_not_signed");
}
$("#wakeAcc").onchange = () => {
  $("#wakeAcc").dataset.touched = "1";
  if (!isLocal()) try { localStorage.setItem("ckwb.gwAcc", $("#wakeAcc").value); } catch { }  renderStatus();
};
function renderWf() {
  const p = profiles && profiles.profiles && profiles.profiles.find(x => x.id === $("#wakeProfile").value);
  const opt = p ? p.workflows.filter(w => w.optional) : [];
  $("#wfBox").innerHTML = opt.length ? `<span class="muted small">Descargas opcionales:</span>` + opt.map(w => `<label><input type="checkbox" value="${esc(w.id)}">${esc(w.title || w.id)} <span class="muted small">+${w.size_gb ?? "?"} GB</span></label>`).join("") : "";
}
$("#wakeProfile").onchange = () => { renderWf(); renderExtras(); };

// mode switch (gateway <-> local)
function renderMode() { $$("#modeSeg button").forEach(b => b.classList.toggle("on", b.dataset.m === (appCfg.mode || "gateway"))); }
$$("#modeSeg button").forEach(b => b.onclick = async () => {
  const m = b.dataset.m; if (m === (appCfg.mode || "gateway")) return;
  const running = gst && gst.state && gst.state !== "sleeping" && gst.state !== "failed";
  const active = jobs.some(j => ["running", "submitted", "uploading", "waiting", "queued"].includes(j.status));
  if ((running || active) && !await appConfirm(`${i18n.t("dlg_wake_running")}${i18n.t("dlg_wake_active")}\n${i18n.t("dlg_wake_msg").replace("{running}{active}\n", "")}`, { title: `¿Cambiar al modo ${m === "local" ? "local" : "pasarela"}?`, ok: "Continuar con el cambio", cancel: "Mantener modo actual" })) return;
  const c = await api("/api/config"); const cfg2 = c.config; cfg2.mode = m; cfg2.cf_client_secret = cfg2.cf_client_secret; 
  await api("/api/config", { json: cfg2 });
  appCfg.mode = m; renderMode();
  $("#wakeAcc").dataset.touched = "";
  toast(m === "local" ? i18n.t("sec_local_desc").split("·")[0] : "Cambiado a modo pasarela (VPS)");
  gst = null; await pollStatus(); loadProfiles(); connectEvents(); loadTemplates();
});

let wakePending = false;
function wakeNotice(options) { return appDialog(options); }
let dialogSequence = 0;
function appDialog({ title, message, balance, minimum, accelerator, confirm = false, buttons, inputValue = null }) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "wake-notice";
    const id = "appDialog" + (++dialogSequence);
    dialog.setAttribute("aria-labelledby", id + "Title");
    dialog.setAttribute("aria-describedby", id + "Message");
    const actions = buttons || (confirm ? [{ value: "cancel", label: "Cancelar arranque" }, { value: "continue", label: "Iniciar de todos modos", primary: true }] : [{ value: "choose", label: "Cambiar GPU" }, { value: "buy", label: "Comprar CU ↗", primary: true }]);
    dialog.innerHTML = `<form method="dialog">
      <div class="wake-notice-head"><span class="wake-notice-icon" aria-hidden="true">!</span><button type="button" class="wake-notice-close" value="cancel" aria-label="Cerrar">×</button></div>
      <h2 id="${id}Title">${esc(title)}</h2>
      <p id="${id}Message">${esc(message)}</p>
      ${inputValue !== null ? `<label class="wake-notice-input">Nombre<input value="${esc(inputValue)}" autocomplete="off" autofocus></label>` : ""}
      ${minimum ? `<div class="wake-notice-balance"><div><span>Saldo actual</span><strong>${balance.toFixed(2)} <small>CU</small></strong></div><div><span>Reserva para ${esc(accelerator)}</span><strong>${minimum} <small>CU</small></strong></div></div><p class="wake-notice-footnote">Reserva estimada para 1 hora de uso antes de solicitar la GPU.</p>` : ""}
      <div class="wake-notice-actions">${actions.map((a, i) => `<button type="${a.primary ? "submit" : "button"}" class="btn${a.primary ? " primary" : ""}" value="${esc(a.value)}" ${i === 0 && inputValue === null ? "autofocus" : ""}>${esc(a.label)}</button>`).join("")}</div>
    </form>`;
    dialog.querySelectorAll("button[value]").forEach(b => b.onclick = e => { e.preventDefault(); dialog.close(b.value); });
    dialog.querySelector("form").onsubmit = e => { e.preventDefault(); dialog.close(e.submitter ? e.submitter.value : "accept"); };
    // Escape closes only this dialog, preserving any editor modal underneath it.
    dialog.addEventListener("keydown", e => { if (e.key === "Escape") e.stopPropagation(); });
    dialog.addEventListener("close", () => {
      const result = dialog.returnValue;
      const value = inputValue !== null && result === "accept" ? dialog.querySelector("input").value : null;
      dialog.remove();
      if (previous && previous.isConnected) previous.focus();
      resolve(inputValue !== null ? value : result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    if (inputValue !== null) dialog.querySelector("input").select();
  });
}

async function appConfirm(message, { title = i18n.t("dlg_confirm_title"), ok = i18n.t("dlg_confirm_ok"), cancel = i18n.t("dlg_confirm_cancel") } = {}) {
  return await appDialog({ title, message, buttons: [{ value: "cancel", label: cancel }, { value: "accept", label: ok, primary: true }] }) === "accept";
}
function appAlert(message) {
  return appDialog({ title: "Aviso", message, buttons: [{ value: "accept", label: "Entendido", primary: true }] });
}
function appPrompt(message, value = "") {
  return appDialog({ title: message, message: "Introduce un nombre y guarda, o cancela para mantener el valor actual.", inputValue: value, buttons: [{ value: "cancel", label: "Cancelar" }, { value: "accept", label: "Guardar", primary: true }] });
}

async function wake() {
  if (wakePending) return false;
  wakePending = true;
  $("#btnWake").disabled = $("#btnWakeTop").disabled = true;
  try {
    const body = {};
    const prof = $("#wakeProfile").value; if (prof) body.profile = prof;
    if (isLocal()) {
      body.accelerator = $("#wakeAcc").value;
      body.extras = $$("#extrasBox input:checked").map(i => i.value);
      // Always check the current account; a cached zero must not decide this warning.
      let cu = null;
      try {
        cu = await api("/api/local/ccu", { json: {} });
        if (!Number.isFinite(cu.balance)) throw new Error("Colab no devolvió un saldo válido");
        if (gst) gst.cu = cu;
      } catch (e) {
        if (gst) gst.cu = { balance: null, per_hour: null, error: e.message };
        if (await wakeNotice({ title: i18n.t("dlg_wake_cu_low_title"), message: `Esto no significa que el saldo sea 0. ${e.message}. Si continúas, se consumirán unidades de cómputo (CU).`, confirm: true }) !== "continue") return false;
        cu = null;
      }
      const minimum = cu && cu.wake_minimums && cu.wake_minimums[body.accelerator];
      if (minimum > 0 && cu.balance < minimum) {
        const action = await wakeNotice({ title: i18n.t("dlg_wake_insufficient_title"), message: `El saldo actual no alcanza el margen de seguridad requerido para ${body.accelerator}. Puedes cambiar de GPU o adquirir más CU.`, balance: cu.balance, minimum, accelerator: body.accelerator });
        if (action === "buy") await api("/api/open-url", { json: { url: "https://colab.research.google.com/signup" } });
        if (action === "choose") $("#wakeAcc").focus();
        return false;
      }
      if (cu && cu.balance < 2 && await wakeNotice({ title: i18n.t("dlg_wake_low_balance_title"), message: `El saldo actual es de ${cu.balance.toFixed(2)} CU. Queda poco tiempo de cómputo disponible. Ten en cuenta el consumo antes de continuar.`, confirm: true }) !== "continue") return false;
    } else if (gst && gst.default_accelerator && !$("#wakeAcc").disabled) {
      body.accelerator = $("#wakeAcc").value;
    }
    const extra = $$("#wfBox input:checked").map(i => i.value);
    if (extra.length && profiles) {
      const p = profiles.profiles.find(x => x.id === prof);
      body.workflows = p.workflows.filter(w => !w.optional).map(w => w.id).concat(extra);
    }
    await api("/api/gate/wake", { json: body }); toast(i18n.t("dlg_toast_wake_sent")); connectEvents();
    return true;
  } catch (e) { toast(i18n.t("dlg_toast_wake_err") + ": " + e.message); return false; }
  finally { wakePending = false; await pollStatus(); }
}
async function stopGate() {
  if (!await appConfirm(i18n.t("dlg_wake_active") + i18n.t("dlg_wake_running"), { title: i18n.t("dlg_wake_title").replace("{mode}", i18n.t("dlg_wake_mode_gateway")), ok: i18n.t("dlg_btn_delete"), cancel: i18n.t("dlg_btn_keep_mode") })) return;
  const btns = [$("#btnStop"), $("#btnStopTop")];
  btns.forEach(b => { b.disabled = true; b.dataset.t = b.textContent; b.textContent = i18n.t("wake_btn_stop_backup"); });
  try {
    const r = await api("/api/gate/stop", { json: {} });
    if (r && r.backup_warning) await appAlert("Detenido. " + r.backup_warning); else toast(i18n.t("dlg_toast_stopped"));
  } catch (e) { toast(i18n.t("dlg_toast_stop_err") + ": " + e.message); }
  finally { btns.forEach(b => { b.disabled = false; if (b.dataset.t) b.textContent = b.dataset.t; }); }
  pollStatus(); if (typeof udRefresh === "function") udRefresh();
}
$("#btnWake").onclick = wake; $("#btnWakeTop").onclick = wake;
$("#btnStop").onclick = stopGate; $("#btnStopTop").onclick = stopGate;
$("#btnExtend").onclick = async () => { try { await api("/api/gate/extend", { json: {} }); toast(i18n.t("dlg_toast_extended")); } catch (e) { toast(i18n.t("dlg_toast_extend_err") + ": " + e.message); } pollStatus(); };
$("#btnOpenComfy").onclick = () => api("/api/open-url", { json: { url: "comfy" } });

// ---------------- boot log (pretty) ----------------
const STAGE_CN = new Proxy({}, { get: (_, k) => i18n.t("stage_" + k) });
let rawLines = [];
function fmtLine(line) {
  let m;
  if ((m = line.match(/^KIT_PROGRESS download (\{.*\})\s*$/))) {
    try {
      const d = JSON.parse(m[1]);
      const gb = x => (x / 1e9).toFixed(1);
      return { cls: "prog", key: "dl", html: `<i>⬇</i>Descargando modelos <b>${gb(d.bytes_done)} / ${gb(d.bytes_total)} GB</b><span class="m">${(d.bytes_per_s / 1e9).toFixed(2)} GB/s · Archivos ${d.files_done}/${d.files_total}${d.eta_s != null ? " · Restante " + human(d.eta_s) : ""}</span>` };
    } catch { }
  }
  if ((m = line.match(/^KIT_STAGE (\S+) (start|done)(?: ([\d.]+))?/))) {
    const n = STAGE_CN[m[1]] || m[1];
    return m[2] === "start" ? { cls: "stage", html: `<i>›</i>${esc(n)}…` } : { cls: "ok", html: `<i>✓</i>${esc(n)} completado${m[3] ? `<span class="m">${(+m[3]).toFixed(1)} s</span>` : ""}` };
  }
  if ((m = line.match(/^KIT_READY (\{.*\})/))) {
    try { const d = JSON.parse(m[1]); kitReady = { total: d.total_s, session: gst && gst.session_started }; return { cls: "ready", html: `<i>●</i>ComfyUI está listo<span class="m">Arranque interno en ${human(d.total_s)}</span>` }; } catch { }
  }
  if ((m = line.match(/^\s*ok (.+)$/))) return { cls: "ok", html: `<i>✓</i>${esc(m[1].split("/").pop())}<span class="m">${esc(m[1].includes("/") ? m[1].split("/")[0] : "")}</span>` };
  if (/^KIT_(TS|PARALLEL)\b/.test(line)) return null;
  if ((m = line.match(/^KIT_TUNNEL (\{.*\})/))) return { cls: "ok", html: `<i>✓</i>Túnel establecido<span class="m">${esc((JSON.parse(m[1]).url || "").replace(/^https?:\/\//, ""))}</span>` };
  if ((m = line.match(/^KIT_LIB boot extras (\[.*\])/))) { let a = []; try { a = JSON.parse(m[1]); } catch { } return { cls: "stage", html: `<i>›</i>Instalando ${a.length} elemento(s) adicional(es) desde la biblioteca` }; }
  if ((m = line.match(/^KIT_LIB (.*)$/))) return { cls: "stage", html: `<i>›</i>${esc(m[1].replace("restarting ComfyUI to load new custom nodes", "Reiniciando ComfyUI para cargar los nuevos nodos").replace("ComfyUI restarted", "ComfyUI reiniciado"))}` };
  if (/^KIT_WARN no_models\b/.test(line)) return { cls: "bad", html: `<i>!</i>Esta configuración no tiene ningún modelo para descargar; verifica los ajustes` };
  if ((m = line.match(/^WB_USERDATA (.*)$/))) return { cls: /失败|error|fall/i.test(m[1]) ? "bad" : "ok", html: `<i>${/失败|error|fall/i.test(m[1]) ? "!" : "✓"}</i>${esc(m[1])}` };
  if ((m = line.match(/^KIT_FETCHED (\{.*\})/))) return { cls: "ready", html: `<i>●</i>Instalación finalizada` };
  if (/error|traceback|failed|exception/i.test(line)) return { cls: "bad", html: esc(line) };
  return { cls: "dim", html: esc(line) };
}
function renderLog(full) {
  const box = $("#log");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  if ($("#rawLog").checked) {
    box.classList.add("raw");
    box.textContent = rawLines.join("\n");
  } else {
    box.classList.remove("raw");
    if (full) box.innerHTML = "";
    const start = full ? 0 : rawLines.length - 1;
    for (let i = start; i < rawLines.length; i++) {
      const f = fmtLine(rawLines[i]); if (!f) continue;
      const last = box.lastElementChild;
      if (f.key && last && last.dataset.key === f.key) { last.innerHTML = f.html; continue; }
      const div = document.createElement("div");
      div.className = "ln " + f.cls; div.innerHTML = f.html; if (f.key) div.dataset.key = f.key;
      box.appendChild(div);
    }
    while (box.childElementCount > 1500) box.firstElementChild.remove();
  }
  if (atBottom || full) box.scrollTop = box.scrollHeight;
}
$("#rawLog").onchange = () => renderLog(true);
$("#btnClearLog").onclick = () => { rawLines = []; renderLog(true); };

let es = null;
function connectEvents() {
  if (es) es.close();
  es = new EventSource("/api/gate/events?k=" + KEY);
  rawLines = []; renderLog(true); // the gate replays its backlog on every connect
  es.addEventListener("log", e => {
    let line = e.data; try { line = JSON.parse(e.data); } catch { }
    if (typeof line !== "string") line = JSON.stringify(line);
    for (const l of line.split("\n")) { if (!l.trim()) continue; rawLines.push(l); if (rawLines.length > 4000) rawLines.splice(0, 1000); renderLog(false); }
  });
  es.addEventListener("state", e => { try { gst = { ...(gst || {}), ...JSON.parse(e.data) }; renderStatus(); } catch { } });
  es.addEventListener("progress", e => { try { if (gst) { gst.progress = JSON.parse(e.data); renderStatus(); } } catch { } });
  es.onerror = () => { es.close(); es = null; setTimeout(connectEvents, 15000); };
}

// ---------------- templates & form ----------------
function cleanCN(s) {
  if (!s || typeof s !== "string") return s || "";
  return s
    .replace(/AI\s*生图/gi, "Imagen IA")
    .replace(/生图/g, "Generación")
    .replace(/写实/g, "Fotorrealista")
    .replace(/文生视频/g, "Texto a vídeo")
    .replace(/对话/g, "Chat")
    .replace(/正向提示词(\s*\(Positive Prompt\))?/g, "Prompt Positivo")
    .replace(/反向提示词(\s*\(Negative Prompt\))?/g, "Prompt Negativo")
    .replace(/负面提示词(\s*\(Negative Prompt\))?/g, "Prompt Negativo")
    .replace(/画布/g, "Lienzo")
    .replace(/采样/g, "Muestreo")
    .replace(/模型/g, "Modelo")
    .replace(/解码/g, "Decodificador")
    .replace(/保存图片/g, "Guardar imagen")
    .replace(/随机种子(\s*\(Seed\))?/g, "Semilla aleatoria")
    .replace(/文本提示词/g, "Prompt")
    .replace(/参数配置/g, "Configuración")
    .replace(/高清修复/g, "Auto-HD");
}

let templates = [], curTpl = null, lastJobForm = null;
async function loadTemplates(selectId) {
  templates = await api("/api/templates");
  templates.forEach(t => {
    t.name = cleanCN(t.name);
    if (t.fields) {
      t.fields.forEach(f => {
        f.node_name = cleanCN(f.node_name);
        f.label_cn = cleanCN(f.label_cn);
      });
    }
  });
  const list = $("#tplList");
  list.innerHTML = templates.length ? templates.map(t => `<button data-id="${t.id}"><b>${esc(t.name)}</b><small>${t.nodes} nodos · ${t.fields.filter(f => f.primary).length} parámetros principales</small></button>`).join("") : `<div class="tpl-empty"><p class="muted small" data-i18n="gen_no_templates">Aún no hay plantillas. Puedes usar los modelos integrados en la pestaña IA o importar tu propio flujo de ComfyUI:</p>
      <button class="btn sm block" data-empty="ai">Ir a IA con modelos integrados</button>
      <button class="btn sm block" data-empty="import">Importar flujo ComfyUI API (.json)</button>
      <a href="#" class="small" data-empty="how">¿Cómo exportar el formato API?</a></div>`;
  $$("[data-empty]", list).forEach(b => b.onclick = e => { e.preventDefault(); emptyAction(b.dataset.empty); });
  $$("button", list).forEach(b => b.onclick = () => selectTpl(b.dataset.id));
  const id = selectId || (curTpl && curTpl.id) || localStorage.getItem("ckwb.tpl") || (templates[0] && templates[0].id);
  if (id && templates.find(t => t.id === id)) selectTpl(id); else { curTpl = null; renderForm(); }
}
function selectTpl(id, values) {
  curTpl = templates.find(t => t.id === id) || null;
  try { localStorage.setItem("ckwb.tpl", id); } catch { }
  $$("#tplList button").forEach(b => b.classList.toggle("on", b.dataset.id === id));
  renderForm(values);
}
$("#tplFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const text = await f.text();
  const name = await appPrompt("Asigna un nombre a esta plantilla:", f.name.replace(/\.json$/i, ""));
  if (name === null) return;
  try { const r = await api("/api/templates", { json: { name, json: text } }); toast(i18n.t("gen_template_imported")); await loadTemplates(r.id); }
  catch (err) { await appAlert(i18n.t("gen_err_import", { err: err.message })); }
};
$("#btnResetForm").onclick = async () => {
  if (!curTpl || !await appConfirm(i18n.t("gen_confirm_reset"))) return;
  try { localStorage.removeItem(draftKey(curTpl.id)); } catch { }
  $("#jobTitle").value = ""; renderForm({});
};
$("#btnRename").onclick = async () => {
  const n = await appPrompt("Nuevo nombre:", curTpl.name); if (!n) return;
  await api("/api/templates/" + curTpl.id, { json: { name: n } }); loadTemplates(curTpl.id);
};
$("#btnDelTpl").onclick = async () => {
  if (!await appConfirm(i18n.t("gen_confirm_delete", { name: curTpl.name }))) return;
  await api("/api/templates/" + curTpl.id, { method: "DELETE" }); curTpl = null; loadTemplates();
};

function fieldId(k) { return "f_" + k.replace(/[^\w]/g, "_"); }
// The form remembers what you typed per template (localStorage), so re-selecting a template,
// switching modes, restarting or updating the app never throws your prompt away.
function draftKey(id) { return "ckwb.draft." + id; }
function loadDraft(id) { try { return JSON.parse(localStorage.getItem(draftKey(id)) || "null"); } catch { return null; } }
function saveDraft() {
  if (!curTpl || $("#genForm").hidden) return;
  const v = collectValues(true).values;
  v["@h3mode"] = $("#h3Mode").value; v["@h3dur"] = $("#h3Dur").value; v["@title"] = $("#jobTitle").value; v["@v"] = 2;
  try { localStorage.setItem(draftKey(curTpl.id), JSON.stringify(v)); } catch { }
}
let draftTimer = null;
function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); }
function renderForm(values) {
  if (values === undefined && curTpl) {
    const d = loadDraft(curTpl.id);
    if (d && !d["@v"]) { // drafts from before recommended values existed: adopt them once (keep duration/prompt)
      for (const f of curTpl.fields) if (f.rec != null && !/duraci|tiempo|时长/i.test(f.label_cn || "")) d[f.key] = f.rec;
      d["@v"] = 2;
      try { localStorage.setItem(draftKey(curTpl.id), JSON.stringify(d)); } catch { }
    }
    if (d) {
      values = d;
      if (d["@h3mode"]) { $("#h3Mode").value = d["@h3mode"]; renderModeSeg(); }
      if (d["@h3dur"]) $("#h3Dur").value = d["@h3dur"];
      if (d["@title"] != null) $("#jobTitle").value = d["@title"];
    }
  }
  $("#formEmpty").hidden = !!curTpl; $("#genForm").hidden = !curTpl;
  $("#btnRename").hidden = $("#btnDelTpl").hidden = $("#btnResetForm").hidden = !curTpl;
  if (!curTpl) { $("#formTitle").textContent = i18n.t("gen_parameters"); return; }
  $("#formTitle").textContent = cleanCN(curTpl.name);
  const prim = curTpl.fields.filter(f => f.primary);
  const adv = curTpl.fields.filter(f => !f.primary);
  const v = values || {};
  // order: text (positive first), uploads, numbers/seed
  const rank = f => f.kind === "text" ? (f.negative ? 1 : 0) : f.kind === "image" || f.kind === "file" ? 2 : 3;
  prim.sort((a, b) => rank(a) - rank(b));
  const big = prim.filter(f => rank(f) < 3), small = prim.filter(f => rank(f) === 3);
  $("#primaryFields").innerHTML = big.map(f => fieldHTML(f, v, true)).join("") + (small.length ? `<div class="f-grid">${small.map(f => fieldHTML(f, v, true)).join("")}</div>` : "");
  // advanced grouped by node
  let html = "", last = "";
  for (const f of adv) {
    if (f.node !== last) { if (last) html += "</div>"; html += `<div class="node">#${esc(f.node)} ${esc(cleanCN(f.node_name))}</div><div class="f-grid">`; last = f.node; }
    html += fieldHTML(f, v, false);
  }
  if (last) html += "</div>";
  $("#advFields").innerHTML = html || `<p class="muted small" data-i18n="gen_no_more_params">No hay más parámetros</p>`;
  $("#advCount").textContent = adv.length ? `(${adv.length})` : "";
  bindUploads();
  $$("[data-hide]").forEach(b => b.onclick = () => toggleHidden(b.dataset.hide, true));
  $$("[data-unhide]").forEach(b => b.onclick = () => toggleHidden(b.dataset.unhide, false));
  // focus the main prompt
  lastTextarea = $("#primaryFields textarea");
  draftHint();
}
async function toggleHidden(key, hide) {
  const tpl = curTpl, next = new Set(tpl.hidden || []);
  hide ? next.add(key) : next.delete(key);
  const vals = collectValues(true).values;
  await api("/api/templates/" + tpl.id, { json: { hidden: [...next] } });
  await loadTemplates(tpl.id);
  renderForm(vals);
}

function fieldHTML(f, v, primary) {
  const id = fieldId(f.key);
  const base = f.rec !== undefined && f.rec !== null ? f.rec : f.default;
  const val = v[f.key] !== undefined ? v[f.key] : base;
  const name = cleanCN(f.label_cn || (primary ? f.node_name : f.input));
  const sub = cleanCN(f.label_cn ? (primary && !/^Primitive/.test(f.class || "") ? f.node_name : "") : (primary ? f.input : ""));
  const tip = esc([f.hint, `Nodo #${f.node} ${cleanCN(f.node_name)} · ${f.input}`, f.rec != null ? `Recomendado: ${recText(f)}` : ""].filter(Boolean).join("\n"));
  const recBtn = f.rec != null ? `<button type="button" class="x rec" data-rec="${esc(f.key)}" title="Restablecer valor recomendado" ${String(val) === String(f.rec) ? "hidden" : ""}>Recomendado ${esc(recText(f))}</button>` : "";
  const lbl = `<span class="f-lbl" title="${tip}">${esc(name)}${sub ? ` <span class="muted">· ${esc(sub)}</span>` : ""}${f.hint ? ` <i class="q">?</i>` : ""}</span>`;
  const hideBtn = primary ? `<button type="button" class="x" data-hide="${esc(f.key)}" title="Mover a parámetros avanzados">Ocultar</button>` : (curTpl.hidden || []).includes(f.key) ? `<button type="button" class="x" data-unhide="${esc(f.key)}">Destacar</button>` : "";
  switch (f.kind) {
    case "text":
      return `<div class="f-wrap f-text ${f.negative ? "neg" : ""}"><div class="f-head">${lbl}<span><span class="muted" data-count="${id}"></span> ${hideBtn}</span></div><textarea id="${id}" data-key="${esc(f.key)}" data-kind="text" spellcheck="false">${esc(val)}</textarea></div>`;
    case "image": case "file": {
      const up = v["@up:" + f.key];
      return `<div class="f-wrap"><div class="f-head">${lbl}${hideBtn}</div><div class="drop" data-drop="${id}"><span class="ph">${f.kind === "image" ? "🖼" : "🎞"}</span><div><div>${up ? "Archivo previo: " + esc(up.split(/[\\/]/).pop().split("__").pop()) : "Haz clic o arrastra un archivo"}</div><div class="muted small">Si no seleccionas uno, se usará el de la plantilla: ${esc(val)}</div></div>
        <input type="file" id="${id}" data-key="${esc(f.key)}" data-kind="upload" accept="${f.accept || ""}" hidden ${up ? `data-reuse="${esc(up)}"` : ""}></div></div>`;
    }
    case "seed": {
      const rnd = v["@rand:" + f.key] !== undefined ? v["@rand:" + f.key] : true;
      return `<label class="fld">${lbl}<div class="seedrow"><input type="number" id="${id}" data-key="${esc(f.key)}" data-kind="number" value="${esc(val)}"><label class="chk" style="margin:0"><input type="checkbox" data-rand="${esc(f.key)}" ${rnd ? "checked" : ""}>Aleatorio cada vez</label></div></label>`;
    }
    case "number":
      return `<label class="fld"><span class="row between">${lbl}${recBtn}</span><input type="number" step="any" id="${id}" data-key="${esc(f.key)}" data-kind="number" value="${esc(val)}">${f.hint && primary ? `<span class="f-hint">${esc(f.hint)}</span>` : ""}</label>`;
    case "bool":
      return `<div class="fld"><span class="row between">${lbl}${recBtn}</span><label class="chk switch-row"><input type="checkbox" id="${id}" data-key="${esc(f.key)}" data-kind="bool" ${val ? "checked" : ""}><span>${val ? "Activado" : "Desactivado"}</span></label>${f.hint && primary ? `<span class="f-hint">${esc(f.hint)}</span>` : ""}</div>`;
    default:
      return `<label class="fld"><span class="row between">${lbl}${recBtn}</span><input id="${id}" data-key="${esc(f.key)}" data-kind="string" value="${esc(val)}"></label>`;
  }
}

function recText(f) { return f.rec === true ? "Sí" : f.rec === false ? "No" : String(f.rec); }
function bindRec() {
  $$("[data-rec]").forEach(b => b.onclick = e => {
    e.preventDefault();
    const f = curTpl.fields.find(x => x.key === b.dataset.rec); const el = document.getElementById(fieldId(f.key));
    if (el.type === "checkbox") { el.checked = !!f.rec; el.nextElementSibling.textContent = el.checked ? "Activado" : "Desactivado"; } else el.value = f.rec;
    b.hidden = true; draftHint(); saveDraftSoon();
  });
  $$('#genForm input[data-kind="bool"]').forEach(el => el.addEventListener("change", () => { el.nextElementSibling.textContent = el.checked ? "Activado" : "Desactivado"; }));
  $$("#genForm [data-key]").forEach(el => el.addEventListener("input", () => {
    const b = document.querySelector(`[data-rec="${el.dataset.key}"]`); if (!b) return;
    const f = curTpl.fields.find(x => x.key === el.dataset.key); const cur = el.type === "checkbox" ? el.checked : el.value;
    b.hidden = String(cur) === String(f.rec);
  }));
}
function bindUploads() {
  bindRec();
  $$(".drop").forEach(d => {
    const inp = $("input[type=file]", d);
    d.onclick = e => { if (e.target !== inp) inp.click(); };
    d.ondragover = e => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); if (e.dataTransfer.files[0]) { const dt = new DataTransfer(); dt.items.add(e.dataTransfer.files[0]); inp.files = dt.files; inp.onchange(); } };
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      inp.removeAttribute("data-reuse");
      const url = URL.createObjectURL(f);
      const media = f.type.startsWith("image/") ? `<img src="${url}">` : f.type.startsWith("video/") ? `<video src="${url}" muted></video>` : `<span class="ph">♪</span>`;
      d.firstElementChild.outerHTML = media;
      d.children[1].firstElementChild.textContent = f.name + " · " + fmtSize(f.size);
    };
  });
  $$("textarea[data-kind=text]").forEach(t => { t.oninput = () => updCount(t); t.onfocus = () => lastTextarea = t; updCount(t); });
}
function updCount(t) { saveDraftSoon(); updCount0(t); }
function updCount0(t) { const c = $(`[data-count="${t.id}"]`); if (c) c.textContent = t.value.trim() ? t.value.trim().split(/\s+/).length + " palabras" : ""; }

function collectValues(forRender) {
  const values = {}, files = {}, rand = [];
  $$("#genForm [data-key]").forEach(el => {
    const k = el.dataset.key, kind = el.dataset.kind;
    if (kind === "upload") {
      if (el.files && el.files[0]) files[k] = el.files[0];
      else if (el.dataset.reuse) { values[k] = "@upload:" + el.dataset.reuse; if (forRender) values["@up:" + k] = el.dataset.reuse; }
      return;
    }
    if (kind === "number") { const n = parseFloat(el.value); if (!isNaN(n)) values[k] = n; }
    else if (kind === "bool") values[k] = el.checked;
    else values[k] = el.value;
  });
  $$("#genForm [data-rand]").forEach(c => { if (c.checked) rand.push(c.dataset.rand); if (forRender) values["@rand:" + c.dataset.rand] = c.checked; });
  return { values, files, rand };
}

$("#genForm").onsubmit = e => { e.preventDefault(); submitJob(false); };
$("#btnDraft").onclick = () => submitJob(true);
const chkAutoHires = $("#chkAutoHires");
if (chkAutoHires) {
  chkAutoHires.addEventListener("click", e => {
    if ((!currentLicense || !currentLicense.is_pro) && chkAutoHires.checked) {
      e.preventDefault();
      chkAutoHires.checked = false;
      openLicenseModal("El pipeline encadenado Auto-HD es una función exclusiva de WakeGPU Pro. Te permite generar automáticamente la versión final de alta resolución tras validar el borrador.");
    }
  });
}
const jobCountInp = $("#jobCount");
if (jobCountInp) {
  jobCountInp.addEventListener("change", () => {
    if ((!currentLicense || !currentLicense.is_pro) && parseInt(jobCountInp.value) > 1) {
      jobCountInp.value = "1";
      openLicenseModal("La generación simultánea por lotes (más de 1 copia) es una función exclusiva de WakeGPU Pro. Puedes generar hasta 50 variantes en un solo clic.");
    }
  });
}
async function submitJob(draft) {
  $("#genErr").textContent = "";
  const count = parseInt($("#jobCount").value) || 1;
  const autoHires = $("#chkAutoHires") ? $("#chkAutoHires").checked : false;

  if (count > 1 && (!currentLicense || !currentLicense.is_pro)) {
    openLicenseModal("La generación simultánea por lotes (más de 1 copia) es una función de WakeGPU Pro. Te permite generar variantes con semillas aleatorias automáticamente.");
    return;
  }
  if (autoHires && (!currentLicense || !currentLicense.is_pro)) {
    openLicenseModal("El pipeline encadenado Auto-HD es una función de WakeGPU Pro. Ejecuta la prueba rápida y, si tiene éxito, lanza automáticamente el escalado en alta resolución sin que tengas que esperar frente al ordenador.");
    return;
  }

  const mismatch = templateProfileMismatch(curTpl);
  if (mismatch) { $("#genErr").textContent = mismatch; return; }
  const { values, files, rand } = collectValues(false);
  const title = $("#jobTitle").value.trim() || curTpl.name;
  const fd = new FormData();
  fd.append("spec", JSON.stringify({
    template_id: curTpl.id,
    values,
    random_seeds: rand,
    title: draft ? title + " · Borrador" : title,
    count,
    draft,
    auto_hires: autoHires && draft
  }));
  for (const [k, f] of Object.entries(files)) fd.append(k, f, f.name);
  try {
    const r = await api("/api/jobs", { method: "POST", body: fd });
    saveDraft();
    const what = draft ? "prueba rápida" : "tarea";
    const batchTxt = count > 1 ? ` · Lote de ${count} tareas` : "";
    const autoTxt = autoHires && draft ? " · ⚡ Auto-HD activado" : "";
    toast(i18n.t("gen_draft_submitted", { what: draft ? i18n.t("gen_draft_quick_test") : i18n.t("gen_draft_task"), batch: count > 1 ? i18n.t("gen_draft_batch", { n: count }) : "", auto: autoHires && draft ? i18n.t("gen_draft_autohd") : "" }) + (gst && (gst.state === "sleeping" || gst.state === "failed") ? " · " + i18n.t("gen_draft_gpu_sleeping") : ""));
    loadJobs();
  } catch (err) { $("#genErr").textContent = i18n.t("gen_err_send", { err: err.message }); }
}
let appCfg = {};
function draftHint() {
  const el = $("#draftHint"); if (!el || !curTpl) return;
  const sc = +appCfg.draft_scale || 0.5;
  const get = name => { const f = curTpl.fields.find(x => x.kind === "number" && x.input.toLowerCase() === name); if (!f) return null; const inp = document.getElementById(fieldId(f.key)); const v = inp ? parseFloat(inp.value) : f.default; return isNaN(v) ? f.default : v; };
  const w = get("width"), h = get("height"), mp = get("megapixels");
  const r = v => Math.max(128, Math.round(v * sc / 32) * 32);
  $("#btnDraft").disabled = !((w && h) || mp);
  el.textContent = w && h ? `${r(w)}×${r(h)}` : mp ? `${Math.max(0.05, Math.round(mp * sc * sc * 100) / 100)}MP` : "(plantilla sin dimensiones fijas)";
}
document.addEventListener("input", e => { if (e.target.closest && e.target.closest("#genForm")) { draftHint(); saveDraftSoon(); } });
document.addEventListener("change", e => { if (e.target.closest && e.target.closest("#genForm")) saveDraftSoon(); });

// ---------------- H3 prompt scaffolds ----------------
let lastTextarea = null;
function d2(n) { return Number(n).toFixed(2); }
function cinematicSkeleton(preset, mode, dur) {
  const D = d2(dur);
  const half = (dur / 2).toFixed(1);
  switch (preset) {
    case "muse6":
      return `[DURACIÓN Y FORMATO]: ${D}s, 16:9 cinematic aspect ratio, 24fps.
[PERSONAJE / ASSET ID]: S1, ___ (age, key facial features, outfit materials, colors).
[ESCENARIO Y ATMÓSFERA]: ___ (setting, lighting, weather, time of day).
[TIMED BEATS]:
- 0.0s - ${half}s: S1 ___ (opening action, camera reveals subject).
- ${half}s - ${D}s: S1 ___ (action progression, transition to climax).
[LENGUAJE DE CÁMARA]: 35mm anamorphic lens, shallow depth of field, slow smooth dolly forward at eye-level.
[RESTRICCIONES]: No face morphing, no limb distortion, realistic fluid physics, no text overlay, consistent lighting.`;
    case "apple":
      return `[DURACIÓN Y FORMATO]: ${D}s, 16:9 widescreen, ultra-crisp commercial feel.
[SUJETO / ASSET ID]: ___ (matte finish luxury device or product with subtle glowing accents).
[ESCENARIO Y ATMÓSFERA]: Minimalist clean studio environment, dramatic rim light, caustic reflections.
[TIMED BEATS]:
- 0.0s - ${half}s: Fast dynamic snap zoom into product hero feature.
- ${half}s - ${D}s: Smooth 360-degree rotation showing side profiles with haptic pulse.
[LENGUAJE DE CÁMARA]: 90mm macro lens, robotic motion control, 120fps slow-motion feel.
[RESTRICCIONES]: Perfectly clean geometry, no jitter, studio reflections.`;
    case "bladerunner":
      return `[DURACIÓN Y FORMATO]: ${D}s, 2.39:1 cinemascope, heavy cinematic haze.
[PERSONAJE / ASSET ID]: S1, lone figure in heavy trench coat standing in atmospheric solitude.
[ESCENARIO Y ATMÓSFERA]: Colossal brutalist dystopian monuments, dense neon fog and torrential acid rain.
[TIMED BEATS]:
- 0.0s - ${half}s: S1 stands motionless gazing up at towering architecture.
- ${half}s - ${D}s: S1 steps forward into the rain as holographic light sweeps through the smog.
[LENGUAJE DE CÁMARA]: 24mm wide angle lens, slow pedestal rise, massive sense of scale.
[RESTRICCIONES]: Realistic rain physics, contemplative pacing, rich filmic grain.`;
    case "fincher":
      return `[DURACIÓN Y FORMATO]: ${D}s, 16:9, muted olive-green and deep shadow color grade.
[PERSONAJE / ASSET ID]: S1, intense focused expression, subtle micro-movements.
[ESCENARIO Y ATMÓSFERA]: Low-key dimly lit office, single tungsten green-tinted light source, deep blacks.
[TIMED BEATS]:
- 0.0s - ${half}s: Extreme close-up on eyes/hands carrying out a precise action.
- ${half}s - ${D}s: Subject leans back slightly into shadow, lingering stillness.
[LENGUAJE DE CÁMARA]: 50mm prime, clinical tripod stability, micro-dolly forward.
[RESTRICCIONES]: Razor sharp focus plane, restrained camera, zero shaky movement.`;
    case "anime":
      return `[DURACIÓN Y FORMATO]: ${D}s, 16:9, vibrant high-key anime aesthetics.
[PERSONAJE / ASSET ID]: S1, anime character with fluttering hair and dynamic expression.
[ESCENARIO Y ATMÓSFERA]: Sunlit rooftop, radiant azure summer sky, towering cumulus clouds, lens flares.
[TIMED BEATS]:
- 0.0s - ${half}s: S1 turns slowly towards camera as wind carries sakura petals.
- ${half}s - ${D}s: S1 smiles gently into the golden hour sunset.
[LENGUAJE DE CÁMARA]: 35mm anime angle, dynamic low perspective, golden light blooms.
[RESTRICCIONES]: Authentic 2D anime linework, smooth natural cloth and hair physics.`;
    case "macro":
      return `[DURACIÓN Y FORMATO]: ${D}s, 16:9, luxury commercial slow-motion.
[SUJETO / ASSET ID]: Detailed jewel, liquid droplet, or precision mechanical watch movement.
[ESCENARIO Y ATMÓSFERA]: Velvet black void with caustic light rays and floating micro-particles.
[TIMED BEATS]:
- 0.0s - ${half}s: Liquid droplet collision or mechanical gear engagement in ultra slow-motion.
- ${half}s - ${D}s: Slow rotation revealing internal facets and prismatic color dispersion.
[LENGUAJE DE CÁMARA]: 100mm macro probe lens, extreme shallow depth of field, 1000fps feel.
[RESTRICCIONES]: Pure luxury aesthetics, zero clipping, physical optical refraction.`;
    default:
      return skeleton(mode, dur);
  }
}
function skeleton(mode, dur) {
  const D = d2(dur);
  const body = `integrated_multimodal_description: [Shot 1] Realistic film look. Medium-wide view of ___; slow, gentle move closer while ___.

overall_soundscape: ___

non_diegetic_music: N/A`;
  switch (mode) {
    case "T2VA": return body;
    case "I2VA": return `<Picture 1> is the opening frame ([Shot 1], 0.00 s).

integrated_multimodal_description: [Shot 1] Realistic film look. Starting from <Picture 1>: ___ (keep the same people, outfits and room). Camera: ___ while ___.

overall_soundscape: ___

non_diegetic_music: N/A`;
    case "FL2VA": return `Picture 1 is the opening frame (0.00 s) and Picture 2 the closing frame (${D} s) of [Shot 1].

integrated_multimodal_description: [Shot 1] Realistic film look. Opens as in Picture 1: ___. Camera: ___ while ___, ending exactly as in Picture 2.

overall_soundscape: ___

non_diegetic_music: N/A`;
    case "L2VA": return `<Picture 1> is the closing frame of [Shot 1] (${D} s).

integrated_multimodal_description: [Shot 1] Realistic film look. ___ view of ___ at the start. Camera: ___ while ___. By the end everything matches <Picture 1>.

overall_soundscape: ___

non_diegetic_music: N/A`;
    case "Ref2VA": return `subject_definitions:
<Subject 1> = the ___ from <Picture 1> (___).

summary:
<Subject 1> ___.

retention_analysis:
<Subject 1>, [Shot 1]: keep ___.

detailed_description:
Style ___, light ___.
[Shot 1] ___

overall_soundscape:
___

non_diegetic_music:
N/A`;
  }
}
const SNIPS = [
  ["🎬 6 Bloques", () => `[DURACIÓN]: ${+$("#h3Dur").value || 5}s | [PERSONAJE S1]: ___ | [ESCENARIO]: ___ | [BEATS]: 0-2.5s ___, 2.5-5s ___ | [CÁMARA]: 35mm anamórfico, ___ | [RESTRICCIONES]: ___`],
  ["Bloqueo Personaje", () => "[Subject S1: keep exact facial identity, costume and hair consistency] "],
  ["Nuevo plano", () => `[Shot 2] Cut at ${Math.min(9, Math.floor(+$("#h3Dur").value / 2))} s to `],
  ["Diálogo", () => `(S1), speaking in a ___ voice: <d>[texto] </d>`],
  ["Voz en off", () => `(S1) off screen, mouth closed on camera: <d>[texto] </d>`],
  ["Macro 90mm", () => "90mm macro lens, ultra-shallow depth of field, "],
  ["Travelling lento", () => "Slow, smooth dolly forward toward "],
  ["Anamórfico 35mm", () => "35mm anamorphic lens with cinematic horizontal flare, "],
  ["Cámara lenta 120fps", () => "High-speed 120fps slow-motion capture, "],
  ["Orbital", () => "Camera circles around "],
  ["Panorámica", () => "Quick turn of the camera to the right shows "],
  ["Cámara fija", () => "Camera stays still on tripod while "],
  ["Pedestal / Grúa", () => "Pedestal rise revealing "],
  ["Cámara en mano", () => "Slight handheld wobble as "],
  ["<Picture 1>", () => "<Picture 1>"],
  ["<Subject 1>", () => "<Subject 1>"],
];
$("#snips").innerHTML = SNIPS.map((s, i) => `<button type="button" data-i="${i}">${esc(s[0])}</button>`).join("");
$$("#snips button").forEach(b => b.onclick = () => insertText(SNIPS[b.dataset.i][1]()));
function mainTextarea() { return (lastTextarea && document.body.contains(lastTextarea)) ? lastTextarea : $("#primaryFields textarea"); }
function insertText(s) {
  const t = mainTextarea(); if (!t) return toast("Esta plantilla no tiene parámetros de texto");
  const a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? a;
  t.value = t.value.slice(0, a) + s + t.value.slice(b);
  t.focus(); t.selectionStart = t.selectionEnd = a + s.length; updCount(t);
}
$("#btnSkeleton").onclick = async () => {
  const t = mainTextarea(); if (!t) return toast("Esta plantilla no tiene parámetros de texto");
  const dur = Math.min(15, Math.max(4, +$("#h3Dur").value || 6));
  openModal(`<h3>🎬 Estructuras y Plantillas Cinematográficas</h3>
  <p class="muted small">Elige una estructura probada para Wan 2.1, Muse, Hunyuan o MiniMax:</p>
  <div class="plist">
    <div class="p"><b>🎬 Muse / Wan 2.1 (6 Bloques Cinematográficos)</b><span class="tx">Estructura maestra: Duración, Sujeto/Asset ID, Entorno, Ritmo por segundos, Cámara y Restricciones</span><button class="btn sm primary" data-sk="muse6">Usar</button></div>
    <div class="p"><b>🍎 Comercial Dinámico (Apple Don't Blink)</b><span class="tx">Ritmo rápido, snap zoom a producto, iluminación de estudio y cámara lenta 120fps</span><button class="btn sm" data-sk="apple">Usar</button></div>
    <div class="p"><b>🌧️ Sci-Fi Monumental (Blade Runner 2049)</b><span class="tx">Atmósfera densa, escala monumental, niebla y lente anamórfica</span><button class="btn sm" data-sk="bladerunner">Usar</button></div>
    <div class="p"><b>🕵️ Thriller Psicológico Noir (David Fincher)</b><span class="tx">Bajo contraste, tonos verdosos, iluminación cenital y dolly milimétrico</span><button class="btn sm" data-sk="fincher">Usar</button></div>
    <div class="p"><b>🌸 Anime Cinematográfico (Makoto Shinkai)</b><span class="tx">Cielos luminosos, nubes volumétricas, partículas flotantes y emoción</span><button class="btn sm" data-sk="anime">Usar</button></div>
    <div class="p"><b>💎 Macro Cinema Producto (High-End 120fps)</b><span class="tx">Detalle extremo de producto, reflejos de luz cáusticos y cámara lenta</span><button class="btn sm" data-sk="macro">Usar</button></div>
    <div class="p"><b>⚡ Clásico MiniMax H3 (Multimodal)</b><span class="tx">Estructura original por planos con descripciones de audio y sonido</span><button class="btn sm ghost" data-sk="h3">Usar</button></div>
  </div>
  <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close>Cancelar</button></div>`);
  $$("[data-sk]").forEach(b => b.onclick = async () => {
    const p = b.dataset.sk;
    closeModal();
    const sk = cinematicSkeleton(p, $("#h3Mode").value, dur);
    if (t.value.trim()) {
      const action = await appDialog({ title: "¿Cómo deseas insertar la estructura?", message: "Ya hay texto en el prompt. Puedes reemplazarlo por completo o insertarlo en la posición del cursor.", buttons: [{ value: "cancel", label: "Cancelar" }, { value: "insert", label: "Insertar en el cursor" }, { value: "replace", label: "Reemplazar todo", primary: true }] });
      if (action === "insert") { insertText(sk); return; }
      if (action !== "replace") return;
    }
    t.value = sk; updCount(t); t.focus();
    const i = t.value.indexOf("___"); if (i >= 0) { t.selectionStart = i; t.selectionEnd = i + 3; }
  });
};

// prompt library
let promptLib = [];
$("#btnSavePrompt").onclick = async () => {
  const t = mainTextarea(); if (!t || !t.value.trim()) return toast("El prompt está vacío");
  const name = await appPrompt("Guardar como:", t.value.trim().replace(/\s+/g, " ").slice(0, 30)); if (!name) return;
  promptLib = await api("/api/prompts");
  promptLib.unshift({ name, text: t.value, mode: $("#h3Mode").value, at: Date.now() });
  await api("/api/prompts", { json: promptLib }); toast("Guardado en la biblioteca de prompts");
};
$("#btnLoadPrompt").onclick = async () => {
  promptLib = await api("/api/prompts");
  openModal(`<h3>Biblioteca de prompts</h3><div class="plist">${promptLib.length ? promptLib.map((p, i) => `<div class="p"><b>${esc(p.name)}</b><span class="tx">${esc(p.text.slice(0, 120))}</span><button class="btn sm" data-use="${i}">Usar</button><button class="btn sm ghost danger" data-del="${i}">Eliminar</button></div>`).join("") : `<p class="muted">Aún no hay prompts guardados</p>`}</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close>Cerrar</button></div>`);
  $$("[data-use]").forEach(b => b.onclick = () => { const t = mainTextarea(); if (t) { t.value = promptLib[b.dataset.use].text; updCount(t); } if (promptLib[b.dataset.use].mode) { $("#h3Mode").value = promptLib[b.dataset.use].mode; renderModeSeg(); } closeModal(); });
  $$("[data-del]").forEach(b => b.onclick = async () => { promptLib.splice(+b.dataset.del, 1); await api("/api/prompts", { json: promptLib }); $("#btnLoadPrompt").onclick(); });
};

// ---------------- queue ----------------
const JST = { queued: "En cola", waiting: "Esperando GPU", uploading: "Subiendo", submitted: "Enviado", running: "Generando", downloading: "Descargando", done: "Completado", failed: "Fallido", canceled: "Cancelado" };
const ACTIVE = new Set(["queued", "waiting", "uploading", "submitted", "running", "downloading"]);
let jobs = [];
async function loadJobs() {
  try { jobs = await api("/api/jobs"); } catch { return; }
  if (page === "ai" && typeof aiGallery === "function") aiGallery();
  const n = jobs.filter(j => ACTIVE.has(j.status)).length;
  $("#qBadge").textContent = n || "";
  if (page !== "queue") return;
  const box = $("#jobList");
  if (!jobs.length) { box.innerHTML = `<div class="card empty">La cola está vacía. Inicia la GPU y envía tareas.<div class="row gap center" style="margin-top:12px"><button class="btn sm" data-empty="console">Ir a Consola para iniciar</button><button class="btn sm" data-empty="ai">Generar en pestaña IA</button><button class="btn sm" data-empty="gen">Ir a «Generar»</button></div></div>`; $$("[data-empty]", box).forEach(b => b.onclick = () => emptyAction(b.dataset.empty)); box._keyed = false; return; }
  if (!box._keyed) { box.innerHTML = ""; box._keyed = true; }
  // keyed update: only cards whose content changed are touched, and finished outputs
  // (video/img elements) are moved over untouched, so nothing reloads or flickers.
  const want = new Set(jobs.map(j => j.id));
  [...box.children].forEach(el => { if (!want.has(el.dataset.id)) el.remove(); });
  let prev = null;
  for (const j of jobs) {
    let el = [...box.children].find(c => c.dataset.id === j.id);
    if (!el) { el = document.createElement("div"); el.dataset.id = j.id; }
    const html = jobHTML(j);
    if (el._sig !== html) {
      const outsSig = JSON.stringify((j.outputs || []).map(o => o.path));
      const keep = el._outsSig === outsSig ? el.querySelector(".outs") : null;
      el.innerHTML = html;
      if (keep) { const fresh = el.querySelector(".outs"); if (fresh) fresh.replaceWith(keep); }
      else $$(".outs [data-path]", el).forEach(m => m.onclick = () => preview(m.dataset.path, m.dataset.kind));
      $$("[data-act]", el).forEach(btn => btn.onclick = () => jobAct(btn.dataset.act, btn.dataset.id));
      el._sig = html; el._outsSig = outsSig;
    }
    const want = prev ? prev.nextSibling : box.firstChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
  }
}
function jobHTML(j) {
  const dur = j.finished && j.started ? " · Duración " + fmtDur(j.finished - j.started) : j.started ? " · Transcurrido " + fmtDur(Date.now() / 1000 - j.started) : "";
  const showBar = ["running", "downloading", "submitted", "uploading"].includes(j.status);
  const pct = j.status === "running" ? Math.round((j.progress || 0) * 100) : j.status === "downloading" ? 100 : 0;
  const seeds = j.used_seeds && Object.keys(j.used_seeds).length ? Object.values(j.used_seeds).join(", ") : Object.entries(j.values || {}).filter(([k]) => /\.(noise_)?seed$/.test(k)).map(([, v]) => v).join(", ");
  const acts = [];
  if (ACTIVE.has(j.status)) acts.push(`<button class="btn sm" data-act="cancel" data-id="${j.id}">Cancelar</button>`);
  const child = jobs.find(x => x.parent_id === j.id);
  if (j.draft && j.status === "done") acts.push(child ? `<button class="btn sm ghost" disabled>Alta resolución generada</button>` : `<button class="btn sm primary" data-act="hires" data-id="${j.id}">Generar versión HD${j.full_res ? " " + esc(j.full_res) : ""}</button>`);
  if (["failed", "canceled", "done"].includes(j.status)) acts.push(`<button class="btn sm" data-act="retry" data-id="${j.id}">${j.status === "done" ? "Volver a ejecutar" : "Reintentar"}</button>`);
  acts.push(`<button class="btn sm ghost" data-act="again" data-id="${j.id}">Cargar en formulario</button>`);
  if (!ACTIVE.has(j.status) || j.status === "queued" || j.status === "waiting") acts.push(`<button class="btn sm ghost danger" data-act="del" data-id="${j.id}">Eliminar</button>`);
  const outs = (j.outputs || []).map(o => o.kind === "video" ? `<video src="${fileURL(o.path)}" preload="metadata" muted data-path="${esc(o.path)}" data-kind="video"></video>` : o.kind === "image" ? `<img src="${fileURL(o.path)}" data-path="${esc(o.path)}" data-kind="image">` : `<button class="btn sm" data-path="${esc(o.path)}" data-kind="${o.kind}">${esc(o.filename)}</button>`).join("");
  const tag = j.draft ? `<span class="tag draft">Borrador ${esc(j.draft_res || "")}</span>` : j.parent_id ? `<span class="tag hires">HD ${esc(j.full_res || "")}</span>` : "";
  const autoTag = j.auto_hires ? `<span class="tag autohd" title="Pipeline encadenado Auto-HD activo">⚡ Auto-HD</span>` : "";
  return `<div class="job${j.draft ? " is-draft" : ""}"><div><div class="t"><span class="st ${j.status}">${JST[j.status] || j.status}</span>${tag}${autoTag}${esc(j.title)}</div>
    <div class="meta">${esc(j.template_name)} · ${fmtTime(j.created)}${dur}${seeds ? " · semilla " + esc(seeds) : ""}</div>
    <div class="msg">${esc(j.message)}${j.status === "running" && j.node ? ` · Nodo #${esc(j.node)}` : ""}${j.status === "running" ? ` · ${pct}%` : ""}</div></div>
    <div class="acts">${acts.join("")}</div>
    ${showBar ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ""}
    ${outs ? `<div class="outs">${outs}</div>` : ""}</div>`;
}
async function jobAct(act, id) {
  try {
    if (act === "cancel") await api(`/api/jobs/${id}/cancel`, { json: {} });
    if (act === "retry") await api(`/api/jobs/${id}/retry`, { json: {} });
    if (act === "hires") { await api(`/api/jobs/${id}/hires`, { json: {} }); toast("Añadida versión en alta resolución (misma semilla, resolución completa)"); }
    if (act === "del") await api(`/api/jobs/${id}`, { method: "DELETE" });
    if (act === "again") {
      const j = jobs.find(x => x.id === id);
      if (!templates.find(t => t.id === j.template_id)) return toast("La plantilla de esta tarea fue eliminada");
      const vals = { ...j.values };
      for (const [k, p] of Object.entries(j.uploads || {})) vals["@up:" + k] = p;
      for (const k of j.random_seeds || []) vals["@rand:" + k] = true;
      show("gen"); selectTpl(j.template_id, vals); $("#jobTitle").value = j.title === j.template_name ? "" : j.title;
      return;
    }
    loadJobs();
  } catch (e) { toast(e.message); }
}
$("#btnClearDone").onclick = async () => { await api("/api/jobs/clear", { json: {} }); loadJobs(); };

// ---------------- results ----------------
async function loadFiles() {
  let r; try { r = await api("/api/files"); } catch (e) { $("#fileGrid").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  $("#outDirText").textContent = i18n.t("results_folder", { dir: r.dir });
  const k = $("#kindFilter").value;
  const fs = r.files.filter(f => !k || f.kind === k);
  $("#fileGrid").innerHTML = fs.length ? fs.map(f => `<div class="file"><div class="media" data-path="${esc(f.path)}" data-kind="${f.kind}">${f.kind === "video" ? `<video src="${fileURL(f.path)}#t=0.1" preload="metadata" muted></video>` : f.kind === "image" ? `<img src="${fileURL(f.path)}" loading="lazy">` : `<span class="aud">♪</span>`}</div>
    <div class="info"><div class="n" title="${esc(f.name)}">${esc(f.name)}</div><div class="row"><span>${esc(f.dir)} · ${fmtSize(f.size)}</span><span><button data-reveal="${esc(f.path)}">Ver en Finder</button><button data-del="${esc(f.path)}">Eliminar</button></span></div></div></div>`).join("") : `<div class="card empty" style="grid-column:1/-1">Aún no hay archivos de resultados. Inicia la GPU y envía tareas para que los resultados se descarguen automáticamente aquí.<div class="row gap center" style="margin-top:12px"><button class="btn sm" data-empty="console">Ir a Consola</button><button class="btn sm" data-empty="ai">Generar en pestaña IA</button></div></div>`;
  $$("#fileGrid .media").forEach(m => m.onclick = () => preview(m.dataset.path, m.dataset.kind));
  $$("#fileGrid [data-reveal]").forEach(b => b.onclick = () => api("/api/open", { json: { path: b.dataset.reveal } }));
  $$("#fileGrid [data-del]").forEach(b => b.onclick = async () => { if (!await appConfirm("¿Eliminar este archivo?")) return; await api("/api/delete-file", { json: { path: b.dataset.del } }); loadFiles(); });
  $$("#fileGrid video").forEach(v => { v.onmouseenter = () => v.play().catch(() => { }); v.onmouseleave = () => v.pause(); });
  $$("#fileGrid [data-empty]").forEach(b => b.onclick = () => emptyAction(b.dataset.empty));
}
$("#kindFilter").onchange = loadFiles;
$$("#kindSeg button").forEach(b => b.onclick = () => { $$("#kindSeg button").forEach(x => x.classList.toggle("on", x === b)); $("#kindFilter").value = b.dataset.k; loadFiles(); });

// H3 mode segmented control (mirrors the hidden <select>)
const H3_MODES = [["T2VA", "Texto a vídeo"], ["I2VA", "Primer fotograma"], ["FL2VA", "Primer y último fotograma"], ["L2VA", "Último fotograma"], ["Ref2VA", "Referencia total"]];
function renderModeSeg() {
  $("#h3ModeSeg").innerHTML = H3_MODES.map(([v, n]) => `<button type="button" data-v="${v}" class="${$("#h3Mode").value === v ? "on" : ""}" title="${n}">${v}</button>`).join("");
  $$("#h3ModeSeg button").forEach(b => b.onclick = () => { $("#h3Mode").value = b.dataset.v; renderModeSeg(); saveDraftSoon(); });
}
renderModeSeg();

// theme toggle
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const eff = t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $$("[data-theme-set]").forEach(b => b.classList.toggle("on", b.dataset.themeSet === eff));
}
$$("[data-theme-set]").forEach(b => b.onclick = () => { try { localStorage.setItem("ckwb.theme", b.dataset.themeSet); } catch { } applyTheme(b.dataset.themeSet); });
let savedTheme = null; try { savedTheme = localStorage.getItem("ckwb.theme"); } catch { }
applyTheme(savedTheme);

// experience mode toggle (simple vs advanced)
function getExpMode() {
  try {
    const m = localStorage.getItem("ckwb.expMode");
    if (m === "advanced" || m === "simple") return m;
  } catch (e) {}
  return "simple";
}
function setExpMode(mode) {
  const m = mode === "advanced" ? "advanced" : "simple";
  try { localStorage.setItem("ckwb.expMode", m); } catch (e) {}
  document.documentElement.dataset.exp = m;
  $$("#expSeg button").forEach(b => b.classList.toggle("on", b.dataset.exp === m));
  const advDetails = $("#aiAdvDetails");
  if (advDetails) {
    if (m === "advanced") advDetails.open = true;
    else advDetails.open = false;
  }
  const banner = $("#genSimpleBanner");
  if (banner) banner.hidden = (m !== "simple");
  if (page === "ai" && typeof aiRender === "function") aiRender();
}
$$("#expSeg button").forEach(b => b.onclick = () => setExpMode(b.dataset.exp));
const btnGoAI = $("#btnGoAIStudio");
if (btnGoAI) btnGoAI.onclick = () => show("ai");
setExpMode(getExpMode());
$("#btnRefreshFiles").onclick = loadFiles;
$("#btnOpenOut").onclick = () => api("/api/open", { json: { path: "" } });
function preview(path, kind) {
  const u = fileURL(path), name = path.split(/[\\/]/).pop();
  const media = kind === "video" ? `<video src="${u}" controls autoplay loop></video>` : kind === "image" ? `<img src="${u}">` : kind === "audio" ? `<audio src="${u}" controls autoplay></audio>` : "";
  openModal(`${media}<div class="row between gap"><span class="muted small">${esc(name)}</span><span class="row gap"><button class="btn sm" id="pvReveal">Mostrar en Finder</button><button class="btn sm" data-close>Cerrar</button></span></div>`);
  $("#pvReveal").onclick = () => api("/api/open", { json: { path } });
}
function openModal(html) { $("#modalBox").innerHTML = html; $("#modal").hidden = false; $$("[data-close]").forEach(b => b.onclick = closeModal); }
function closeModal() { $("#modal").hidden = true; $("#modalBox").innerHTML = ""; }
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// ---------------- library (on-demand nodes / models) ----------------
const MODEL_DIRS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "controlnet", "SEEDVR2"];
const PRESETS = [
  { group: "Ampliación de vídeo con SeedVR2", items: [
    { kind: "node", url: "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler", title: "Nodo SeedVR2 Video Upscaler", on: true },
    { kind: "model", url: "hf://numz/SeedVR2_comfyUI/ema_vae_fp16.safetensors", dest: "SEEDVR2/ema_vae_fp16.safetensors", title: "SeedVR2 VAE (obligatorio)", on: true },
    { kind: "model", url: "hf://numz/SeedVR2_comfyUI/seedvr2_ema_3b_fp16.safetensors", dest: "SEEDVR2/seedvr2_ema_3b_fp16.safetensors", title: "DiT 3B fp16 (rápido)", on: true },
    { kind: "model", url: "hf://numz/SeedVR2_comfyUI/seedvr2_ema_7b_fp16.safetensors", dest: "SEEDVR2/seedvr2_ema_7b_fp16.safetensors", title: "DiT 7B fp16 (máxima calidad)", on: false },
    { kind: "model", url: "hf://numz/SeedVR2_comfyUI/seedvr2_ema_7b_sharp_fp16.safetensors", dest: "SEEDVR2/seedvr2_ema_7b_sharp_fp16.safetensors", title: "DiT 7B sharp fp16 (más nítido)", on: false },
  ] },
];
let lib = null, libErr = "", libSel = new Set(), libTimer = null;
async function loadLib() {
  try { lib = await api("/api/gate/library"); libErr = ""; }
  catch (e) { lib = null; libErr = e.message; }
  renderLib();
  clearTimeout(libTimer);
  if (page === "lib") libTimer = setTimeout(loadLib, lib && lib.fetching && lib.fetching.length ? 1500 : 4000);
}
function renderLib() {
  const note = $("#libNote"), list = $("#libList");
  note.className = "lib-note";
  if (!lib) {
    note.classList.add("bad");
    note.textContent = i18n.t("lib_err_read", { err: libErr });
    list.innerHTML = ""; $("#libBar").hidden = true; return;
  }
  const ready = gst && gst.state === "ready";
  const busy = lib.fetching && lib.fetching.length;
  const dl = gst && gst.progress && gst.progress.download;
  if (busy) note.innerHTML = `<span class="dot s-busy"></span>` + i18n.t("lib_installing", { n: lib.fetching.length }).replace("{n} elemento(s)", "${lib.fetching.length} elemento(s)") + (dl && dl.total_gb ? `<div class="bar"><div style="width:${Math.min(100, dl.done_gb / dl.total_gb * 100)}%"></div></div><span class="mono">${dl.done_gb.toFixed(1)}/${dl.total_gb.toFixed(1)} GB</span>` : "");
  else if (lib.fetch_error) { note.classList.add("bad"); note.textContent = i18n.t("lib_fetch_error", { err: lib.fetch_error }); }
  else note.textContent = ready ? "" : i18n.t("lib_gpu_not_ready");
  const items = (lib.items || []).slice().sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "node" ? -1 : 1));
  if (!items.length) { list.innerHTML = ""; note.innerHTML = `<div class="lib-empty grow">La biblioteca está vacía. Haz clic arriba en «＋ Añadir» para agregar nodos o modelos, o usa «Plantillas predefinidas» para añadir SeedVR2.</div>`; $("#libBar").hidden = true; return; }
  const inst = new Set(lib.installed || []), fetching = new Set((lib.fetching || []).map(x => x.replace(/^lib:/, "")));
  list.innerHTML = items.map(it => {
    const st = fetching.has(it.id) ? `<span class="lstat busy">Instalando</span>` : inst.has(it.id) ? `<span class="lstat on">En GPU</span>` : `<span class="lstat">No instalado</span>`;
    const sub = it.kind === "model" ? `models/${esc(it.dest)}${it.size_gb ? " · " + it.size_gb.toFixed(2) + " GB" : ""}` : esc(it.url.replace(/^https:\/\//, ""));
    return `<div class="lib-row" data-id="${esc(it.id)}">
      <input type="checkbox" data-sel="${esc(it.id)}" ${libSel.has(it.id) ? "checked" : ""}>
      <span class="kind ${it.kind}">${i18n.it.kind === "node" ? i18n.t("lib_kind_node") : i18n.t("lib_kind_model")}</span>
      <div class="main"><div class="ti">${esc(it.title)}</div><div class="sub" title="${esc(it.url)}">${sub}</div></div>
      <div class="acts">${st}<label class="seg-chk" title="Instalar automáticamente cada vez que inicies la GPU (aumentará el tiempo de arranque)"><input type="checkbox" data-auto="${esc(it.id)}" ${it.auto_wake ? "checked" : ""}><span>Al iniciar</span></label></div>
      <div class="acts"><button class="btn xs" data-inst="${esc(it.id)}" ${!ready || busy || inst.has(it.id) ? "disabled" : ""}>Instalar</button><button class="btn ghost xs danger" data-del="${esc(it.id)}">Eliminar</button></div>
    </div>`;
  }).join("");
  $$("[data-sel]", list).forEach(c => c.onchange = () => { c.checked ? libSel.add(c.dataset.sel) : libSel.delete(c.dataset.sel); renderLibBar(); });
  $$("[data-auto]", list).forEach(c => c.onchange = async () => {
    const it = lib.items.find(x => x.id === c.dataset.auto);
    try { await api("/api/gate/library", { json: { ...it, auto_wake: c.checked } }); toast(c.checked ? "Se instalará automáticamente en el próximo arranque" : "Cambiado a instalación bajo demanda"); } catch (e) { toast("Error al guardar: " + e.message); }
    loadLib();
  });
  $$("[data-inst]", list).forEach(b => b.onclick = () => libInstall([b.dataset.inst]));
  $$("[data-del]", list).forEach(b => b.onclick = async () => {
    if (!await appConfirm("¿Eliminar este elemento de la biblioteca? (No afectará a los archivos ya descargados en la GPU actual)")) return;
    try { await api("/api/gate/library/" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); libSel.delete(b.dataset.del); } catch (e) { toast(e.message); }
    loadLib();
  });
  renderLibBar();
}
function renderLibBar() {
  const ids = [...libSel].filter(id => lib && lib.items.some(i => i.id === id));
  $("#libBar").hidden = !ids.length;
  $("#libSel").textContent = `${ids.length} seleccionado(s)`;
  $("#btnLibInstallSel").disabled = !(gst && gst.state === "ready") || (lib && lib.fetching && lib.fetching.length);
}
$("#btnLibClear").onclick = () => { libSel.clear(); renderLib(); };
$("#btnLibInstallSel").onclick = () => libInstall([...libSel]);
async function libInstall(ids) {
  const hasNode = ids.some(id => (lib.items.find(i => i.id === id) || {}).kind === "node");
  const active = jobs.some(j => ["running", "submitted", "uploading"].includes(j.status));
  if (hasNode && active && !await appConfirm("Instalar nuevos nodos reiniciará ComfyUI (aprox. 30 s), lo que interrumpirá las tareas en curso. ¿Deseas continuar?")) return;
  try { await api("/api/gate/library/install", { json: { ids } }); toast("Instalación iniciada"); libSel.clear(); }
  catch (e) { toast("Error al instalar: " + e.message); }
  loadLib();
}
function libForm(prefill = {}) {
  const k = prefill.kind || "node";
  openModal(`<h3>Añadir a la biblioteca</h3><p class="hint" style="margin:0 0 12px">Solo se guarda en la lista; no se instalará de inmediato.</p>
    <div class="seg" id="lfKind" style="margin-bottom:14px"><button type="button" data-k="node">Nodo (repositorio Git)</button><button type="button" data-k="model">Archivo de modelo</button></div>
    <div class="form-grid">
      <label class="fld full" id="lfUrlL">URL de descarga<input id="lfUrl" placeholder=""></label>
      <label class="fld lf-model">Carpeta de destino<select id="lfDir">${MODEL_DIRS.map(d => `<option>${d}</option>`).join("")}<option value="__custom">Personalizada…</option></select></label>
      <label class="fld lf-model">Nombre de archivo<input id="lfFile" placeholder="Se extraerá automáticamente del enlace"></label>
      <label class="fld lf-model full" id="lfDirCustomL" hidden>Carpeta personalizada (relativa a ComfyUI/models)<input id="lfDirCustom" placeholder="Ejemplo: SEEDVR2"></label>
      <label class="fld full">Nombre descriptivo (opcional)<input id="lfTitle"></label>
    </div>
    <label class="chk"><input type="checkbox" id="lfAuto">Instalar automáticamente cada vez que inicies la GPU</label>
    <p class="err" id="lfErr"></p>
    <div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="lfSave">Guardar en biblioteca</button></div>`);
  let kind = k;
  const sync = () => {
    $$("#lfKind button").forEach(b => b.classList.toggle("on", b.dataset.k === kind));
    $$(".lf-model").forEach(e => e.hidden = kind !== "model");
    $("#lfDirCustomL").hidden = kind !== "model" || $("#lfDir").value !== "__custom";
    $("#lfUrl").placeholder = kind === "node" ? "https://github.com/autor/repositorio" : "https://huggingface.co/…/resolve/main/xxx.safetensors o hf://autor/repo/archivo";
  };
  $$("#lfKind button").forEach(b => b.onclick = () => { kind = b.dataset.k; sync(); });
  $("#lfDir").onchange = sync;
  $("#lfUrl").oninput = () => { if (kind === "model" && !$("#lfFile").dataset.touched) $("#lfFile").value = decodeURIComponent($("#lfUrl").value.split("?")[0].split("/").pop() || ""); };
  $("#lfFile").oninput = () => $("#lfFile").dataset.touched = "1";
  sync();
  $("#lfSave").onclick = async () => {
    const url = $("#lfUrl").value.trim();
    const body = { kind, url, title: $("#lfTitle").value.trim(), auto_wake: $("#lfAuto").checked };
    if (kind === "model") {
      const dir = $("#lfDir").value === "__custom" ? $("#lfDirCustom").value.trim().replace(/^\/+|\/+$/g, "") : $("#lfDir").value;
      const file = $("#lfFile").value.trim() || url.split("?")[0].split("/").pop();
      body.dest = dir + "/" + file;
    }
    $("#lfSave").disabled = true; $("#lfSave").textContent = "Guardando…";
    try { await api("/api/gate/library", { json: body }); closeModal(); toast("Añadido a la biblioteca"); loadLib(); }
    catch (e) { $("#lfErr").textContent = e.message; $("#lfSave").disabled = false; $("#lfSave").textContent = "Guardar en biblioteca"; }
  };
}
$("#btnLibAdd").onclick = () => libForm();
$("#btnLibPreset").onclick = () => {
  openModal(`<h3>Plantillas predefinidas</h3><p class="hint" style="margin:0">Marca los elementos que deseas agregar a la biblioteca (solo a la lista, no se descargan ahora).</p>` + PRESETS.map((g, gi) => `<div class="sec-h" style="margin:14px 0 6px"><b>${esc(g.group)}</b></div><div class="preset">${g.items.map((it, i) => `<label><input type="checkbox" data-p="${gi}.${i}" ${it.on ? "checked" : ""}><span class="kind ${it.kind}" style="width:40px">${i18n.it.kind === "node" ? i18n.t("lib_kind_node") : i18n.t("lib_kind_model")}</span>${esc(it.title)}<span class="x">${esc(it.dest || it.url.replace("https://github.com/", ""))}</span></label>`).join("")}</div>`).join("") + `<p class="err" id="psErr"></p><div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="psAdd">Añadir a la biblioteca</button></div>`);
  $("#psAdd").onclick = async () => {
    const picks = $$("[data-p]:checked").map(c => { const [g, i] = c.dataset.p.split(".").map(Number); return PRESETS[g].items[i]; });
    $("#psAdd").disabled = true; $("#psAdd").textContent = "Añadiendo…";
    try { for (const it of picks) await api("/api/gate/library", { json: { kind: it.kind, url: it.url, dest: it.dest, title: it.title } }); closeModal(); toast(`Añadidos ${picks.length} elementos`); loadLib(); }
    catch (e) { $("#psErr").textContent = e.message; $("#psAdd").disabled = false; $("#psAdd").textContent = "Añadir a la biblioteca"; }
  };
};

// ---------------- LLM providers (settings) ----------------
const LLM_PRESETS = [
  { name: "DeepSeek", kind: "openai", base_url: "https://api.deepseek.com/v1" },
  { name: "Qwen (Alibaba DashScope)", kind: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "Kimi (Moonshot AI)", kind: "openai", base_url: "https://api.moonshot.cn/v1" },
  { name: "Zhipu GLM", kind: "openai", base_url: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "SiliconFlow", kind: "openai", base_url: "https://api.siliconflow.cn/v1" },
  { name: "OpenRouter", kind: "openai", base_url: "https://openrouter.ai/api/v1" },
  { name: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1" },
  { name: "Ollama (local)", kind: "openai", base_url: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio (local)", kind: "openai", base_url: "http://127.0.0.1:1234/v1" },
  { name: "Claude (Anthropic)", kind: "anthropic", base_url: "https://api.anthropic.com" },
  { name: "Gemini (Google)", kind: "gemini", base_url: "https://generativelanguage.googleapis.com" },
];
const KIND_CN = new Proxy({}, { get: (_, k) => i18n.t("sec_llm_preset_" + k) });
let llms = [], defaultLLM = "";
function renderLLMs() {
  $("#llmList").innerHTML = llms.map((p, i) => `<div class="llm-row">
    <input type="radio" name="llmdef" value="${esc(p.id)}" ${p.id === defaultLLM || (!defaultLLM && i === 0) ? "checked" : ""} title="Establecer como predeterminado">
    <div style="min-width:0"><div class="ti">${esc(p.name)} <span class="pill sm">${KIND_CN[p.kind] || p.kind}</span></div><div class="sub">${esc(p.model || "(modelo sin especificar)")} · ${esc(p.base_url || "")}</div></div>
    <div class="acts"><span class="muted small" data-tmsg="${i}"></span><button type="button" class="btn xs" data-ltest="${i}">Probar</button><button type="button" class="btn ghost xs" data-ledit="${i}">Editar</button><button type="button" class="btn ghost xs danger" data-ldel="${i}">Eliminar</button></div>
  </div>`).join("");
  $$("[name=llmdef]").forEach(r => r.onchange = () => { defaultLLM = r.value; saveAll("Establecido como predeterminado"); });
  $$("[data-ledit]").forEach(b => b.onclick = () => llmForm(+b.dataset.ledit));
  $$("[data-ldel]").forEach(b => b.onclick = async () => { if (!await appConfirm("¿Eliminar este proveedor de API?")) return; llms.splice(+b.dataset.ldel, 1); saveAll("Eliminado"); });
  $$("[data-ltest]").forEach(b => b.onclick = async () => {
    const m = $(`[data-tmsg="${b.dataset.ltest}"]`); m.textContent = "Probando conexión…";
    try { const r = await api("/api/llm/test", { json: llms[+b.dataset.ltest] }); m.textContent = `✓ ${r.ms} ms`; }
    catch (e) { m.textContent = "✗ " + e.message; m.title = e.message; }
  });
}
async function saveAll(msg) {
  await $("#setForm").onsubmit({ preventDefault() { }, target: $("#setForm") });
  if (msg) toast(msg);
}
function llmForm(idx) {
  const p = idx != null ? { ...llms[idx] } : { kind: "openai", name: "", base_url: "", api_key: "", model: "" };
  openModal(`<h3>${idx != null ? "Editar" : "Añadir"} API de modelo LLM</h3>
    <div class="form-grid" style="margin-top:12px">
      ${idx == null ? `<label class="fld full">Plantilla de servicio<select id="lpPreset"><option value="">— Elegir un servicio común (opcional) —</option>${LLM_PRESETS.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join("")}</select></label>` : ""}
      <label class="fld full">Tipo de interfaz<div class="seg" id="lpKind">${Object.entries(KIND_CN).map(([k, n]) => `<button type="button" data-k="${k}">${n}</button>`).join("")}</div></label>
      <label class="fld">Nombre<input id="lpName" value="${esc(p.name)}"></label>
      <label class="fld">Base URL<input id="lpBase" value="${esc(p.base_url)}" placeholder="Dejar en blanco para usar la URL oficial"></label>
      <label class="fld full">Clave API (API Key)<input id="lpKey" type="password" value="${esc(p.api_key)}" autocomplete="off" placeholder="Para modelos locales (Ollama / LM Studio) puede quedar vacía"></label>
      <label class="fld full">Modelo<div class="row gap"><input id="lpModel" class="grow" list="lpModels" value="${esc(p.model)}" placeholder="Nombre del modelo, o haz clic en obtener lista"><datalist id="lpModels"></datalist><button type="button" class="btn xs" id="lpFetch">Obtener lista</button></div></label>
    </div>
    <p class="hint" style="margin-top:0">Consejo: Si quieres generar contenido sin filtros, puedes conectar Ollama / LM Studio local o un modelo libre en OpenRouter. Para procesar imágenes de referencia, usa un modelo con capacidad de visión multimodal.</p>
    <p class="err" id="lpErr"></p>
    <div class="row end"><button type="button" class="btn" data-close>Cancelar</button><button type="button" class="btn" id="lpTest">Probar</button><button type="button" class="btn primary" id="lpSave">Guardar</button></div>`);
  let kind = p.kind;
  const sync = () => $$("#lpKind button").forEach(b => b.classList.toggle("on", b.dataset.k === kind));
  $$("#lpKind button").forEach(b => b.onclick = () => { kind = b.dataset.k; sync(); });
  sync();
  if ($("#lpPreset")) $("#lpPreset").onchange = e => { const x = LLM_PRESETS[e.target.value]; if (!x) return; kind = x.kind; sync(); $("#lpName").value = x.name; $("#lpBase").value = x.base_url; };
  const cur = () => ({ id: p.id || "", name: $("#lpName").value.trim() || KIND_CN[kind], kind, base_url: $("#lpBase").value.trim(), api_key: $("#lpKey").value.trim(), model: $("#lpModel").value.trim() });
  $("#lpFetch").onclick = async () => {
    $("#lpErr").textContent = ""; $("#lpFetch").textContent = "Obteniendo…";
    try { const r = await api("/api/llm/models", { json: cur() }); $("#lpModels").innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join(""); $("#lpFetch").textContent = `${r.models.length} modelos`; $("#lpModel").focus(); }
    catch (e) { $("#lpErr").textContent = "Error al obtener modelos: " + e.message; $("#lpFetch").textContent = "Obtener lista"; }
  };
  $("#lpTest").onclick = async () => {
    $("#lpErr").textContent = "Probando…";
    try { const r = await api("/api/llm/test", { json: cur() }); $("#lpErr").textContent = ""; toast(`Conexión exitosa (${r.ms} ms)`); }
    catch (e) { $("#lpErr").textContent = "Error en la prueba: " + e.message; }
  };
  $("#lpSave").onclick = async () => {
    const v = cur();
    if (!v.model) { $("#lpErr").textContent = "Indica el nombre del modelo"; return; }
    if (idx != null) llms[idx] = v; else llms.push(v);
    closeModal(); await saveAll("Guardado");
  };
}
$("#btnLLMAdd").onclick = () => llmForm(null);

// ---- imported H3 prompt guide (only on this Mac; the official guide is not shipped with WakeGPU) ----
let guideInfo = { imported: false };
async function loadGuide() {
  try { guideInfo = await api("/api/prompt-guide"); } catch { }
  $("#guideState").textContent = guideInfo.imported ? i18n.t("sec_h3_imported", { size: fmtSize(guideInfo.size), modified: fmtTime(guideInfo.modified) }) : i18n.t("sec_h3_not_imported");
  $("#btnGuideClear").hidden = !guideInfo.imported;
  $("#btnGuideImport").textContent = guideInfo.imported ? i18n.t("sec_h3_reimport") : i18n.t("sec_h3_import");
}
$("#btnGuideImport").onclick = () => $("#guideFile").click();
$("#guideFile").onchange = async () => {
  const f = $("#guideFile").files[0]; $("#guideFile").value = "";
  if (!f) return;
  if (!/\.(md|txt)$/i.test(f.name)) return toast("Solo se admiten archivos .md o .txt");
  if (f.size > 1 << 20) return toast("Archivo demasiado grande (máximo 1 MB)");
  try { await api("/api/prompt-guide", { json: { name: f.name, text: await f.text() } }); toast("Guía importada; el asistente de IA la utilizará"); }
  catch (e) { toast("Error al importar: " + e.message); }
  loadGuide();
};
$("#btnGuideClear").onclick = async () => {
  if (!await appConfirm("¿Eliminar la guía importada de H3? A partir de ahora se usarán las instrucciones genéricas integradas.")) return;
  await api("/api/prompt-guide", { method: "DELETE" }).catch(e => toast(e.message));
  loadGuide();
};
loadGuide();

// ---------------- AI prompt writer ----------------
let aiCtl = null, aiState = { tab: "new", idea: "", instr: "", withImg: true };
async function formImages() {
  const files = $$("#genForm input[type=file]").map(i => i.files && i.files[0]).filter(f => f && f.type.startsWith("image/"));
  const out = [];
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = url; });
    const sc = Math.min(1, 1280 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    out.push(cv.toDataURL("image/jpeg", 0.88));
    URL.revokeObjectURL(url);
  }
  return out;
}
$("#btnAI").onclick = async () => {
  if (!llms.length) { toast("Añade primero un modelo en «Ajustes → Modelos LLM»"); show("settings"); setTimeout(() => $("#btnLLMAdd").scrollIntoView({ block: "center" }), 100); return; }
  const imgs = await formImages().catch(() => []);
  const t = mainTextarea();
  openModal(`<div class="row between" style="margin-bottom:12px"><h3 style="margin:0">✦ Redactor de prompts con IA</h3><span class="muted small mono">${esc($("#h3Mode").value)} · ${esc($("#h3Dur").value)} s</span></div>
  <div class="ai-box">
    <div class="left">
      <div class="ai-row"><span class="lbl">Modelo</span><select id="aiProv" class="grow">${llms.map(p => `<option value="${esc(p.id)}" ${p.id === (defaultLLM || llms[0].id) ? "selected" : ""}>${esc(p.name)} · ${esc(p.model)}</option>`).join("")}</select></div>
      <div class="ai-row"><span class="lbl">Estilo</span><select id="aiStyle" class="grow">
        <option value="muse6">🎬 Cine en 6 Bloques (Muse / Wan 2.1)</option>
        <option value="apple">🍎 Comercial Dinámico (Apple Don't Blink)</option>
        <option value="bladerunner">🌧️ Sci-Fi Monumental (Blade Runner 2049)</option>
        <option value="fincher">🕵️ Thriller Noir (David Fincher)</option>
        <option value="anime">🌸 Anime Cinematográfico (Shinkai)</option>
        <option value="macro">💎 Macro Producto de Lujo</option>
        <option value="free">⚡ Estilo Libre / General</option>
      </select></div>
      <div class="seg" id="aiTab"><button type="button" data-t="new">Desde una idea</button><button type="button" data-t="edit">Reescribir prompt actual</button></div>
      <textarea id="aiIn" placeholder=""></textarea>
      ${imgs.length ? `<label class="chk" style="margin:0"><input type="checkbox" id="aiImg" ${aiState.withImg ? "checked" : ""}>Adjuntar las ${imgs.length} imagen(es) del formulario para que el modelo las analice</label><div class="ai-thumbs">${imgs.map(u => `<img src="${u}">`).join("")}</div>` : `<p class="hint" style="margin:0">En modos con imagen de inicio/fin, sube una imagen en el formulario para que el modelo la use de referencia.</p>`}
      <div class="ai-row"><button type="button" class="btn primary" id="aiGo">Generar</button><button type="button" class="btn" id="aiStop" hidden>Detener</button></div>
      <p class="hint" style="margin:0">Redacta planos, movimientos de cámara, diálogos, ambientación sonora y música. La duración y el modo se toman de la pestaña Generar. ${guideInfo.imported ? "Se adapta a tu guía importada." : "Usa las instrucciones genéricas integradas (puedes importar la guía oficial en Ajustes)."}</p>
    </div>
    <div class="ai-out">
      <div class="ai-meta" id="aiMeta"></div>
      <textarea id="aiOut" spellcheck="false" placeholder="El resultado generado aparecerá aquí; puedes editarlo directamente"></textarea>
      <div class="ai-row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cerrar</button><button type="button" class="btn" id="aiCopy">Copiar</button><button type="button" class="btn" id="aiInsert">Insertar en cursor</button><button type="button" class="btn primary" id="aiUse">Usar como prompt</button></div>
    </div>
  </div>`);
  const syncTab = () => {
    $$("#aiTab button").forEach(b => b.classList.toggle("on", b.dataset.t === aiState.tab));
    $("#aiIn").value = aiState.tab === "new" ? aiState.idea : aiState.instr;
    $("#aiIn").placeholder = aiState.tab === "new" ? "Escribe tu idea, por ejemplo: En una pradera al atardecer, una chica mira a la cámara, el viento mueve su pelo y dice suavemente «es hora de volver a casa», a lo lejos se oye un tren" : "Describe los cambios, por ejemplo: Acercar la cámara lentamente; añadir un diálogo; cambiar la música a un piano suave";
  };
  $$("#aiTab button").forEach(b => b.onclick = () => { if (aiState.tab === "new") aiState.idea = $("#aiIn").value; else aiState.instr = $("#aiIn").value; aiState.tab = b.dataset.t; syncTab(); });
  syncTab();
  $("#aiIn").focus();
  $("#aiCopy").onclick = () => { navigator.clipboard.writeText($("#aiOut").value).then(() => toast("Copiado al portapapeles")); };
  $("#aiUse").onclick = () => { if (!t) return toast("Esta plantilla no tiene parámetros de texto"); t.value = $("#aiOut").value.trim(); updCount(t); closeModal(); toast("Prompt aplicado al formulario"); };
  $("#aiInsert").onclick = () => { closeModal(); insertText($("#aiOut").value.trim()); };
  $("#aiStop").onclick = () => aiCtl && aiCtl.abort();
  $("#aiGo").onclick = async () => {
    const text = $("#aiIn").value.trim();
    if (aiState.tab === "new") aiState.idea = text; else aiState.instr = text;
    if (!text) return $("#aiIn").focus();
    if (aiState.tab === "edit" && !(t && t.value.trim())) return toast("El cuadro de prompt está vacío; usa primero «Desde una idea»");
    aiState.withImg = $("#aiImg") ? $("#aiImg").checked : false;
    const body = { provider: $("#aiProv").value, mode: $("#h3Mode").value, duration: +$("#h3Dur").value || 6,
      style: $("#aiStyle") ? $("#aiStyle").value : "muse6",
      idea: aiState.tab === "new" ? text : "", instruction: aiState.tab === "edit" ? text : "", current: aiState.tab === "edit" ? t.value : "",
      images: aiState.withImg ? imgs : [] };
    const out = $("#aiOut"); out.value = ""; $("#aiMeta").textContent = "Conectando…";
    $("#aiGo").hidden = true; $("#aiStop").hidden = false;
    aiCtl = new AbortController(); const t0 = Date.now(); let n = 0;
    try {
      const r = await fetch("/api/llm/write", { method: "POST", headers: { "X-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: aiCtl.signal });
      if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch { } throw new Error(m); }
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (chunk.match(/^event: (.*)$/m) || [])[1], data = (chunk.match(/^data: (.*)$/m) || [])[1];
          if (!data) continue;
          const v = JSON.parse(data);
          if (ev === "start") $("#aiMeta").textContent = `${v.provider} · ${v.model} · Generando…`;
          else if (ev === "delta") { out.value += v; n += v.length; out.scrollTop = out.scrollHeight; $("#aiMeta").textContent = `Generando… ${((Date.now() - t0) / 1000).toFixed(0)} s · ${n} caracteres`; }
          else if (ev === "error") throw new Error(v);
          else if (ev === "done") $("#aiMeta").textContent = `Completado · ${((Date.now() - t0) / 1000).toFixed(1)} s · ${out.value.trim().split(/\s+/).length} palabras`;
        }
      }
      out.value = out.value.replace(/^```[a-z]*\n?|```\s*$/g, "").trim();
    } catch (e) { $("#aiMeta").textContent = e.name === "AbortError" ? "Detenido" : "Error: " + e.message; }
    finally { $("#aiGo").hidden = false; $("#aiStop").hidden = true; $("#aiGo").textContent = "Regenerar"; aiCtl = null; }
  };
};

// ---------------- local mode (test) ----------------
let gAuthURL = "";
async function loadLocal() {
  let st = { signed_in: false };
  try { st = await api("/api/local/status"); } catch { }
  $("#gDot").className = "dot " + (st.signed_in ? "s-ok" : "");
  $("#gState").textContent = st.signed_in ? i18n.t("sec_local_not_signed").replace("Sin sesión en Google", "Sesión iniciada en Google: ") + (st.email || "") : i18n.t("sec_local_not_signed");
  $("#btnGLogin").hidden = st.signed_in; $("#btnGLogout").hidden = !st.signed_in;
  $("#gTools").hidden = !st.signed_in;
  if (st.signed_in) $("#gCodeBox").hidden = true;
}
$("#btnGLogin").onclick = async () => {
  $("#gErr").textContent = "";
  const r = await api("/api/local/login", { json: {} }); gAuthURL = r.url;
  $("#gCodeBox").hidden = false; $("#gCode").focus();
};
$("#gOpenAgain").onclick = e => { e.preventDefault(); if (gAuthURL) api("/api/open-url", { json: { url: gAuthURL } }); };
$("#btnGCode").onclick = async () => {
  $("#gErr").textContent = ""; $("#btnGCode").disabled = true;
  try { const r = await api("/api/local/code", { json: { code: $("#gCode").value } }); toast("Sesión iniciada con " + (r.email || "")); $("#gCode").value = ""; $("#gCCU").textContent = ""; await loadLocal(); await pollStatus(); $("#btnGCCU").click(); }
  catch (e) { $("#gErr").textContent = e.message; }
  finally { $("#btnGCode").disabled = false; }
};
$("#btnGLogout").onclick = async () => { if (!await appConfirm(i18n.t("sec_local_confirm_logout"))) return; await api("/api/local/logout", { json: {} }); $("#gCCU").textContent = ""; loadLocal(); pollStatus(); };
$("#btnGCCU").onclick = async () => {
  $("#gCCU").textContent = "Consultando saldo…"; $("#gErr").textContent = "";
  try { const r = await api("/api/local/ccu", { json: {} }); $("#gCCU").textContent = i18n.t("sec_local_ccu_result", { bal: r.balance.toFixed(2), ph: r.per_hour.toFixed(2), n: r.assignments, list: r.running.length ? " (" + r.running.join(", ") + ")" : "" }); }
  catch (e) { $("#gCCU").textContent = i18n.t("sec_local_ccu_err"); $("#gErr").textContent = e.message; }
  finally { pollStatus(); }
};
$("#btnGSmoke").onclick = async () => {
  const log = $("#gLog"); log.hidden = false; log.textContent = ""; $("#gErr").textContent = "";
  $("#btnGSmoke").disabled = true;
  const add = s => { log.textContent += s + "\n"; log.scrollTop = log.scrollHeight; };
  try {
    const r = await fetch("/api/local/smoke", { method: "POST", headers: { "X-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ accelerator: $("#gAcc").value }) });
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ch = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (ch.match(/^event: (.*)$/m) || [])[1], d = JSON.parse((ch.match(/^data: (.*)$/m) || [])[1] || "null");
        if (ev === "log") add(d); else if (ev === "fail") add("✗ " + d); else if (ev === "ok") add("✓ " + d); else if (ev === "done") add(i18n.t("sec_local_smoke_log_done", { s: d.toFixed(0) }));
      }
    }
  } catch (e) { add("✗ " + e.message); }
  finally { $("#btnGSmoke").disabled = false; }
};

// ---------------- load panel ----------------
const loadHist = { util: [], vram: [], ram: [], cpu: [] };
let loadBusy = false;
function pushHist(k, v) { if (v == null || isNaN(v)) return; const h = loadHist[k]; h.push(v); if (h.length > 72) h.shift(); }
function spark(k, max) {
  const h = loadHist[k]; if (h.length < 2) return `<svg class="spark"></svg>`;
  const W = 100, H = 26, n = h.length, mx = max || Math.max(...h, 1);
  const pts = h.map((v, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - 2 - Math.min(1, v / mx) * (H - 4)).toFixed(1)}`);
  const first = pts[0].split(",")[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon class="area" points="${first},${H} ${pts.join(" ")} ${W},${H}"/><polyline points="${pts.join(" ")}"/></svg>`;
}
const gb = b => (b / 1073741824);
function meter(k, label, val, unit, sub, pct, sparkKey, sparkMax, na) {
  const cls = pct >= 92 ? "crit" : pct >= 80 ? "hot" : "";
  return `<div class="meter ${na ? "na" : ""}"><div class="k"><span>${label}</span><span>${sub || ""}</span></div>
    <div class="v">${val}${unit ? `<small>${unit}</small>` : ""}</div>
    ${pct != null ? `<div class="mbar ${cls}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>` : ""}
    ${sparkKey ? spark(sparkKey, sparkMax) : ""}</div>`;
}
async function pollLoad() {
  if (loadBusy || page !== "console" || document.hidden || !$("#loadLive").checked) return;
  if (!gst || gst.state !== "ready") { if (!$("#loadCard .load-empty")) { $("#loadCard").innerHTML = `<div class="load-empty">Al iniciar la GPU se mostrará aquí la carga en tiempo real</div>`; for (const k in loadHist) loadHist[k] = []; } return; }
  loadBusy = true;
  let d; try { d = await api("/api/gpu/stats"); } catch { loadBusy = false; return; }
  loadBusy = false;
  if (!d.ready) return;
  const ss = d.system_stats || {}, dev = (ss.devices || [])[0] || {}, sys = ss.system || {};
  const nv = d.nv && d.nv.gpus && d.nv.gpus[0];
  const vramTot = nv ? nv.mem_total / 1024 : dev.vram_total ? gb(dev.vram_total) : null;
  const vramUsed = nv ? nv.mem_used / 1024 : dev.vram_total ? gb(dev.vram_total - dev.vram_free) : null;
  const ramTot = d.nv && d.nv.ram_total ? gb(d.nv.ram_total) : sys.ram_total ? gb(sys.ram_total) : null;
  const ramUsed = d.nv && d.nv.ram_total ? gb(d.nv.ram_used) : sys.ram_total ? gb(sys.ram_total - sys.ram_free) : null;
  pushHist("util", nv ? nv.util : null); pushHist("vram", vramUsed); pushHist("ram", ramUsed); pushHist("cpu", d.nv ? d.nv.cpu : null);
  const q = d.queue || { running: 0, pending: 0 };
  const name = (nv && nv.name) || (dev.name || "").replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*cudaMallocAsync$/, "") || "GPU";
  const local = d.mode === "local";
  const cells = [
    nv ? meter("u", "Uso de GPU", nv.util.toFixed(0), "%", "", nv.util, "util", 100) : meter("u", "Uso de GPU", "—", "", "Solo modo local", null, null, null, true),
    meter("v", "VRAM", vramUsed != null ? vramUsed.toFixed(1) : "—", vramTot ? `/ ${vramTot.toFixed(0)} GB` : "", vramTot ? Math.round(vramUsed / vramTot * 100) + "%" : "", vramTot ? vramUsed / vramTot * 100 : null, "vram", vramTot),
    meter("r", "RAM", ramUsed != null ? ramUsed.toFixed(1) : "—", ramTot ? `/ ${ramTot.toFixed(0)} GB` : "", ramTot ? Math.round(ramUsed / ramTot * 100) + "%" : "", ramTot ? ramUsed / ramTot * 100 : null, "ram", ramTot),
    nv ? meter("t", "Temp · Consumo", nv.temp.toFixed(0), "°C", nv.power_max ? `${nv.power.toFixed(0)}/${nv.power_max.toFixed(0)} W` : `${nv.power.toFixed(0)} W`, nv.power_max ? nv.power / nv.power_max * 100 : null) : meter("t", "Temp · Consumo", "—", "", "Solo modo local", null, null, null, true),
    d.nv && d.nv.cpu != null ? meter("c", "CPU", d.nv.cpu.toFixed(0), "%", "", d.nv.cpu, "cpu", 100) : meter("c", "CPU", "—", "", local ? "" : "Solo modo local", null, null, null, true),
    meter("q", "Cola ComfyUI", `${q.running}`, "en ejecución", q.pending ? `${q.pending} en espera` : "sin espera", null),
  ];
  const ver = [d.nv && d.nv.disk_total && `Disco ${gb(d.nv.disk_used).toFixed(0)}/${gb(d.nv.disk_total).toFixed(0)} GB`, sys.comfyui_version && "ComfyUI " + sys.comfyui_version, sys.pytorch_version && "PyTorch " + sys.pytorch_version, sys.python_version && "Python " + sys.python_version.split(" ")[0]].filter(Boolean).join(" · ");
  $("#loadCard").innerHTML = `<div class="load-head"><span class="dot s-ok"></span><b>${esc(name)}</b><span class="m">${local ? "Modo local · Cada 5 s" : "Modo pasarela · Cada 5 s"}</span></div><div class="meters">${cells.join("")}</div>${ver ? `<div class="load-foot">${esc(ver)}</div>` : ""}`;
  $("#loadSub").textContent = nv ? `${nv.util.toFixed(0)}% · VRAM ${vramUsed.toFixed(1)}/${vramTot.toFixed(0)} GB` : vramTot ? `VRAM ${vramUsed.toFixed(1)}/${vramTot.toFixed(0)} GB` : "GPU · VRAM · RAM";
}
setInterval(pollLoad, 5000);
$("#loadLive").onchange = () => pollLoad();
document.addEventListener("visibilitychange", () => pollLoad());

// ---------------- self-update ----------------
let updInfo = null;
async function checkUpdate(manual) {
  if (manual) $("#updMsg").textContent = "Buscando actualizaciones…";
  let r; try { r = await api("/api/update/check"); } catch (e) { if (manual) $("#updMsg").textContent = "Error al comprobar: " + e.message; return; }
  updInfo = r;
  if (r.error) { if (manual) $("#updMsg").textContent = "Error al comprobar: " + r.error; return; }
  if (r.available) {
    $("#btnUpd").hidden = false; $("#btnUpd").textContent = `↑ Nueva versión v${r.latest.version}`;
    if (manual) { $("#updMsg").innerHTML = `Nueva versión disponible: v${esc(r.latest.version)} <button type="button" class="btn primary xs" id="btnUpdNow">Actualizar ahora</button>`; $("#btnUpdNow").onclick = showUpdate; }
  } else { $("#btnUpd").hidden = true; if (manual) $("#updMsg").textContent = `Ya tienes la última versión (v${r.current})`; }
}
function showUpdate() {
  if (!updInfo || !updInfo.available) return;
  const L = updInfo.latest;
  openModal(`<h3>Nueva versión v${esc(L.version)}</h3><p class="hint" style="margin:0">Versión actual: v${esc(updInfo.current)}${L.size ? " · Tamaño: " + (L.size / 1e6).toFixed(1) + " MB" : ""}</p>
    <div class="upd-notes">${esc(L.notes || "(Sin notas de actualización)")}</div>
    <p class="hint">La actualización se descargará, verificará y reiniciará la aplicación de forma automática. Tus ajustes, plantillas y colas se mantendrán intactos. ${jobs.some(j => ["running", "submitted", "uploading", "downloading"].includes(j.status)) ? "<b>Hay tareas ejecutándose en la cola; se retomarán tras el reinicio.</b>" : ""}</p>
    <div class="bar" id="updBar" hidden><div></div></div><p class="muted small" id="updProg"></p>
    <div class="row end"><button class="btn" data-close>Más tarde</button><button class="btn primary" id="btnUpdGo">Actualizar ahora</button></div>`);
  $("#btnUpdGo").onclick = async () => {
    $("#btnUpdGo").disabled = true; $("#updBar").hidden = false;
    try { await api("/api/update/apply", { json: {} }); } catch (e) { $("#updProg").textContent = e.message; $("#btnUpdGo").disabled = false; return; }
    const t = setInterval(async () => {
      let s; try { s = await api("/api/update/status"); } catch { $("#updProg").textContent = "Reiniciando…"; clearInterval(t); return; }
      $("#updBar > div").style.width = Math.round((s.progress || 0) * 100) + "%";
      $("#updProg").textContent = s.message || "";
      if (s.state === "error") { clearInterval(t); $("#btnUpdGo").disabled = false; }
    }, 500);
  };
}
$("#btnUpd").onclick = showUpdate;
$("#btnUpdCheck").onclick = async () => { await $("#setForm").onsubmit({ preventDefault() { }, target: $("#setForm"), quiet: true }); checkUpdate(true); };
setTimeout(() => checkUpdate(false), 5000);
setInterval(() => checkUpdate(false), 6 * 3600 * 1000);

// ---------------- licensing & freemium ----------------
let currentLicense = { tier: "free", is_pro: false, key: "", email: "", expires_text: "Plan Free", features: [] };

async function loadLicense() {
  try { currentLicense = await api("/api/license"); }
  catch (e) { currentLicense = { tier: "free", is_pro: false, key: "", email: "", expires_text: "Plan Free", features: [] }; }
  renderLicenseUI();
}

function renderLicenseUI() {
  const isPro = currentLicense && currentLicense.is_pro;
  const tierName = isPro ? (currentLicense.tier === "studio" ? "Plan Studio" : "WakeGPU Pro") : "Plan Free";

  const sidePill = $("#sideTierPill");
  if (sidePill) {
    sidePill.className = "pill sm " + (isPro ? "pro" : "free");
    sidePill.textContent = tierName;
  }
  const sideUp = $("#btnSideUpgrade");
  if (sideUp) sideUp.hidden = isPro;

  const licPill = $("#licPill");
  if (licPill) {
    licPill.className = "pill sm " + (isPro ? "pro" : "free");
    licPill.textContent = isPro ? "Pro Activo" : "Plan Free";
  }
  const desc = $("#licTierDesc");
  if (desc) desc.textContent = tierName;

  const exp = $("#licExpiresText");
  if (exp) exp.textContent = currentLicense.expires_text || "";

  const ver = $("#licVerifyText");
  if (ver) ver.textContent = (isPro && currentLicense.verified_text) ? currentLicense.verified_text : "";

  const em = $("#licEmailText");
  if (em) em.textContent = currentLicense.email ? `Titular: ${currentLicense.email} · Clave: ${currentLicense.key}` : "";

  const btnDeact = $("#btnLicDeactivate");
  if (btnDeact) btnDeact.hidden = !isPro;

  const btnModal = $("#btnLicModal");
  if (btnModal) btnModal.textContent = isPro ? "Cambiar clave" : "Activar clave";

  const btnSub = $("#btnSubscribePro");
  if (btnSub) btnSub.hidden = isPro;

  const cta = $("#licCtaBanner");
  if (cta) cta.hidden = isPro;

  const zwPill = $("#zwStatusPill");
  if (zwPill) {
    zwPill.className = "pill sm " + (isPro ? "zw" : "free");
    zwPill.textContent = isPro ? "Pro Activo" : "Requiere Pro";
  }
}

function openLicenseModal(reason) {
  const isPro = currentLicense && currentLicense.is_pro;
  const pricingUrl = (currentLicense && currentLicense.pricing_url) || "https://wakegpu.com/pro";
  const recoverUrl = (currentLicense && currentLicense.recover_url) || "https://wakegpu.com/recover";
  const manageUrl = (currentLicense && currentLicense.manage_url) || "https://wakegpu.com/manage";

  const reasonBanner = reason ? `
    <div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
      <span style="font-size:18px">⚡</span>
      <span style="font-size:12.5px;color:var(--text)">${esc(reason)}</span>
    </div>` : "";

  openModal(`<h3>${isPro ? i18n.t("sec_license_modal_title_pro") : i18n.t("sec_license_modal_title_free")}</h3>
    ${reasonBanner}

    <div class="pro-cta-banner" style="margin-top:0;margin-bottom:14px">
      <div>
        <h4 style="margin:0 0 4px;font-size:14px;color:#f59e0b">${i18n.t("sec_license_modal_cta_title")}</h4>
        <p style="margin:0;font-size:12px;color:var(--muted)">${i18n.t("sec_license_modal_cta_sub")}</p>
      </div>
      <button type="button" class="btn primary sm" id="btnModalBuyNow">Suscribirse ahora ↗</button>
    </div>

    <table class="plan-comp-table" style="margin-bottom:16px">
      <thead>
        <tr>
          <th>Capacidad</th>
          <th>Plan Free</th>
          <th>Plan Pro</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><b>Consumo Colab (Zero-Waste)</b></td>
          <td>30 min inactivo obligado</td>
          <td>⚡ Apagado automático al terminar cola</td>
        </tr>
        <tr>
          <td><b>Coding Agent (VS Code / Cline)</b></td>
          <td>No disponible</td>
          <td>⚡ Conexión ilimitada por proxy OpenAI sin rate limits</td>
        </tr>
        <tr>
          <td><b>Control Móvil (PWA + QR)</b></td>
          <td>Solo escritorio</td>
          <td>⚡ App móvil remota en red local y túnel 4G</td>
        </tr>
        <tr>
          <td><b>Lotes y Variaciones</b></td>
          <td>1 tarea individual</td>
          <td>⚡ Hasta 50 copias con semillas variables</td>
        </tr>
        <tr>
          <td><b>Auto-HD Encadenado</b></td>
          <td>Manual desde la cola</td>
          <td>⚡ Borrador ➔ HD automático</td>
        </tr>
        <tr>
          <td><b>Notificaciones Push</b></td>
          <td>No disponible</td>
          <td>⚡ Discord Webhooks y Telegram Bot</td>
        </tr>
        <tr>
          <td><b>Sincronización en Nube</b></td>
          <td>Solo almacenamiento local</td>
          <td>⚡ Cloud Sync y Copia en 1 clic</td>
        </tr>
      </tbody>
    </table>

    <details style="margin:12px 0;border-top:1px dashed var(--line2);padding-top:10px" id="licKeyDetails" ${isPro ? "open" : ""}>
      <summary style="cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:600">${i18n.t("sec_license_activate_key")}</summary>
      <div class="form-grid" style="margin-top:10px">
        <label class="fld full" data-i18n="sec_license_key_placeholder">Clave de licencia (WLPRO-…)<input id="licKeyInput" class="mono" placeholder="WLPRO-XXXXX-… o WLPRO-DEMO-2026" value="${isPro ? esc(currentLicense.key || "") : ""}"></label>
        <label class="fld full" data-i18n="sec_license_email_placeholder">Correo electrónico asociado (opcional)<input id="licEmailInput" placeholder="tu@correo.com" value="${esc(currentLicense.email || "")}"></label>
      </div>
      <div class="row between wrap gap" style="margin-top:8px">
        <button type="button" class="btn xs ghost" id="btnFillDemo">Usar clave demo (WLPRO-DEMO-2026)</button>
        <button type="button" class="btn primary sm" id="btnLicSubmit">${isPro ? i18n.t("sec_license_btn_update") : i18n.t("sec_license_btn_activate")}</button>
      </div>
    </details>

    <div class="row wrap gap" style="margin-top:2px">
      <button type="button" class="btn xs ghost" id="btnLicRecover">${i18n.t("lic_recover_key")}</button>
      ${isPro ? `<button type="button" class="btn xs ghost" id="btnLicManage">${i18n.t("lic_manage_sub")}</button>` : ""}
      ${isPro && currentLicense.verified_text ? `<span class="muted small">${esc(currentLicense.verified_text)}</span>` : ""}
    </div>

    <p class="err" id="licErr"></p>
    <div class="row end" style="margin-top:14px">
      <button type="button" class="btn" data-close data-i18n="dlg_btn_close">Cerrar</button>
    </div>`);

  $("#btnModalBuyNow").onclick = () => {
    api("/api/open-url", { json: { url: pricingUrl } });
  };

  $("#btnLicRecover").onclick = () => {
    api("/api/open-url", { json: { url: recoverUrl } });
  };

  const btnManage = $("#btnLicManage");
  if (btnManage) btnManage.onclick = () => {
    api("/api/open-url", { json: { url: manageUrl } });
  };

  const btnDemo = $("#btnFillDemo");
  if (btnDemo) {
    btnDemo.onclick = () => {
      $("#licKeyInput").value = "WLPRO-DEMO-2026";
      $("#licEmailInput").value = "demo@wakegpu.app";
      $("#licKeyDetails").open = true;
    };
  }

  $("#btnLicSubmit").onclick = async () => {
    const key = $("#licKeyInput").value.trim();
    const email = $("#licEmailInput").value.trim();
    if (!key) { $("#licErr").textContent = i18n.t("sec_license_err_invalid_key"); return; }
    $("#btnLicSubmit").disabled = true;
    $("#licErr").textContent = i18n.t("sec_license_err_validating");
    try {
      const res = await api("/api/license/activate", { json: { key, email } });
      closeModal();
      toast(i18n.t("sec_license_toast_activated", { msg: res.message || "" }));
      await loadLicense();
      await loadSettings();
    } catch (err) {
      $("#licErr").textContent = err.message || i18n.t("sec_license_err_deactivate", { err: "" });
      $("#btnLicSubmit").disabled = false;
    }
  };
}

async function deactivateLicense() {
  if (!await appConfirm(i18n.t("sec_license_confirm_deactivate"))) return;
  try {
    const res = await api("/api/license/deactivate", { json: {} });
    toast(i18n.t("sec_license_toast_deactivated"));
    await loadLicense();
    await loadSettings();
  } catch (err) {
    toast(i18n.t("sec_license_err_deactivate", { err: err.message }));
  }
}

// ---------------- settings ----------------
async function loadSettings() {
  const r = await api("/api/config");
  const f = $("#setForm");
  for (const [k, v] of Object.entries(r.config)) { const el = f.elements[k]; if (!el) continue; if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? ""; }
  $("#dataDirText").textContent = i18n.t("settings_data_dir", { dir: r.data_dir });
  appCfg = r.config; renderMode();
  $("#verText").textContent = "v" + r.version; $("#updCur").textContent = i18n.t("sec_update_title", { v: r.version }); $("#updUrl").placeholder = r.default_update_url;
  llms = r.config.llms || []; defaultLLM = r.config.default_llm || ""; renderLLMs();
  const ds = f.elements.draft_scale; if (![...ds.options].some(o => +o.value === +r.config.draft_scale)) ds.add(new Option(Math.round(r.config.draft_scale * 100) + "%", r.config.draft_scale)); ds.value = String(r.config.draft_scale);
  draftHint();

  return r.config;
}
$("#setForm").onsubmit = async e => {
  e.preventDefault();
  const f = e.target, c = {};
  for (const el of f.elements) {
    if (!el.name || el.name === "llmdef") continue;
    c[el.name] = el.type === "checkbox" ? el.checked : el.name === "draft_scale" ? parseFloat(el.value) || 0.5 : el.name === "local_max_hours" ? parseFloat(el.value) || 0 : (el.name === "zero_waste_max_cu" || el.name === "zero_waste_min_bal") ? parseFloat(el.value) || 0 : el.type === "number" ? parseInt(el.value) || 0 : el.value.trim();
  }
  c.llms = llms; c.default_llm = defaultLLM; c.mode = appCfg.mode || "gateway"; c.local_profile = appCfg.local_profile || "";
  try {
    await api("/api/config", { json: c }); appCfg = { ...appCfg, ...c }; const rr = await api("/api/config"); llms = rr.config.llms || []; renderLLMs(); draftHint();
    if (!e.quiet) { $("#setMsg").textContent = i18n.t("settings_saved"); clearTimeout($("#setMsg")._t); $("#setMsg")._t = setTimeout(() => $("#setMsg").textContent = "", 2500); }
    pollStatus(); loadProfiles(); connectEvents();
  }
  catch (err) { $("#setMsg").textContent = i18n.t("settings_err_save", { err: err.message }); }
};
$("#btnShowTok").onclick = () => { const i = $("#setForm").elements.token; i.type = i.type === "password" ? "text" : "password"; };
const bLicM = $("#btnLicModal"); if (bLicM) bLicM.onclick = () => openLicenseModal();
const bLicD = $("#btnLicDeactivate"); if (bLicD) bLicD.onclick = deactivateLicense;
const bSideUp = $("#btnSideUpgrade"); if (bSideUp) bSideUp.onclick = () => openLicenseModal();
const bSubPro = $("#btnSubscribePro"); if (bSubPro) bSubPro.onclick = () => openLicenseModal();
const bBanUp = $("#btnBannerUpgrade"); if (bBanUp) bBanUp.onclick = () => openLicenseModal();
$("#btnTest").onclick = async () => {
  const m = $("#setMsg"); clearTimeout(m._t);
  await $("#setForm").onsubmit({ preventDefault() { }, target: $("#setForm"), quiet: true });
  m.textContent = i18n.t("settings_testing"); $("#btnTest").disabled = true;
  try { const st = await api("/api/gate/test", { json: {} }); m.textContent = i18n.t("settings_test_ok", { state: STATE_CN[st.state] || st.state, user: st.you ? " · " + i18n.t("tile_session_user", { email: st.you.email || "agente" }) : "" }); }
  catch (err) { m.textContent = i18n.t("settings_test_err", { err: err.message }); }
  finally { $("#btnTest").disabled = false; }
};
$("#btnPair").onclick = async () => {
  await $("#setForm").onsubmit({ preventDefault() { }, target: $("#setForm") });
  try {
    const r = await api("/api/pair/start", { json: {} });
    $("#pairMsg").textContent = i18n.t("settings_pair_opened", { code: r.code });
    const t = setInterval(async () => {
      const s = await api("/api/pair/state");
      $("#pairMsg").textContent = i18n.t("settings_pair_msg", { msg: s.message }) + (s.state === "pending" ? i18n.t("settings_pair_pending", { code: s.code }) : "");
      if (s.state !== "pending") { clearInterval(t); if (s.state === "ok") { loadSettings(); pollStatus(); loadProfiles(); } }
    }, 2000);
  } catch (e) { $("#pairMsg").textContent = i18n.t("settings_pair_err", { err: e.message }); }
};

// ---------------- remote notifications & cloud sync ----------------
const bNotify = $("#btnNotifyTest");
if (bNotify) {
  bNotify.onclick = async () => {
    const msg = $("#notifyTestMsg");
    msg.textContent = "Enviando notificación de prueba...";
    try {
      const res = await api("/api/notify/test", { json: {} });
      msg.textContent = "✓ " + (res.message || "Enviada");
    } catch (err) {
      msg.textContent = "✗ " + err.message;
    }
  };
}

const bSyncExp = $("#btnSyncExport");
if (bSyncExp) {
  bSyncExp.onclick = async () => {
    window.location.href = "/api/sync/export";
  };
}

const fSyncImp = $("#syncImportFile");
if (fSyncImp) {
  fSyncImp.onchange = async () => {
    if (!fSyncImp.files || !fSyncImp.files[0]) return;
    const file = fSyncImp.files[0];
    const fd = new FormData();
    fd.append("bundle", file);
    const msg = $("#syncMsg");
    msg.textContent = "Restaurando copia de seguridad...";
    try {
      const res = await api("/api/sync/import", { method: "POST", body: fd });
      msg.textContent = "✓ " + res.message;
      toast(res.message);
      await loadTemplates();
    } catch (err) {
      msg.textContent = "✗ Error: " + err.message;
    } finally {
      fSyncImp.value = "";
    }
  };
}

// empty-state buttons (生成 / 队列 / 结果)
function emptyAction(a) {
  if (a === "ai" || a === "gen" || a === "console") return show(a);
  if (a === "import") return $("#tplFile").click();
  if (a === "how") return openModal(`<h3>Cómo exportar flujos de trabajo de ComfyUI (API)</h3><ol class="ob-howto">
    <li>Despierta la GPU y pulsa «Abrir ComfyUI» en la Consola.</li><li>Abre o diseña tu flujo en ComfyUI y ejecútalo con éxito al menos una vez.</li>
    <li>Menú → Workflow (Flujo) → <b>Export (API)</b> / Exportar (API) para guardar un archivo .json.</li>
    <li>Vuelve aquí y pulsa «Importar flujo ComfyUI API» seleccionando ese archivo. WakeGPU reconocerá automáticamente los prompts, imágenes, semillas y demás parámetros.</li></ol>
    <div class="row end"><button class="btn" data-close>Entendido</button></div>`);
}

// ---------------- CU & Time Usage Panel ----------------
let usageData = null;
async function loadUsage() {
  try {
    usageData = await api("/api/usage");
    renderUsage();
  } catch (e) { }
}
function fmtEUR(v) {
  const n = Number(v || 0);
  return i18n.getLang() === "en" ? `€${n.toFixed(2)}` : `${n.toFixed(2).replace(".", ",")} €`;
}
function renderUsage() {
  const el = $("#usageCard");
  if (!el) return;
  const u = usageData || { today: {}, week: {}, month: {}, recent_sessions: [] };
  const act = u.active;
  const box = (title, dur, cu, eur, isLive, subExtra) => `
    <div class="usage-box ${isLive ? "live" : ""}">
      <div class="uk">${esc(title)}</div>
      <div class="uv">${Number(cu || 0).toFixed(2)} <small style="font-size:11px;font-weight:400">CU</small> · ${esc(fmtEUR(eur))}</div>
      <div class="ux">${esc(dur != null ? fmtDur(dur) : i18n.t("usage_inactive"))}${subExtra ? " · " + esc(subExtra) : ""}</div>
    </div>`;

  let html = `<div class="usage-grid">
    ${act ? box(i18n.t("usage_cur_session"), act.duration_s, act.burned_cu, act.cost_eur, true, act.accelerator || "GPU")
          : box(i18n.t("usage_cur_session"), null, 0, 0, false, "")}
    ${box(i18n.t("usage_today"), u.today.duration_s || 0, u.today.burned_cu, u.today.cost_eur, false, (u.today.sessions || 0) + " ses.")}
    ${box(i18n.t("usage_week"), u.week.duration_s || 0, u.week.burned_cu, u.week.cost_eur, false, (u.week.sessions || 0) + " ses.")}
    ${box(i18n.t("usage_month"), u.month.duration_s || 0, u.month.burned_cu, u.month.cost_eur, false, (u.month.sessions || 0) + " ses.")}
  </div>`;

  if (u.total_saved_cu > 0) {
    html += `<div class="usage-saved">
      <span>${esc(i18n.t("usage_saved_banner"))}</span>
      <b>${u.total_saved_cu.toFixed(2)} CU (≈ ${esc(fmtEUR(u.total_saved_eur))})</b>
    </div>`;
  }

  const recs = u.recent_sessions || [];
  if (recs.length > 0) {
    html += `<details class="usage-details">
      <summary>${esc(i18n.t("usage_recent_sessions"))} (${recs.length})</summary>
      <table class="usage-tbl">
        <thead><tr>
          <th>${esc(i18n.t("usage_col_date"))}</th>
          <th>${esc(i18n.t("usage_col_gpu"))}</th>
          <th>${esc(i18n.t("usage_col_time"))}</th>
          <th>${esc(i18n.t("usage_col_cu"))}</th>
          <th>${esc(i18n.t("usage_col_cost"))}</th>
        </tr></thead>
        <tbody>
          ${recs.map(r => `<tr>
            <td>${esc(fmtTime(r.ended_at || r.started_at))}</td>
            <td><b>${esc(r.accelerator || "GPU")}</b> · <span class="muted">${esc(profileTitle(r.profile || "—"))}</span></td>
            <td>${esc(fmtDur(r.duration_s))}</td>
            <td>${Number(r.burned_cu || 0).toFixed(2)} CU</td>
            <td>${esc(fmtEUR(r.cost_eur))}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </details>`;
  } else {
    html += `<div class="muted small">${esc(i18n.t("usage_empty"))}</div>`;
  }
  el.innerHTML = html;
}
// ---------------- Mobile PWA Pairing Modal ----------------
async function openMobileModal() {
  if (!currentLicense || !currentLicense.is_pro) {
    return openLicenseModal("El Control Móvil (PWA + emparejamiento por QR) es una función exclusiva de WakeGPU Pro. Te permite supervisar y controlar el render desde tu iPhone o Android.");
  }
  let st = null;
  try {
    st = await api("/api/mobile/status");
  } catch (e) {
    return toast("Error al consultar estado móvil: " + e.message);
  }

  const renderModal = (s) => {
    const isEn = i18n.getLang() === "en";
    let body = `
      <h3>${isEn ? "📱 Mobile Studio Remote (iOS / Android)" : "📱 Control Móvil de WakeGPU (iOS / Android)"}</h3>
      <p class="muted" style="font-size:13px;line-height:1.5">
        ${isEn
          ? "Scan this QR code with your iPhone or Android camera to open WakeGPU directly on your mobile device as an installable Web App (PWA)."
          : "Escanea este código QR con la cámara de tu iPhone o Android para abrir WakeGPU en tu móvil como una aplicación Web (PWA). Podrás lanzar prompts, subir fotos y descargar vídeos desde el sofá mientras tu ordenador gestiona la GPU de forma segura."}
      </p>
    `;

    if (!s.enabled) {
      body += `
        <div style="text-align:center;padding:20px 0">
          <p style="font-size:14px;margin-bottom:14px">${isEn ? "Mobile remote server is currently stopped." : "El acceso móvil está actualmente desactivado."}</p>
          <button class="btn primary" id="btnStartMobile">${isEn ? "⚡ Start Mobile Access (Wi-Fi QR)" : "⚡ Activar Acceso Móvil (Código QR)"}</button>
        </div>
      `;
    } else {
      body += `
        <div class="mob-qr-wrap">
          <div class="mob-qr-svg">${s.qr_svg || ""}</div>
          <div class="mob-url-box">
            <span class="mob-url-code">${esc(s.primary_url)}</span>
            <button class="btn xs" id="btnCopyMobUrl">${isEn ? "Copy" : "Copiar"}</button>
          </div>
          <div style="font-size:11px;color:var(--muted)">
            ${s.tunnel_running
              ? (isEn ? "✓ Cloudflare Tunnel active (connect from anywhere, 4G/5G)" : "✓ Túnel Cloudflare activo (conecta desde cualquier red 4G/5G)")
              : (isEn ? "📶 Wi-Fi Local Mode (mobile must be on the same Wi-Fi)" : "📶 Modo Wi-Fi Local (el móvil debe estar en la misma red Wi-Fi)")}
          </div>
        </div>
        <div class="row between wrap gap" style="margin-top:12px">
          <button class="btn xs ghost" id="btnRotateMobToken">${isEn ? "🔄 Rotate Token" : "🔄 Cambiar clave de acceso"}</button>
          <button class="btn xs danger" id="btnStopMobile">${isEn ? "Turn off mobile access" : "Desactivar acceso móvil"}</button>
        </div>
        ${s.tunnel_error ? `<p class="err small" style="margin-top:8px">${esc(s.tunnel_error)}</p>` : ""}
      `;
    }

    body += `<div class="row end" style="margin-top:16px"><button class="btn" data-close>${isEn ? "Done" : "Cerrar"}</button></div>`;
    openModal(body);

    const bStart = $("#btnStartMobile");
    if (bStart) {
      bStart.onclick = async () => {
        bStart.disabled = true;
        bStart.textContent = isEn ? "Starting..." : "Iniciando...";
        try {
          const res = await api("/api/mobile/start", { json: { tunnel: false } });
          renderModal(res);
        } catch (e) {
          toast("Error: " + e.message);
        }
      };
    }
    const bCopy = $("#btnCopyMobUrl");
    if (bCopy) {
      bCopy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(s.primary_url);
          bCopy.textContent = "✓";
          setTimeout(() => { bCopy.textContent = isEn ? "Copy" : "Copiar"; }, 2000);
        } catch (_) {}
      };
    }
    const bRotate = $("#btnRotateMobToken");
    if (bRotate) {
      bRotate.onclick = async () => {
        if (!confirm(isEn ? "Disconnect current mobile sessions and generate a new QR?" : "¿Desconectar sesiones móviles actuales y generar un nuevo código QR?")) return;
        const res = await api("/api/mobile/rotate", { method: "POST" });
        renderModal(res);
      };
    }
    const bStop = $("#btnStopMobile");
    if (bStop) {
      bStop.onclick = async () => {
        const res = await api("/api/mobile/stop", { method: "POST" });
        renderModal(res);
      };
    }
  };

  renderModal(st);
}

const btnMobileTop = $("#btnMobileTop");
if (btnMobileTop) {
  btnMobileTop.onclick = openMobileModal;
}

// ---------------- boot ----------------
(async () => {
  const c = await loadSettings();
  await loadLicense();
  await loadTemplates();
  if (!c.gate_url && c.onboarded && (c.mode || "gateway") === "gateway") { show("settings"); toast("Configura primero la dirección y el token de la pasarela"); }
  await pollStatus();
  loadProfiles();
  connectEvents();
  loadJobs();
  loadUsage();
  setInterval(pollStatus, 4000);
  setInterval(loadJobs, 2000);
  setInterval(loadUsage, 8000);
  setInterval(() => { if (page === "results") { /* manual refresh to keep players stable */ } }, 10000);
})();

// ---------------- language toggle ----------------
$$("[data-lang-set]").forEach(b => b.onclick = () => { i18n.setLang(b.dataset.langSet); });

// Highlight active language button
function updateLangButtons() {
  $$("[data-lang-set]").forEach(b => b.classList.toggle("on", b.dataset.langSet === i18n.getLang()));
}
const _setLang = i18n.setLang;
i18n.setLang = function(lang) {
  _setLang(lang);
  updateLangButtons();
  // Re-render the dynamic views that render through i18n.t so the whole UI follows
  // the language. Only safe (input-preserving) renders are hooked; the generation
  // form (renderForm) is deliberately NOT re-rendered to keep unsaved user edits.
  try {
    // force re-render of the profile workspace (its signature ignores the language)
    if (typeof profileWorkspaceKey !== "undefined") profileWorkspaceKey = "";
    const safe = ["renderStatus", "renderMode", "renderModeSeg", "renderLLMs", "renderLicenseUI",
      "loadLocal", "loadGuide", "udRender", "obRenderChecklist", "obMiniRender", "obWakeCost",
      "loadJobs", "loadFiles", "aiRender", "renderProfileWorkspace", "renderUsage"];
    for (const name of safe) {
      try { if (typeof window[name] === "function") window[name](); } catch (e) { }
    }
    try { if (typeof renderLog === "function") renderLog(true); } catch (e) { }
    try { if (typeof renderLib === "function" && typeof lib !== "undefined" && lib) renderLib(); } catch (e) { }
    try { if (!curTpl) $("#formTitle").textContent = i18n.t("gen_parameters"); } catch (e) { }
    // translate the data-i18n nodes inside freshly re-rendered markup
    i18n.updateDOM();
  } catch (e) { }
};
updateLangButtons();

// fmtTime uses current locale
function fmtTime(t) {
  if (!t) return "";
  const d = new Date(t * 1000);
  const locale = i18n.getLang() === "en" ? "en-US" : "es-ES";
  return d.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// updCount word label
function updCount0(t) { const c = $(`[data-count="${t.id}"]`); if (c) c.textContent = t.value.trim() ? t.value.trim().split(/\s+/).length + " " + i18n.t("unit_words") : ""; }

// ---------------- Visual Prompt Compiler (0 € / Sin LLM) & Estudio 1-Clic ----------------
function compileVisualPrompt({ idea, style, cam, dur, goal }) {
  const cleanIdea = (idea || "").trim() || "A cinematic traveler standing in an atmospheric landscape";
  const D = Number(dur || 6).toFixed(1);
  const half = (Number(dur || 6) / 2).toFixed(1);
  const aspect = goal === "short" ? "9:16 vertical short-form" : "16:9 cinematic widescreen";
  const camMap = {
    dolly_in: "slow smooth dolly forward toward the subject, shallow depth of field",
    dolly_out: "slow dramatic dolly backward revealing the surrounding environment",
    orbit: "smooth 180-degree orbital tracking shot circling around the subject",
    crane: "gradual crane / drone pedestal rise revealing monumental scale",
    tripod: "clinical tripod-locked stability with subtle atmospheric focus pull",
    handheld: "dynamic subtle handheld camera motion adding raw realism and immediacy",
  };
  const styleMap = {
    muse6: {
      env: "Natural filmic lighting, soft volumetric rim light, rich cinematic color grading",
      lens: "35mm anamorphic prime lens, cinematic bokeh and subtle film grain",
      rest: "No face morphing, no limb distortion, realistic fluid and cloth physics, no text overlay",
    },
    apple: {
      env: "Ultra-clean minimalist studio backdrop, crisp softbox highlights, specular reflections",
      lens: "90mm macro lens, razor-sharp f/4, high-speed 120fps slow-motion feel",
      rest: "Perfectly smooth geometric lines, zero jitter, pristine industrial design look",
    },
    bladerunner: {
      env: "Rain-slicked futuristic atmosphere, dense neon cyan and amber haze, wet reflections",
      lens: "24mm anamorphic wide angle, monumental scale, heavy atmospheric mist",
      rest: "Realistic rain physics, no oversaturated colors, somber contemplative pacing",
    },
    fincher: {
      env: "Low-key dimly lit interior, muted olive-green and deep shadow color grade, tungsten practical light",
      lens: "50mm Zeiss prime lens, low contrast, rich filmic blacks",
      rest: "No shaky cam, razor sharp focus plane, restrained minimal movement",
    },
    anime: {
      env: "Sunlit vibrant sky with towering volumetric cumulus clouds, golden hour light blooms",
      lens: "35mm anime perspective, dynamic low-angle shot, subtle chromatic aberration",
      rest: "Authentic 2D anime linework, no 3D uncanny valley, smooth natural hair and cloth motion",
    },
    macro: {
      env: "Velvet dark studio void with dancing caustic light refractions and floating micro-particles",
      lens: "100mm macro probe lens, extreme shallow depth of field, 1000fps slow-motion feel",
      rest: "Physically accurate optical refraction, zero clipping, pure luxury aesthetics",
    },
  };
  const s = styleMap[style] || styleMap.muse6;
  const camDesc = camMap[cam] || camMap.dolly_in;
  const imgRef = goal === "i2v" ? "Starting seamlessly from <Picture 1>, maintaining exact character likeness and composition. " : "";

  return `[DURACIÓN Y FORMATO]: ${D}s, ${aspect}, 24fps.
[PERSONAJE / ASSET ID]: ${imgRef}${cleanIdea}.
[ESCENARIO Y ATMÓSFERA]: ${s.env}.
[TIMED BEATS]:
- 0.0s - ${half}s: Opening framing establishes the subject and mood; initial subtle motion unfolds naturally.
- ${half}s - ${D}s: Action progresses smoothly to visual climax as lighting and atmosphere accentuate the scene.
[LENGUAJE DE CÁMARA]: ${s.lens}; ${camDesc}.
[RESTRICCIONES]: ${s.rest}.`;
}

// Modal del Asistente Visual (0 €) en la pestaña Generar
if ($("#btnVisualCompiler")) {
  $("#btnVisualCompiler").onclick = () => {
    const t = mainTextarea();
    openModal(`<h3>🎨 Asistente Visual de Prompts (0 € · Sin LLM)</h3>
    <p class="muted small">Describe tu idea en lenguaje normal y compilaremos automáticamente un prompt cinematográfico en 6 bloques:</p>
    <label class="lbl" style="display:block;margin:10px 0 4px">¿Qué quieres ver?</label>
    <textarea id="vcIdea" class="studio-textarea" placeholder="Ej: Un coche deportivo atravesando Tokio de noche bajo la lluvia"></textarea>
    <div class="studio-fields">
      <div><label class="lbl" style="display:block;margin-bottom:4px">Estilo</label>
        <select id="vcStyle" class="studio-select">
          <option value="muse6">🎬 Cine Realista 35mm</option>
          <option value="apple">🍎 Comercial Apple (120fps)</option>
          <option value="bladerunner">🌧️ Blade Runner Sci-Fi</option>
          <option value="fincher">🕵️ Thriller Noir (Fincher)</option>
          <option value="anime">🌸 Anime (Makoto Shinkai)</option>
          <option value="macro">💎 Macro Lujo (120fps)</option>
        </select>
      </div>
      <div><label class="lbl" style="display:block;margin-bottom:4px">Movimiento de cámara</label>
        <select id="vcCam" class="studio-select">
          <option value="dolly_in">Acercamiento lento (Dolly In)</option>
          <option value="dolly_out">Alejamiento (Dolly Out)</option>
          <option value="orbit">Orbital 360°</option>
          <option value="crane">Grúa / Drone elevándose</option>
          <option value="tripod">Cámara fija en trípode</option>
          <option value="handheld">Cámara en mano</option>
        </select>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px;gap:8px">
      <button type="button" class="btn ghost" data-close>Cancelar</button>
      <button type="button" class="btn primary" id="vcApply">Compilar y Aplicar Prompt</button>
    </div>`);
    $("#vcIdea").focus();
    $("#vcApply").onclick = () => {
      if (!t) return toast("Esta plantilla no tiene parámetros de texto");
      const compiled = compileVisualPrompt({
        idea: $("#vcIdea").value,
        style: $("#vcStyle").value,
        cam: $("#vcCam").value,
        dur: +$("#h3Dur").value || 6,
        goal: $("#h3Mode").value === "I2VA" ? "i2v" : "t2v",
      });
      t.value = compiled;
      updCount(t);
      closeModal();
      toast("Prompt cinematográfico de 6 bloques compilado (0 €)");
    };
  };
}

// Controlador de Estudio 1-Clic (#page-studio)
(function initStudio1Click() {
  if (!$("#page-studio")) return;
  const st = { goal: "t2v", style: "muse6", activeJobId: null };

  function updatePreview() {
    const out = $("#studioCompiledOut");
    if (!out) return;
    out.textContent = compileVisualPrompt({
      idea: $("#studioIdea").value,
      style: st.style,
      cam: $("#studioCam").value,
      dur: $("#studioDur").value,
      goal: st.goal,
    });
  }

  $$("#studioGoals .goal-card").forEach(b => b.onclick = () => {
    st.goal = b.dataset.goal;
    $$("#studioGoals .goal-card").forEach(x => x.classList.toggle("on", x === b));
    $("#studioImgBox").hidden = (st.goal !== "i2v");
    updatePreview();
  });

  $$("#studioStyles .style-chip").forEach(b => b.onclick = () => {
    st.style = b.dataset.st;
    $$("#studioStyles .style-chip").forEach(x => x.classList.toggle("on", x === b));
    updatePreview();
  });

  ["#studioIdea", "#studioCam", "#studioDur"].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener("input", updatePreview);
  });
  updatePreview();

  function renderStudioAuth() {
    const chip = $("#studioAuthChip"), btn = $("#btnStudioConnect");
    if (!chip || !btn) return;
    const logged = gst && (gst.logged_in || (gst.cu && Number.isFinite(gst.cu.balance)));
    if (logged) {
      const bal = gst.cu && Number.isFinite(gst.cu.balance) ? ` · ~${Math.max(1, Math.floor(gst.cu.balance * 2.5))} vídeos disp.` : "";
      chip.textContent = "✅ Google Conectado" + bal;
      chip.className = "chip ok";
      btn.textContent = "Cuenta lista ✓";
      btn.classList.remove("primary");
    } else {
      chip.textContent = "⚪ Sin conectar a Google";
      chip.className = "chip";
      btn.textContent = "🔗 Conectar cuenta Google";
      btn.classList.add("primary");
    }
  }
  setInterval(renderStudioAuth, 2500);
  renderStudioAuth();

  $("#btnStudioConnect").onclick = async () => {
    try {
      if (typeof obSetMode === "function") await obSetMode("local");
      if ($("#btnLocalLogin")) {
        show("console");
        $("#btnLocalLogin").click();
      } else {
        obOpen("simple", 1);
      }
    } catch (e) { toast(e.message || "Error abriendo login"); }
  };

  $("#btnStudioSeeResults").onclick = () => show("results");
  $("#btnStudioNew").onclick = () => {
    st.activeJobId = null;
    $("#studioStatus").hidden = true;
    $("#studioResultActions").hidden = true;
    $("#btnStudioGo").disabled = false;
  };

  $("#btnStudioGo").onclick = async () => {
    const errEl = $("#studioErr"); errEl.textContent = "";
    const idea = $("#studioIdea").value.trim();
    if (!idea) { errEl.textContent = "Escribe primero qué quieres ver en tu vídeo."; $("#studioIdea").focus(); return; }
    if (st.goal === "i2v" && (!$("#studioImgFile").files || !$("#studioImgFile").files[0])) {
      errEl.textContent = "Has elegido «Dar vida a una Foto». Por favor sube una imagen inicial."; return;
    }

    // 1. Asegurar modo local si no hay gateway configurado
    if (!isLocal() && (!appCfg || !appCfg.gateway_url)) {
      try { if (typeof obSetMode === "function") await obSetMode("local"); } catch { }
    }

    // 2. Verificar conexión a Google
    const logged = gst && (gst.logged_in || (gst.cu && Number.isFinite(gst.cu.balance)));
    if (!logged) {
      errEl.textContent = "Primero conecta tu cuenta de Google pulsando el botón superior «Conectar cuenta Google».";
      return;
    }

    // 3. Activar Guardián Zero-Waste si el usuario lo dejó marcado
    if ($("#studioZeroWaste").checked) {
      try {
        const c = await api("/api/config");
        if (c && c.config && !c.config.zero_waste_enabled) {
          c.config.zero_waste_enabled = true;
          await api("/api/config", { json: c.config });
        }
      } catch { }
    }

    const compiledPrompt = compileVisualPrompt({
      idea, style: st.style, cam: $("#studioCam").value, dur: $("#studioDur").value, goal: st.goal
    });

    $("#btnStudioGo").disabled = true;
    $("#studioStatus").hidden = false;
    $("#studioResultActions").hidden = true;
    $("#studioStatusTitle").textContent = "Iniciando estudio de vídeo…";
    $("#studioStatusChip").textContent = "Preparando";
    $("#studioProgFill").style.width = "15%";
    $("#studioStatusSub").textContent = "Comprobando GPU en Google Colab…";

    try {
      const hasBal = gst && gst.cu && gst.cu.balance > 0;
      const defaultWanProf = (profiles && profiles.profiles && profiles.profiles.find(p => p.id === "wan21-t4-free"))
        || (profiles && profiles.profiles && profiles.profiles.find(p => /wan|h3|video|hunyuan/i.test(p.id)))
        || (profiles && profiles.profiles && profiles.profiles[0]);
      const targetProf = hasBal
        ? ((profiles && profiles.profiles && profiles.profiles.find(p => /h3|wan|video/i.test(p.id))) || defaultWanProf)
        : defaultWanProf;
      const targetAcc = hasBal ? ((targetProf && targetProf.accelerator) || "L4") : "T4";

      // 4. Despertar GPU automáticamente si no está corriendo
      if (!gst || gst.state !== "running") {
        $("#studioStatusTitle").textContent = "Despertando GPU en Google Colab (" + targetAcc + ")…";
        $("#studioStatusSub").textContent = "Esto suele tardar 1-2 minutos la primera vez. WakeGPU está preparando el modelo de vídeo gratuito Wan 2.1.";
        $("#studioProgFill").style.width = "35%";
        if (targetProf && $("#wakeProfile")) $("#wakeProfile").value = targetProf.id;
        if ($("#wakeAcc")) $("#wakeAcc").value = targetAcc;
        await api("/api/wake", { json: { profile: targetProf ? targetProf.id : "wan21-t4-free", accelerator: targetAcc } });

        // Esperar hasta que esté running (máximo ~5 min)
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 3000));
          await pollStatus();
          if (gst && gst.state === "running") break;
          if (gst && (gst.state === "failed" || gst.state === "stopped")) throw new Error("No se pudo iniciar la GPU en Colab. Revisa el registro en Consola.");
        }
      }

      // 5. Buscar o auto-crear la plantilla de vídeo Wan 2.1 1.3B
      await loadTemplates();
      let tpl = curTpl || (templates && templates.find(t => /wan|video|h3|hunyuan/i.test(t.name))) || (templates && templates[0]);
      if (!tpl) {
        const wanGraph = {
          "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "wan2.1_t2v_1.3B_fp16.safetensors", "weight_dtype": "default" } },
          "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default" } },
          "3": { "class_type": "VAELoader", "inputs": { "vae_name": "wan_2.1_vae.safetensors" } },
          "4": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["1", 0], "shift": 8.0 } },
          "5": { "class_type": "CLIPTextEncode", "_meta": { "title": "Prompt Positivo" }, "inputs": { "text": "", "clip": ["2", 0] } },
          "6": { "class_type": "CLIPTextEncode", "_meta": { "title": "Prompt Negativo negative" }, "inputs": { "text": "overexposed, static, blurred details, subtitles, worst quality, low quality, ugly, deformed, extra fingers, malformed limbs", "clip": ["2", 0] } },
          "7": { "class_type": "EmptyHunyuanLatentVideo", "inputs": { "width": 832, "height": 480, "length": 49, "batch_size": 1 } },
          "8": { "class_type": "KSampler", "inputs": { "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0], "seed": 0, "steps": 25, "cfg": 6.0, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0 } },
          "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["3", 0] } },
          "10": { "class_type": "SaveAnimatedWEBP", "inputs": { "images": ["9", 0], "filename_prefix": "WakeGPU_Wan21", "fps": 16, "lossless": false, "quality": 85, "method": "default" } }
        };
        const created = await api("/api/templates", { json: { name: "🎬 Wan 2.1 1.3B (T4 Gratis)", json: JSON.stringify(wanGraph) } });
        await loadTemplates(created.id);
        tpl = templates.find(t => t.id === created.id) || templates[0];
      }

      $("#studioStatusTitle").textContent = "Generando tu vídeo con IA…";
      $("#studioStatusChip").textContent = "Renderizando";
      $("#studioProgFill").style.width = "65%";
      $("#studioStatusSub").textContent = "Procesando en la GPU de Colab. El Guardián Zero-Waste la apagará al terminar.";

      const durSec = +$("#studioDur").value || 5;
      const frames = Math.min(81, Math.max(33, Math.round(durSec * 16) + 1));
      const values = {};
      for (const f of tpl.fields) {
        if (/negative|negativo/i.test(f.label_cn || f.key)) { if (f.rec != null) values[f.key] = f.rec; }
        else if (/prompt|text|descrip/i.test(f.label_cn || f.key)) values[f.key] = compiledPrompt;
        else if (/duraci|duration|seconds|时长/i.test(f.label_cn || f.key)) values[f.key] = durSec;
        else if (/length|frames/i.test(f.key)) values[f.key] = frames;
        else if (/width|ancho/i.test(f.key)) values[f.key] = st.goal === "short" ? 480 : 832;
        else if (/height|alto/i.test(f.key)) values[f.key] = st.goal === "short" ? 832 : 480;
        else if (f.rec != null) values[f.key] = f.rec;
      }

      const fd = new FormData();
      fd.append("spec", JSON.stringify({
        template: tpl.id,
        title: "Estudio 1-Clic · " + idea.slice(0, 24),
        values,
        rand: [],
        count: 1,
        auto_hires: false,
        draft: false,
      }));
      if (st.goal === "i2v" && $("#studioImgFile").files[0]) {
        const imgFld = tpl.fields.find(f => f.type === "image" || f.kind === "image");
        if (imgFld) fd.append("file:" + imgFld.key, $("#studioImgFile").files[0]);
      }

      const r = await api("/api/jobs", { body: fd });
      st.activeJobId = (r && r.ids && r.ids[0]) || null;

      // Seguir estado del trabajo
      const track = setInterval(async () => {
        await loadJobs();
        const job = jobs && jobs.find(j => j.id === st.activeJobId);
        if (!job) return;
        if (job.status === "done") {
          clearInterval(track);
          $("#studioStatusTitle").textContent = "✅ ¡Vídeo creado con éxito!";
          $("#studioStatusChip").textContent = "Completado";
          $("#studioStatusChip").className = "chip ok";
          $("#studioProgFill").style.width = "100%";
          $("#studioStatusSub").textContent = "Tu vídeo ya está descargado en tu equipo. Guardián Zero-Waste gestionará el apagado seguro.";
          $("#studioResultActions").hidden = false;
          $("#btnStudioGo").disabled = false;
        } else if (job.status === "failed" || job.status === "canceled") {
          clearInterval(track);
          $("#studioStatusTitle").textContent = "❌ Error en la generación";
          $("#studioStatusChip").textContent = "Fallido";
          $("#studioProgFill").style.width = "100%";
          $("#studioStatusSub").textContent = job.error || "Revisa la pestaña Cola para más detalles.";
          $("#btnStudioGo").disabled = false;
        }
      }, 2500);
    } catch (e) {
      $("#studioStatusTitle").textContent = "⚠️ No se pudo completar";
      $("#studioStatusChip").textContent = "Detenido";
      $("#studioStatusSub").textContent = e.message || String(e);
      $("#btnStudioGo").disabled = false;
    }
  };
})();
