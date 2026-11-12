"use strict";
// ---------------- first-run guide ----------------
// Simple path (default): Iniciar con cuenta de Google → pegar código → Iniciar Colab (3 clics para arrancar una GPU).
// Full wizard (Tengo mi propia pasarela / Ajustes / ? menú): 7 pasos. El progreso se guarda en la config (onboarding.go).
// Relies on app.js / ai.js globals: $, $$, esc, api, toast, show, page, gst, profiles, loadProfiles, pollStatus,
// connectEvents, loadTemplates, wake, renderStatus, STATE_CN, BUSY, appCfg, loadSettings, isLocal, AI.

const OB = { st: null, path: "simple", step: 1, net: null, netBusy: false, ccu: null, mini: false, coachOn: false, clip: "" };
const OB_FULL = [i18n.t("ob_welcome"), i18n.t("ob_check_network"), i18n.t("ob_connection_mode"), i18n.t("ob_login"), i18n.t("ob_basic_settings"), i18n.t("ob_first_test"), i18n.t("ob_ready")];
const OB_PROFILE = "realvisxl-v5", OB_GPU = "L4";
const OB_SAMPLE = "a cozy cafe by the window on a rainy afternoon, steam rising from a cup of coffee, soft natural light, 35mm photo, shallow depth of field";
const OB_LINKS = {
  cu: "https://research.google.com/colaboratory/faq.html#compute-units",
  buy: "https://colab.research.google.com/signup",
  readme: "https://github.com/devexsolutions/wakegpu#readme",
  local: "https://github.com/devexsolutions/wakegpu#%EF%B8%8F-%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%BC%8F%E8%AF%B4%E6%98%8E",
  gateway: "https://github.com/devexsolutions/wakegpu/blob/main/gateway/README.md",
  guide: "https://github.com/devexsolutions/wakegpu/blob/main/docs/GETTING_STARTED.md",
};
const OB_CHECK = { network: i18n.t("ob_check_network_label"), login: i18n.t("ob_check_login_label"), wake: i18n.t("ob_check_wake_label"), generate: i18n.t("ob_check_generate_label"), stop: i18n.t("ob_check_stop_label") };

const obOpenURL = u => api("/api/open-url", { json: { url: u } }).catch(() => window.open(u));
async function obLoad() { try { OB.st = await api("/api/onboarding"); } catch { OB.st = null; } return OB.st; }
async function obSave(o) { try { OB.st = await api("/api/onboarding", { json: o }); } catch { } obRenderChecklist(); return OB.st; }
function obMark(item) { if (OB.st && OB.st.checklist && !OB.st.checklist.find(c => c.id === item && c.done)) obSave({ mark: item }); }

function obRate(acc) { const r = OB.st && OB.st.rates && OB.st.rates[(acc || "").toUpperCase()]; return r ? r.rate : 0; }
function obProfile() { return profiles && profiles.profiles && profiles.profiles.find(p => p.id === OB_PROFILE); }
function obCombo() {
  const p = obProfile(), acc = (p && p.accelerator) || OB_GPU, rate = obRate(acc);
  return { title: "Generación RealVisXL", acc, rate, size: p ? p.size_gb_default : 6.94, have: !!p };
}

// mode switch, the same way the 网关/本地 switch in the top bar does it
async function obSetMode(m) {
  if ((appCfg.mode || "gateway") === m) return;
  const c = await api("/api/config"); const cfg2 = c.config; cfg2.mode = m;
  await api("/api/config", { json: cfg2 });
  appCfg.mode = m; if (typeof renderMode === "function") renderMode();
  gst = null; await pollStatus(); await loadProfiles(); connectEvents();
}
async function obPatchConfig(patch) {
  const c = await api("/api/config"); await api("/api/config", { json: { ...c.config, ...patch } });
  await loadSettings();
}

// ---- open / close ----
function obOpen(path, step) {
  OB.path = path; OB.step = step || 1;
  $("#ob").hidden = false; document.body.classList.add("ob-open");
  obSave({ step: `${path}:${OB.step}` });
  obRender();
  if (!OB.net && !OB.netBusy) obNet(); // runs in the background; the simple path only shows failures
}
function obGo(step) { OB.step = step; obSave({ step: `${OB.path}:${step}` }); obRender(); }
function obClose(done) {
  $("#ob").hidden = true; document.body.classList.remove("ob-open");
  if (done) obSave({ onboarded: true, step: OB.st && OB.st.step === "coach" ? "coach" : "" });
}

async function obNet() {
  OB.netBusy = true; obRender();
  try { OB.net = await api("/api/netcheck"); } catch (e) { OB.net = { ok: false, items: [], advice: e.message, proxy: "" }; }
  OB.netBusy = false; obRender(); obLoad().then(obRenderChecklist);
}

// ---- rendering ----
function obRender() {
  const box = $("#ob"); if (box.hidden) return;
  const full = OB.path === "full";
  const body = full ? obFullStep() : obSimpleStep();
  box.innerHTML = `<div class="ob-card ${full ? "full" : "simple"}">
    <button class="ob-x" id="obX" title="Cerrar (continuar la próxima vez)">×</button>
    ${full ? `<ol class="ob-prog">${OB_FULL.map((n, i) => `<li class="${i + 1 < OB.step ? "done" : i + 1 === OB.step ? "on" : ""}"><i>${i + 1 < OB.step ? "✓" : i + 1}</i><span>${n}</span></li>`).join("")}</ol>` : ""}
    <div class="ob-body">${body}</div>
    ${obFooter()}
  </div>`;
  $("#obX").onclick = () => obClose(false);
  obBind();
}

function obFooter() {
  if (OB.path === "simple") {
    if (OB.step === 1) return `<div class="ob-foot"><a href="#" id="obSkipAll" class="muted small">Omitir guía, exploraré por mi cuenta</a></div>`;
    return `<div class="ob-foot"><button class="btn ghost sm" id="obBack">Atrás</button><span class="grow"></span><a href="#" id="obSkipAll" class="muted small">Omitir guía</a></div>`;
  }
  const last = OB.step === OB_FULL.length;
  return `<div class="ob-foot">${OB.step > 1 ? `<button class="btn ghost sm" id="obBack">Atrás</button>` : ""}<span class="grow"></span>
    ${last ? "" : `<button class="btn ghost sm" id="obSkip">Omitir este paso</button>`}
    ${OB.step === 3 || OB.step === 6 ? "" : `<button class="btn primary sm" id="obNext">${last ? "Finalizar" : "Siguiente"}</button>`}</div>`;
}

function obNetHTML(compact) {
  if (OB.netBusy) return `<div class="ob-net"><span class="spin"></span> Comprobando conexión…</div>`;
  const n = OB.net; if (!n) return "";
  if (compact) return n.ok ? "" : `<p class="warn-note">Comprobación de red: no se pudo conectar con ${n.items.filter(i => !i.ok).map(i => esc(i.name)).join(", ")}. ${esc(n.advice)} <a href="#" data-obnet>Reintentar</a></p>`;
  return `<div class="ob-net"><div class="muted small">Ruta actual: ${esc(n.proxy || "—")}</div>
    ${n.items.map(i => `<div class="ob-net-row ${i.ok ? "ok" : "bad"}"><b>${i.ok ? "✓" : "✗"}</b><span class="mono">${esc(i.name)}</span><span class="muted small">${esc(i.why)}</span><span class="grow"></span><span class="mono small">${i.ok ? i.ms + " ms" : esc(i.error || "")}</span></div>`).join("")}
    ${n.ok ? `<p class="ok-note">Conexión correcta.</p>` : `<p class="warn-note">${esc(n.advice)}</p>`}
    <button class="btn sm" data-obnet>Comprobar de nuevo</button></div>`;
}

function obLoginHTML() {
  const st = OB.st || {};
  if (st.signed_in) return `<div class="ok-note">Sesión iniciada como ${esc(st.email || "Google")}</div>${obCCUHTML()}`;
  return `<ol class="ob-howto" data-i18n-html="ob_login_steps">
      <li>Se ha abierto la página de autorización en tu navegador: inicia sesión en Google y pulsa «Permitir».</li>
      <li>La página mostrará un <b>código de autorización</b>; pulsa «Copiar» a su lado.</li>
      <li>Vuelve aquí y pulsa el botón siguiente.</li></ol>
    <button class="btn primary xl" id="obPaste">${OB.clip ? i18n.t("ob_login_btn_paste_detected") : i18n.t("ob_login_btn_paste")}</button>
    <details class="sub" ${OB.clipDenied ? "open" : ""}><summary>Pegar manualmente</summary>
      <div class="row gap"><input id="obCode" class="grow mono" data-i18n-placeholder="ob_login_code_placeholder" placeholder="Pega el código aquí (Cmd+V)" autocomplete="off"><button class="btn sm" id="obCodeGo" data-i18n="ob_login_btn_enter">Entrar</button></div></details>
    <p class="hint"><a href="#" id="obReopen" data-i18n="ob_login_browser_not_opened">¿No se abrió el navegador? Abrir otra vez</a></p>
    <p class="err" id="obErr"></p>`;
}

function obCCUHTML() {
  const c = OB.ccu;
  if (!c) return `<p class="muted small" id="obCCU" data-i18n="ob_net_checking"><span class="spin"></span> Consultando saldo de CU…</p>`;
  if (c.error) return `<p class="muted small" data-i18n-html="ob_net_err">No se pudo consultar el saldo de CU temporalmente: ${esc(c.error)} <button class="btn sm" id="obRetryCCU" data-i18n="ob_net_retry">Reintentar</button></p>`;
  const r = obRate("G4"), hours = r ? c.balance / r : 0;
  if (c.balance < 5) return `<p class="warn-note">Saldo de CU: ${c.balance.toFixed(1)}; el tiempo disponible es breve. <a href="#" data-url="${OB_LINKS.buy}">Comprar cómputo de Colab →</a></p>`;
  return `<p class="muted">Saldo de CU: <b>${c.balance.toFixed(1)}</b>${OB.path === "full" ? ` · aprox. ${hours.toFixed(0)} horas restantes (estimado en G4)` : ""}</p>`;
}

function obSimpleStep() {
  const s = OB.step;
  if (s === 1) return `<div class="ob-hero">
      <div class="ob-logo">▶</div>
      <h1 data-i18n="ob_simple_title">Comenzar con WakeGPU</h1>
      <p class="ob-lead" data-i18n="ob_simple_lead">Utiliza el cómputo de tu propio Google Colab para generar vídeo, imágenes y conversar con modelos de IA con un solo clic.</p>
      <button class="btn primary xl" id="obStart" data-i18n="ob_simple_start">Comenzar con cuenta de Google</button>
      <p class="muted small" data-i18n="ob_simple_cu_req">Requiere cómputo de pago de Colab (CU): suscripción Pro / Pro+ o unidades de cómputo adquiridas.</p>
      <a href="#" id="obGateway" class="small" data-i18n="ob_simple_gateway">Tengo mi propia pasarela (VPS) →</a>
      ${obNetHTML(true)}</div>`;
  if (s === 2) return `<div class="ob-hero left"><h2>Iniciar sesión en Google</h2>${obLoginHTML()}${obNetHTML(true)}</div>`;
  const c = obCombo();
  return `<div class="ob-hero"><h2>Arranque en un clic</h2>
      <div class="ob-combo"><b>${c.title} · ${esc(c.acc)}</b>
        <span>aprox. ${c.rate ? c.rate.toFixed(1) : "?"} CU/hora · 5～8 min de arranque</span>
        <span class="muted small">La primera vez descarga aprox. ${c.size ?? "?"} GB de modelo · Se detiene tras 30 min inactivo</span></div>
      ${obCCUHTML()}
      ${c.have ? "" : `<p class="warn-note">No se encontró la configuración RealVisXL. En modo pasarela es necesario aplicar gate-ai.py primero.</p>`}
      <button class="btn primary xl" id="obLaunch" data-i18n="ob_simple_launch">Iniciar Colab</button>
      <p class="muted small" data-i18n="ob_simple_reminder">El cómputo comienza al encender la máquina; recuerda pulsar «Detener» al finalizar</p></div>`;
}

function obFullStep() {
  const st = OB.st || {}, local = (appCfg.mode || "gateway") === "local";
  switch (OB.step) {
    case 1: return `<h2 data-i18n="ob_welcome">Bienvenida</h2><p class="ob-lead" data-i18n="ob_simple_lead">Genera vídeo, imágenes y dialoga con modelos de IA aprovechando tu cómputo en Colab.</p>
      <h3>Requisitos previos</h3><ul class="ob-list">
        <li><b>Cuenta de Google con cómputo de pago en Colab (CU)</b>: Colab Pro / Pro+ o unidades de cómputo (la versión gratuita solo incluye T4 y no admite modelos grandes).</li>
        <li><b>Conexión a Google, Hugging Face y GitHub</b>. WakeGPU utiliza automáticamente el proxy del sistema si está configurado.</li></ul>
      <p><a href="#" data-url="${OB_LINKS.cu}">¿Qué son las CU?</a> · <a href="#" data-url="${OB_LINKS.guide}">Guía inicial</a></p>`;
    case 2: return `<h2 data-i18n="ob_net_title">Comprobar red</h2><p class="muted" data-i18n="ob_net_desc">Comprueba la conectividad con Google, Colab, Hugging Face y GitHub.</p>${obNetHTML(false)}`;
    case 3: return `<h2>Modo de conexión</h2><div class="ob-modes">
        <button class="ob-mode ${local ? "on" : ""}" data-mode="local"><span class="pill sm">Recomendado</span><b>Modo local</b>
          <span>No requiere servidor VPS: enciende y apaga Colab directamente con tu cuenta de Google.</span>
          <span class="muted small">Utiliza la API de Colab directamente en tu Mac. <a href="#" data-url="${OB_LINKS.local}">Más información</a></span></button>
        <button class="ob-mode ${!local && st.gate_url ? "on" : ""}" data-mode="gateway"><b>Modo pasarela (Gateway)</b>
          <span>Para usuarios que tienen desplegado comfy-colab-kit en un VPS; ideal para compartir acceso.</span>
          <span class="muted small">Requiere parches en el servidor para activar todas las funciones. <a href="#" data-url="${OB_LINKS.gateway}">Guía de pasarela</a></span></button></div>`;
    case 4: return local ? `<h2>Iniciar sesión en Google</h2>${obLoginHTML()}
        ${st.signed_in ? `<div class="ob-smoke"><button class="btn sm" id="obSmoke">Probar encendido</button><span class="muted small">Arranca una instancia T4 para ejecutar una prueba y la apaga (~1–2 min)</span><pre class="g-log" id="obSmokeLog" hidden></pre></div>` : ""}`
      : `<h2>Conectar pasarela</h2>
        <label class="fld">URL de la pasarela<input id="obGate" value="${esc(st.gate_url || "")}" placeholder="https://comfy.tu-dominio.com"><span class="hint-in">Dirección web de tu pasarela comfy-colab-kit</span></label>
        <label class="fld">Token de agente<input id="obTok" type="password" autocomplete="off" placeholder="${appCfg.token ? "Guardado (dejar en blanco para conservar)" : ""}"><span class="hint-in">Obtenido en la web de la pasarela o en secrets/agent_token del VPS</span></label>
        <details class="sub"><summary>Token de servicio de Cloudflare Access (opcional)</summary>
          <label class="fld">CF-Access-Client-Id<input id="obCfId" value="${esc(appCfg.cf_client_id || "")}"></label>
          <label class="fld">CF-Access-Client-Secret<input id="obCfSec" type="password" autocomplete="off"><span class="hint-in">Solo necesario si el dominio está protegido tras Access</span></label></details>
        <div class="row gap"><button class="btn sm" id="obGateTest">Probar conexión</button><span class="small" id="obGateMsg"></span></div>
        <p class="hint">La pasarela requiere el parche correspondiente para selección de GPU y modelos: <a href="#" data-url="${OB_LINKS.gateway}">gateway/README.md</a></p>`;
    case 5: return `<h2>Ajustes básicos</h2>
        <label class="fld">Carpeta de resultados<input id="obOut" value="${esc(st.out_dir || st.default_out_dir || "")}"><span class="hint-in">Los vídeos e imágenes generados se descargarán aquí</span></label>
        ${local ? `<label class="fld narrow">Apagado automático por inactividad (minutos)<input id="obIdle" type="number" min="5" max="600" value="${st.local_idle_min || 30}"></label>
          <p class="hint" style="margin-top:-6px">La GPU consume CU mientras está encendida. Apagarla tras inactividad ahorra cómputo (recomendado: 30 min).</p>`
        : `<p class="hint">En modo pasarela, el apagado por inactividad se configura en el servidor (IDLE_MINUTES en .env).</p>`}
        <p class="hint">Puedes configurar APIs de LLM externas más adelante en «Ajustes → API de LLM» para la redacción asistida.</p>`;
    case 6: { const c = obCombo(); return `<h2>Primera prueba</h2>
        <p>Combinación recomendada y económica:</p>
        <div class="ob-combo"><b>RealVisXL V5.0 · ${esc(c.acc)}</b><span>~5–8 min de arranque · aprox. ${c.rate ? c.rate.toFixed(1) : "?"} CU/hora</span><span class="muted small">La primera vez descarga aprox. ${c.size ?? "?"} GB de modelo</span></div>
        ${c.have ? "" : `<p class="warn-note">No se encontró el perfil RealVisXL. Puedes omitir este paso por ahora.</p>`}
        <div class="row gap center"><button class="btn primary" id="obLaunch" ${c.have ? "" : "disabled"}>Despertar y probar una imagen</button><button class="btn" id="obLater">Omitir por ahora</button></div>`; }
    default: return `<h2>¡Todo listo!</h2><p class="ob-lead">Configuración completada. A continuación te mostraremos la interfaz.</p>
        <p class="muted">Recuerda detener la GPU cuando no la uses para evitar consumos innecesarios.</p>
        <button class="btn" id="obTour">Iniciar visita guiada</button>`;
  }
}

// ---- events ----
function obBind() {
  $$("#ob [data-url]").forEach(a => a.onclick = e => { e.preventDefault(); obOpenURL(a.dataset.url); });
  $$("#ob [data-obnet]").forEach(a => a.onclick = e => { e.preventDefault(); obNet(); });
  const on = (id, f) => { const el = $("#" + id); if (el) el.onclick = e => { e.preventDefault(); f(); }; };
  on("obSkipAll", () => obClose(true));
  on("obBack", () => obGo(Math.max(1, OB.step - 1)));
  on("obSkip", () => obGo(OB.step + 1));
  on("obNext", obNext);
  on("obGateway", () => obOpen("full", 1));
  on("obStart", obStart);
  on("obPaste", obPaste);
  on("obCodeGo", () => obLogin($("#obCode").value));
  on("obReopen", () => api("/api/local/login", { json: {} }).catch(e => obErr(e.message)));
  on("obLaunch", obLaunch);
  on("obLater", () => obGo(7));
  on("obTour", () => { obClose(true); obCoach(OB_TOUR_FULL); });
  on("obGateTest", obGateTest);
  on("obSmoke", obSmoke);
  on("obRetryCCU", obCCU);
  const code = $("#obCode"); if (code) code.onpaste = () => setTimeout(() => obLogin(code.value), 30);
  $$("#ob [data-mode]").forEach(b => b.onclick = async () => { await obSetMode(b.dataset.mode); obGo(4); });
  if (OB.step === 2 && OB.path === "full" && !OB.net && !OB.netBusy) obNet();
  if ((OB.step === 3 && OB.path === "simple" || OB.step === 4 && OB.path === "full") && OB.st && OB.st.signed_in && !OB.ccu) obCCU();
}
function obErr(m) { const e = $("#obErr"); if (e) e.textContent = m; else toast(m); }

async function obNext() {
  if (OB.path === "full" && OB.step === 5) {
    const patch = { out_dir: ($("#obOut").value || "").trim() };
    if ($("#obIdle")) patch.local_idle_min = parseInt($("#obIdle").value) || 30;
    try { await obPatchConfig(patch); } catch (e) { return toast("Error al guardar: " + e.message); }
  }
  if (OB.step === OB_FULL.length) { obClose(true); return; }
  obGo(OB.step + 1);
}

async function obStart() { // click 1: local mode + Google sign-in page
  try {
    await obSetMode("local");
    await obLoad();
    if (!OB.st.signed_in) await api("/api/local/login", { json: {} });
  } catch (e) { return toast(e.message); }
  obGo(OB.st.signed_in ? 3 : 2);
}

// Google's code looks like 4/0Ab…; offer it as soon as the user comes back from the browser
async function obPeekClipboard() {
  if ($("#ob").hidden || !$("#obPaste") || !navigator.clipboard || !navigator.clipboard.readText) return;
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (/^4\/[\w-]{20,}$/.test(t) || /[?&]code=4(%2F|\/)/.test(t)) { if (OB.clip !== t) { OB.clip = t; obRender(); } }
  } catch { }
}
window.addEventListener("focus", () => setTimeout(obPeekClipboard, 150));

async function obPaste() { // click 2
  let t = OB.clip;
  if (!t) {
    try { t = (await navigator.clipboard.readText()).trim(); } catch { OB.clipDenied = true; obRender(); const c = $("#obCode"); if (c) c.focus(); return obErr(i18n.t("ob_login_err_clip_denied")); }
  }
  if (!t) return obErr(i18n.t("ob_login_err_clip_empty"));
  obLogin(t);
}

async function obLogin(code) {
  code = (code || "").trim(); if (!code) return;
  const b = $("#obPaste"); if (b) { b.disabled = true; b.textContent = "Iniciando sesión…"; }
  try {
    await api("/api/local/code", { json: { code } });
    OB.clip = ""; await obLoad(); toast(i18n.t("ob_login_toast_ok", { email: OB.st.email || "" }));
    if (typeof loadLocal === "function") loadLocal();
    OB.ccu = null;
    if (OB.path === "simple") obGo(3); else obRender();
  } catch (e) { OB.clip = ""; obRender(); obErr(i18n.t("ob_login_err_auth", { err: e.message })); }
}

async function obCCU() {
  if (OB.ccuBusy) return;
  OB.ccuBusy = true;
  OB.ccu = null;
  try {
    const r = await api("/api/local/ccu", { json: {} });
    if (!Number.isFinite(r.balance)) throw new Error("Colab no devolvió un saldo válido");
    OB.ccu = { balance: r.balance, per_hour: r.per_hour };
  } catch (e) { OB.ccu = { error: e.message, balance: null }; }
  finally { OB.ccuBusy = false; }
  obRender();
}

async function obLaunch() { // click 3: wake RealVisXL on L4, go to the AI page's image panel
  const b = $("#obLaunch"); if (b) { b.disabled = true; b.textContent = "Iniciando…"; }
  try {
    if (!profiles) await loadProfiles();
    const p = obProfile();
    if (!p) throw new Error("No se encontró el perfil de inicio de RealVisXL");
    $("#wakeProfile").value = p.id; $("#wakeProfile").dispatchEvent(new Event("change"));
    const acc = $("#wakeAcc");
    if (acc && !acc.disabled && [...acc.options].some(o => o.value === p.accelerator)) { acc.value = p.accelerator || OB_GPU; acc.dataset.touched = "1"; }
    if (!await wake()) { if (b) { b.disabled = false; b.textContent = "Iniciar Colab"; } return; }
  } catch (e) { if (b) { b.disabled = false; b.textContent = "Iniciar Colab"; } return toast("Error al iniciar: " + e.message); }
  await obSave({ onboarded: true, step: "coach" });
  obClose(false);
  OB.mini = true; OB.prefill = true;
  show("ai"); if (typeof AI !== "undefined") AI.key = "";
  obMiniRender();
}

async function obGateTest() {
  const msg = $("#obGateMsg"); msg.textContent = "Probando…";
  const patch = { mode: "gateway", gate_url: $("#obGate").value.trim(), cf_client_id: $("#obCfId").value.trim() };
  if ($("#obTok").value.trim()) patch.token = $("#obTok").value.trim();
  if ($("#obCfSec").value.trim()) patch.cf_client_secret = $("#obCfSec").value.trim();
  try {
    await obPatchConfig(patch);
    await api("/api/gate/test", { json: {} });
    await loadProfiles();
    const n = profiles && profiles.profiles ? profiles.profiles.length : 0;
    msg.innerHTML = `<span class="ok-text">✓ Conexión exitosa · Pasarela con ${n} configuraciones</span>`;
    obLoad();
  } catch (e) { msg.innerHTML = `<span class="err-text">✗ ${esc(e.message)}</span>`; }
}

async function obSmoke() {
  const log = $("#obSmokeLog"); log.hidden = false; log.textContent = ""; $("#obSmoke").disabled = true;
  try {
    const r = await fetch("/api/local/smoke", { method: "POST", headers: { "X-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ accelerator: "T4" }) });
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (; ;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const d = (ev.match(/^data: (.*)$/m) || [])[1]; if (d == null) continue;
        let v = d; try { v = JSON.parse(d); } catch { }
        log.textContent += (/^event: fail/m.test(ev) ? "✗ " : /^event: ok/m.test(ev) ? "✓ " : "") + v + "\n"; log.scrollTop = log.scrollHeight;
      }
    }
  } catch (e) { log.textContent += "✗ " + e.message; }
  $("#obSmoke").disabled = false;
}

// ---- floating mini window while the first GPU boots ----
function obMiniRender() {
  const box = $("#obMini");
  const s = gst && gst.state;
  if (!OB.mini || !s || s === "sleeping") { box.hidden = true; return; }
  if (s === "ready") {
    box.hidden = true; OB.mini = false;
    if (OB.st && OB.st.step === "coach") obCoach(OB_TOUR_SIMPLE);
    return;
  }
  if (s === "failed") { box.hidden = false; box.innerHTML = `<b class="err-text">Fallo al iniciar</b><span class="small">${esc((gst.reason || "").slice(0, 120))}</span><span class="small">Consulta el registro en la Consola.</span><button class="btn xs" id="obMiniX">Cerrar</button>`; $("#obMiniX").onclick = () => { OB.mini = false; box.hidden = true; }; return; }
  const d = gst.progress && gst.progress.download;
  box.hidden = false;
  box.innerHTML = `<div class="row gap"><span class="spin"></span><b>${esc(STATE_CN[s] || s)}</b><span class="grow"></span><button class="ob-x sm" id="obMiniX" title="Minimizar">×</button></div>
    ${d && d.total_gb ? `<div class="bar"><div style="width:${Math.min(100, (d.done_gb / d.total_gb) * 100).toFixed(1)}%"></div></div><span class="small mono">${(d.done_gb || 0).toFixed(1)} / ${d.total_gb.toFixed(1)} GB</span>` : ""}
    <span class="small muted">La primera vez descarga el modelo; espera unos 5～8 minutos. Estará listo en breve.</span>`;
  $("#obMiniX").onclick = () => { OB.mini = false; box.hidden = true; };
}

function obPrefill() {
  if (!OB.prefill) return;
  const t = $("#aiPrompt");
  if (t && !$("#aiImg").hidden) { if (!t.value.trim()) t.value = OB_SAMPLE; OB.prefill = false; }
}

// ---- coach marks ----
const OB_TOUR_SIMPLE = [
  { sel: "#aiGen", text: "Prueba a pulsar «Generar»: en menos de un minuto tendrás tu primera imagen (se guardará abajo y en «Resultados»).", page: "ai" },
  { sel: 'nav button[data-page="gen"]', text: "Generar: importa flujos de ComfyUI y realiza generaciones por lotes de vídeo e imagen." },
  { sel: 'nav button[data-page="ai"]', text: "IA: generación integrada de imágenes y chat con LLM; usa «＋ Añadir modelo» para añadir modelos de Hugging Face." },
  { sel: "#btnStopTop", text: "Recuerda detener la GPU cuando termines para evitar consumo de CU." },
];
const OB_TOUR_FULL = [
  { sel: 'nav button[data-page="console"]', text: "Consola: despierta o detén la GPU, consulta el registro de arranque, temporizador y saldo de CU." },
  { sel: 'nav button[data-page="gen"]', text: "Generar: importa flujos de la API de ComfyUI, configura parámetros y gestiona la cola." },
  { sel: 'nav button[data-page="ai"]', text: "IA: modelos integrados de imagen y conversación, además de soporte para tus propios modelos." },
  { sel: 'nav button[data-page="queue"]', text: "Cola: las tareas se ejecutan secuencialmente; puedes cancelarlas o reintentarlas." },
  { sel: 'nav button[data-page="results"]', text: "Resultados: los archivos generados se descargan automáticamente en tu Mac." },
  { sel: 'nav button[data-page="settings"]', text: "Ajustes: modo de conexión, carpeta de salida, apagado por inactividad y modelos." },
  { sel: "#btnStopTop, #btnWakeTop", text: "Recuerda detener la GPU al terminar para ahorrar saldo de CU." },
];
function obCoach(list) {
  OB.coachList = list.filter(x => x); OB.coachI = 0; OB.coachOn = true; obCoachShow();
}
function obCoachShow() {
  const box = $("#obCoach");
  $$(".ob-hl").forEach(e => e.classList.remove("ob-hl"));
  const it = OB.coachList[OB.coachI];
  if (!it) { box.hidden = true; box.innerHTML = ""; OB.coachOn = false; if (OB.st && OB.st.step === "coach") obSave({ step: "" }); return; }
  if (it.page && page !== it.page) show(it.page);
  const el = $$(it.sel).find(e => e.offsetParent !== null);
  if (!el) { OB.coachI++; return obCoachShow(); }
  el.classList.add("ob-hl"); el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect(), last = OB.coachI === OB.coachList.length - 1;
  box.hidden = false;
  box.innerHTML = `<p>${esc(it.text)}</p><div class="row gap"><span class="muted small">${OB.coachI + 1} / ${OB.coachList.length}</span><span class="grow"></span>
    ${last ? "" : `<button class="btn ghost xs" id="obCoachSkip">Omitir</button>`}<button class="btn primary xs" id="obCoachNext">${last ? "Entendido" : "Siguiente"}</button></div>`;
  const bw = box.offsetWidth, bh = box.offsetHeight, vw = innerWidth, vh = innerHeight;
  let x = r.right + 12, y = r.top + r.height / 2 - bh / 2;
  if (x + bw > vw - 12) { x = Math.min(vw - bw - 12, Math.max(12, r.left + r.width / 2 - bw / 2)); y = r.bottom + 10 + bh > vh ? r.top - bh - 10 : r.bottom + 10; }
  box.style.left = Math.max(12, x) + "px"; box.style.top = Math.max(12, Math.min(vh - bh - 12, y)) + "px";
  box.dataset.side = x > r.right ? "left" : "top";
  $("#obCoachNext").onclick = () => { OB.coachI++; obCoachShow(); };
  const sk = $("#obCoachSkip"); if (sk) sk.onclick = () => { OB.coachI = OB.coachList.length; obCoachShow(); };
}
addEventListener("resize", () => { if (OB.coachOn) obCoachShow(); });

// ---- getting-started checklist (console) ----
function obRenderChecklist() {
  const box = $("#obChecklist"); if (!box) return;
  const st = OB.st;
  if (!st || !st.onboarded || st.all_done) { box.hidden = true; return; }
  const done = st.checklist.filter(c => c.done).length, open = !st.checklist_hidden;
  box.hidden = false;
  box.innerHTML = `<div class="row gap ob-ck-head" id="obCkToggle"><b>Guía de inicio</b><span class="muted small">${done} / ${st.checklist.length}</span>
      <div class="ob-ck-bar"><div style="width:${done / st.checklist.length * 100}%"></div></div><span class="grow"></span><span class="muted small">${open ? "Plegar ▴" : "Desplegar ▾"}</span></div>
    ${open ? `<ul class="ob-ck">${st.checklist.map(c => `<li class="${c.done ? "done" : ""}"><button data-ck="${c.id}" ${c.done ? "disabled" : ""}><i>${c.done ? "✓" : ""}</i>${OB_CHECK[c.id]}</button></li>`).join("")}</ul>` : ""}`;
  $("#obCkToggle").onclick = () => obSave({ checklist_hidden: open });
  $$("[data-ck]", box).forEach(b => b.onclick = () => obCheckAction(b.dataset.ck));
}
function obCheckAction(id) {
  if (id === "network") return obOpen("full", 2);
  if (id === "login") return isLocal() ? obOpen("full", 4) : (show("settings"), setTimeout(() => $("#setForm [name=gate_url]").focus(), 100));
  if (id === "wake") return obOpen(OB.path === "full" ? "full" : "simple", OB.path === "full" ? 6 : 3);
  if (id === "generate") return show("ai");
  if (id === "stop") { show("console"); $("#btnStop").scrollIntoView({ block: "center" }); return toast("Cuando la GPU esté activa, pulsa «Detener y liberar»"); }
}

// ---- help menu ----
$("#btnHelp").onclick = e => { e.stopPropagation(); $("#helpMenu").hidden = !$("#helpMenu").hidden; };
document.addEventListener("click", e => { if (!e.target.closest("#helpMenu")) $("#helpMenu").hidden = true; });
$("#helpGuide").onclick = () => { $("#helpMenu").hidden = true; obOpen("full", 1); };
$("#helpReadme").onclick = () => { $("#helpMenu").hidden = true; obOpenURL(OB_LINKS.readme); };
$("#helpNet").onclick = () => { $("#helpMenu").hidden = true; OB.net = null; obOpen("full", 2); };
$("#btnRerunGuide").onclick = () => obOpen("full", 1);

// ---- estimate next to the wake button ----
function obWakeCost() {
  const el = $("#wakeCost"); if (!el) return;
  const sel = $("#wakeAcc"), p = profiles && profiles.profiles && profiles.profiles.find(x => x.id === $("#wakeProfile").value);
  const acc = sel && !sel.disabled && !$("#accWrap").hidden ? sel.value : (p && p.accelerator) || (gst && gst.default_accelerator) || "";
  const r = obRate(acc), m = OB.st && OB.st.rates && OB.st.rates[acc] && OB.st.rates[acc].measured;
  const asleep = !gst || !gst.state || gst.state === "sleeping" || gst.state === "failed";
  el.textContent = asleep && r ? `Consumo estimado: ~${r.toFixed(1)} CU/hora (${acc}${m ? ", según última sesión" : ", valor estimado"})` : "";
}
$("#wakeAcc").addEventListener("change", obWakeCost);
$("#wakeProfile").addEventListener("change", obWakeCost);

// follow status changes: mini window, prefill, checklist, cost
const _obRS = renderStatus;
renderStatus = function () {
  _obRS(); obMiniRender(); obPrefill(); obWakeCost();
  if (gst && gst.state === "ready" && OB.st && OB.st.step === "coach" && !OB.coachOn && !OB.mini) obCoach(OB_TOUR_SIMPLE);
};
setInterval(() => { if (page === "console" && OB.st && OB.st.onboarded && !OB.st.all_done) obLoad().then(obRenderChecklist); }, 20000);

// ---- start ----
(async () => {
  const st = await obLoad();
  if (!st) return;
  if (!st.onboarded) {
    const [p, s] = (st.step || "simple:1").split(":");
    obOpen(p === "full" ? "full" : "simple", Math.max(1, Math.min(p === "full" ? 7 : 3, +s || 1)));
  }
  obRenderChecklist(); obWakeCost();
})();
