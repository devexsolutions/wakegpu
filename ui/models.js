"use strict";
// ---------------- custom models: paste a Hugging Face link -> a start profile ----------------
// Relies on app.js / ai.js globals: $, $$, esc, api, toast, openModal, closeModal, loadProfiles, templates,
// isLocal, AI, aiPickRender, page.

const CM = { items: [], err: "", outdated: false, loaded: false };
const CM_KINDS = [["llm", i18n.t("sec_custom_models_kind_llm")], ["sdxl", i18n.t("sec_custom_models_kind_sdxl")], ["chroma", i18n.t("sec_custom_models_kind_chroma")], ["comfy", i18n.t("sec_custom_models_kind_comfy")]];
const CM_KIND_CN = { ...Object.fromEntries(CM_KINDS), llm_unsupported: i18n.t("sec_custom_models_kind_llm_unsupported"), unknown: i18n.t("sec_custom_models_kind_unknown") };
const CM_GPUS = ["T4", "L4", "G4", "A100", "H100"];
const CM_ROLE_CN = { model: i18n.t("sec_custom_models_role_model"), clip: i18n.t("sec_custom_models_role_clip"), vae: i18n.t("sec_custom_models_role_vae"), extra: i18n.t("sec_custom_models_role_extra") };
const CM_NOTICE = i18n.t("sec_custom_models_notice");
let CM_DIRS = ["checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "vae", "loras", "upscale_models", "controlnet", "clip_vision", "embeddings"];

// same rule as recommendGPU() in custom_models.go: size × 1.2 + 2 GB; L4 (24 GB) up to 20, G4 (96 GB) up to 80, else H100
function cmGPU(totalGB) {
  const need = Math.round((totalGB * 1.2 + 2) * 10) / 10;
  if (totalGB * 1.2 > 96) return { gpu: "", need, blocked: true, note: i18n.t("sec_custom_models_gpu_req", { need: Math.ceil(totalGB * 1.2) }) };
  if (need <= 20) return { gpu: "L4", need, note: "" };
  return { gpu: "G4", need, note: i18n.t("sec_custom_models_gpu_g4", { need: Math.round(need) }) };
}
const cmGB = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "") + " GB";
const cmBase = p => p.split("/").pop();
function cmHF(repo, rev, p) { const [o, n] = repo.split("/"); return `hf://${o}/${n}${rev ? "@" + rev : ""}/${p}`; }

// files that make sense for a kind (mirror of candidates() in custom_models.go)
function cmCands(kind, all) {
  return all.filter(f => {
    const l = f.path.toLowerCase();
    if (kind === "llm") return l.endsWith(".gguf") && !l.includes("mmproj") && !/-\d{5}-of-\d{5}\.gguf$/.test(l);
    if (kind === "sdxl" || kind === "chroma") return !f.path.includes("/") && /\.(safetensors|ckpt|sft)$/.test(l) && f.size >= 1e9;
    return true;
  });
}

async function loadCustomModels() {
  try {
    const r = await api("/api/custom-models");
    CM.items = r.items || []; CM.err = ""; CM.outdated = false;
  } catch (e) {
    CM.items = []; CM.err = e.message; CM.outdated = /gate-ai\.py/.test(e.message);
  }
  CM.loaded = true;
  cmRenderSettings();
  if (typeof AI !== "undefined") { AI.key = ""; if (page === "ai") aiPickRender(); }
}

// ---- settings: list / edit / delete ----
function cmRenderSettings() {
  const box = $("#cmList"); if (!box) return;
  if (CM.err) { box.innerHTML = `<p class="${CM.outdated ? "warn-note" : "err"}">${esc(CM.err)}</p>`; return; }
  if (!CM.items.length) { box.innerHTML = `<p class="muted small cm-empty" data-i18n="sec_custom_models_empty">Aún no hay modelos personalizados. Pulsa «＋ Añadir modelo» arriba y pega un enlace de Hugging Face.</p>`; return; }
  box.innerHTML = CM.items.map(it => {
    const s = it.spec || {}, size = (s.files || []).reduce((a, f) => a + (f.size_gb || 0), 0);
    return `<div class="cm-row">
      <span class="pill sm ${s.kind === "llm" ? "llm" : s.kind === "comfy" ? "" : "img"}">${esc(CM_KIND_CN[s.kind] || s.kind)}</span>
      <div class="grow"><b>${esc(it.title)}</b><div class="muted small mono">${esc(it.id)} · ${esc(s.gpu || "")} · aprox. ${cmGB(size)}${s.template ? " · Plantilla vinculada" : ""}</div>
        ${it.problem ? `<p class="err">No se puede usar: ${esc(it.problem)}</p>` : it.error ? `<p class="err">${esc(it.error)}</p>` : ""}</div>
      <button type="button" class="btn xs" data-cmedit="${esc(it.id)}">Editar</button>
      <button type="button" class="btn ghost xs" data-cmdel="${esc(it.id)}">Eliminar</button></div>`;
  }).join("");
  $$("[data-cmedit]", box).forEach(b => b.onclick = () => { const it = CM.items.find(x => x.id === b.dataset.cmedit); if (it) cmEdit(it.spec); });
  $$("[data-cmdel]", box).forEach(b => b.onclick = () => cmDelete(b.dataset.cmdel));
}

async function cmDelete(id) {
  const it = CM.items.find(x => x.id === id);
  if (!await appConfirm(`¿Eliminar el modelo personalizado «${it ? it.title : id}»?\n\nSolo se eliminará el perfil de inicio; los resultados ya generados no se verán afectados.`)) return;
  try { await api("/api/custom-models/" + encodeURIComponent(id), { method: "DELETE" }); toast("Modelo eliminado"); }
  catch (e) { return await appAlert("Error al eliminar: " + e.message); }
  await cmRefreshAll();
}

async function cmRefreshAll() {
  await Promise.all([loadProfiles(), typeof loadTemplates === "function" ? loadTemplates() : null]);
  if (typeof AI !== "undefined") { AI.key = ""; if (page === "ai") aiPickRender(); }
}

// ---- add: paste link -> inspect -> form ----
function cmAdd(prefill) {
  openModal(`<div class="cm">
    <h3>Añadir modelo</h3>
    <p class="hint" style="margin-top:0">Pega el enlace a la página o archivo de un modelo en Hugging Face; WakeGPU detectará tipo, tamaño y recomendará GPU y parámetros.</p>
    <div class="row gap"><input id="cmUrl" class="grow" placeholder="https://huggingface.co/autor/repositorio" value="${esc(prefill || "")}" autocomplete="off">
      <button class="btn primary" id="cmGo">Identificar</button></div>
    <div style="margin:8px 0 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <span class="muted small" style="font-weight:600;">Sugerencias populares:</span>
      <button type="button" class="btn xs ghost cm-sug-btn" data-url="https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF">💻 Qwen 2.5 Coder 14B</button>
      <button type="button" class="btn xs ghost cm-sug-btn" data-url="https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF">⚡ Qwen 2.5 Coder 7B (T4)</button>
      <button type="button" class="btn xs ghost cm-sug-btn" data-url="https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-14B-GGUF">🧠 DeepSeek R1 14B</button>
    </div>
    <p class="hint">Admite <code>huggingface.co/autor/repo</code>, <code>…/blob/main/archivo</code>, <code>…/resolve/main/archivo</code>, <code>hf://autor/repo/archivo</code></p>
    <div id="cmBody"></div>
    <p class="cm-notice">${CM_NOTICE}</p>
  </div>`);
  $("#modalBox").classList.add("cm-box");
  const go = async () => {
    const url = $("#cmUrl").value.trim(); if (!url) return $("#cmUrl").focus();
    $("#cmGo").disabled = true;
    $("#cmBody").innerHTML = `<div class="cm-loading"><span class="spin"></span>Identificando… Consultando información en Hugging Face</div>`;
    try {
      const r = await api("/api/custom-models/inspect", { json: { url } });
      cmForm(r);
    } catch (e) { $("#cmBody").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    finally { const b = $("#cmGo"); if (b) b.disabled = false; }
  };
  $("#cmGo").onclick = go;
  $$(".cm-sug-btn").forEach(btn => {
    btn.onclick = () => {
      $("#cmUrl").value = btn.dataset.url;
      go();
    };
  });
  $("#cmUrl").onkeydown = e => { if (e.key === "Enter") go(); };
  setTimeout(() => $("#cmUrl") && $("#cmUrl").focus(), 30);
  if (prefill) go();
}

// state of the open form
let CF = null;

function cmForm(r) {
  CF = {
    r, kind: r.kind, title: r.title, id: r.id, gpu: r.gpu, gpuTouched: false, edit: false,
    sel: { [r.kind]: (r.selected && r.selected[0]) || "" },
    params: { [r.kind]: { ...(r.params || {}) } },
    extras: (r.extras || []).map(x => ({ ...x })),
    rows: null, template: "",
  };
  if (r.model_dirs && r.model_dirs.length) CM_DIRS = r.model_dirs;
  cmRenderForm();
}

// edit an existing custom model (no Hugging Face round trip)
function cmEdit(spec) {
  openModal(`<div class="cm"><h3>Editar modelo personalizado</h3><div id="cmBody"></div><p class="cm-notice">${CM_NOTICE}</p></div>`);
  $("#modalBox").classList.add("cm-box");
  const kind = spec.kind;
  CF = {
    r: { repo: "", rev: "", link: spec.source || "", license: (spec.files[0] || {}).license || "", files: [], all_files: [], kind_reason: "" },
    kind, title: spec.title, id: spec.id, gpu: spec.gpu, gpuTouched: true, edit: true, template: spec.template || "",
    params: { [kind]: { ...(spec.llm || spec.image || {}) } },
    rows: spec.files.map(f => ({ ...f, on: true })),
  };
  cmRenderForm();
}

function cmParamsHTML(kind, p) {
  const num = (k, label, step, min) => `<label class="fld narrow">${label}<input type="number" data-cp="${k}" value="${esc(p[k] ?? "")}" step="${step || 1}" ${min != null ? `min="${min}"` : ""}></label>`;
  if (kind === "llm") return `<div class="row gap wrap">${num("ctx", "Longitud de contexto", 1024, 2048)}${num("temperature", "Temperatura", 0.05, 0)}
      <label class="chk cm-chk"><input type="checkbox" data-cp="think" ${p.think ? "checked" : ""}>Activar pensamiento profundo por defecto</label></div>
      ${CF.r.context_length ? `<p class="hint" style="margin-top:-4px">Contexto máximo del modelo: ${CF.r.context_length.toLocaleString()}; por defecto se limita a 32K (más grande consume más VRAM).</p>` : ""}`;
  if (kind === "sdxl" || kind === "chroma") return `<div class="row gap wrap">${num("width", "Ancho", 64, 256)}${num("height", "Alto", 64, 256)}${num("steps", "Pasos", 1, 1)}${num("cfg", "CFG", 0.1, 0)}
      <label class="fld narrow">Muestreador<input data-cp="sampler" value="${esc(p.sampler || "")}"></label>
      <label class="fld narrow">Planificador<input data-cp="scheduler" value="${esc(p.scheduler || "")}"></label>
      ${kind === "chroma" ? num("shift", "shift", 0.1, 0) : ""}</div>
      <label class="fld">Prompt negativo<textarea data-cp="negative" rows="2">${esc(p.negative || "")}</textarea></label>`;
  return "";
}

function cmFilePicker() {
  const r = CF.r, cands = cmCands(CF.kind, r.all_files || r.files || []);
  if (!cands.length) return `<p class="err">No hay archivos compatibles con «${CM_KIND_CN[CF.kind]}» en este repositorio${CF.kind === "llm" ? " (se requiere un único archivo GGUF)" : CF.kind !== "comfy" ? " (se requiere un punto de control en la raíz > 1 GB)" : ""}. Prueba con otro tipo.</p>`;
  if (!cands.some(f => f.path === CF.sel[CF.kind])) CF.sel[CF.kind] = cands[0].path;
  const fit = f => cmGPU(f.size_gb + (CF.kind === "chroma" ? cmExtrasGB() : 0));
  const tip = f => { const g = fit(f); return g.blocked ? `<span class="warn-text">No cabe</span>` : `Requiere ${g.need} GB · ${g.gpu}`; };
  return `<div class="cm-files">` + cands.map(f => `<label class="cm-file ${f.path === CF.sel[CF.kind] ? "on" : ""} ${fit(f).blocked ? "off" : ""}">
      <input type="radio" name="cmFile" value="${esc(f.path)}" ${f.path === CF.sel[CF.kind] ? "checked" : ""} ${fit(f).blocked && f.path !== CF.sel[CF.kind] ? "disabled" : ""}>
      <span class="grow mono">${esc(f.path)}</span>${f.quant ? `<span class="pill sm">${esc(f.quant)}</span>` : ""}
      <span class="muted small mono">${cmGB(f.size_gb)}</span><span class="muted small">${tip(f)}</span></label>`).join("") + `</div>`;
}

function cmExtrasGB() { return (CF.extras || []).reduce((a, x) => a + (+x.size_gb || 0), 0); }

function cmRowsHTML() {
  const dirOpts = d => CM_DIRS.concat(CM_DIRS.includes(d) || !d ? [] : [d]).map(x => `<option ${x === d ? "selected" : ""}>${esc(x)}</option>`).join("");
  return `<div class="cm-rows"><div class="cm-rhead"><span></span><span>Enlace (hf:// o enlace directo de Hugging Face)</span><span>Carpeta de destino</span><span>Tamaño GB</span><span></span></div>` +
    CF.rows.map((f, i) => `<div class="cm-r">
      <input type="checkbox" data-ri="${i}" data-rk="on" ${f.on ? "checked" : ""} title="Usar este archivo">
      <div class="cm-rurl">${f.role && f.role !== "extra" ? `<span class="pill sm">${CM_ROLE_CN[f.role]}</span>` : ""}<input class="mono" data-ri="${i}" data-rk="url" value="${esc(f.url)}" placeholder="https://huggingface.co/autor/repo/blob/main/archivo"></div>
      <select data-ri="${i}" data-rk="dir">${dirOpts(f.dir)}</select>
      <input type="number" step="0.01" min="0" data-ri="${i}" data-rk="size_gb" value="${f.size_gb ?? ""}">
      <button class="btn ghost xs" data-rdel="${i}" title="Eliminar">×</button></div>`).join("") +
    `<button class="btn xs" id="cmRowAdd">＋ Añadir archivo</button></div>`;
}

// a transformers chat model: explain, and offer the GGUF versions found on Hugging Face
function cmUnsupportedHTML(r) {
  const repos = r.gguf_repos || [];
  const list = repos.length ? `<div class="cm-files">` + repos.map(a => `<div class="cm-file ${a.fits ? "" : "off"}">
      <span class="grow mono">${esc(a.repo)}</span>
      ${a.min_gb ? `<span class="muted small">Mín. ${esc(a.min_quant || "?")} ${cmGB(a.min_gb)} · Máx. ${esc(a.max_quant || "?")} ${cmGB(a.max_gb)}</span>` : `<span class="muted small">Sin cuantización de un solo archivo</span>`}
      ${a.fits ? "" : `<span class="warn-text small">Ninguno cabe</span>`}
      <button type="button" class="btn xs" data-retry="${esc(a.link)}">Usar este repositorio</button></div>`).join("") + `</div>`
    : `<p class="muted small">${esc(r.search_error || "No se encontraron versiones GGUF con el mismo nombre en Hugging Face.")}</p>`;
  return `<p class="warn-note">${esc(r.blocked)}${r.total_gb ? `<br>El peso total de este repositorio es de aprox. ${cmGB(r.total_gb)}.` : ""}</p>
    <div class="fld"><span>Versiones GGUF encontradas</span>${list}</div>`;
}

function cmRenderForm() {
  const r = CF.r, kind = CF.kind;
  if (kind === "llm_unsupported") {
    $("#cmBody").innerHTML = `<div class="cm-head"><a href="#" class="mono" id="cmRepo">${esc(r.repo)}</a>
      ${r.license ? `<span class="pill sm">Licencia ${esc(r.license)}</span>` : ""}<span class="pill sm warn">${CM_KIND_CN[kind]}</span></div>
      ${cmUnsupportedHTML(r)}<div class="row end"><button class="btn" data-close>Cerrar</button></div>`;
    $$("[data-close]").forEach(b => b.onclick = closeModal);
    $("#cmRepo").onclick = e => { e.preventDefault(); api("/api/open-url", { json: { url: r.link } }).catch(() => window.open(r.link)); };
    $$("[data-retry]").forEach(b => b.onclick = () => { $("#cmUrl").value = b.dataset.retry; $("#cmGo").click(); });
    return;
  }
  if (kind === "comfy" && !CF.rows) {
    const sel = new Set(r.selected || []);
    CF.rows = (r.all_files || r.files || []).map(f => ({ role: "extra", url: cmHF(r.repo, r.rev, f.path), dir: f.dir, size_gb: f.size_gb, license: r.license, on: sel.size ? sel.has(f.path) : (r.all_files || []).length <= 3 }));
  }
  const total = cmTotalGB(), g = cmGPU(total);
  if (!CF.gpuTouched || g.gpu === "G4" && CF.gpu === "L4") CF.gpu = g.gpu || "G4"; // never leave a too-small GPU selected
  const tpls = templates || [];
  const tplOpts = `<option value="">${tpls.length ? "Selecciona una plantilla" : "No hay plantillas disponibles"}</option>` + tpls.map(t => `<option value="${esc(t.id)}" ${t.id === CF.template ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  let why = "";
  if (kind === "unknown") why = "No se ha reconocido el tipo de modelo: selecciónalo arriba.";
  else if (g.blocked) why = g.note + "; no se puede guardar." + (kind === "llm" ? " Elige una versión cuantizada más reducida." : "");
  else if (kind === "comfy" && !(CF.rows || []).some(f => f.on && f.url)) why = "Selecciona al menos un archivo.";
  else if (kind === "comfy" && !CF.template) why = tpls.length ? "Selecciona la plantilla asociada: se usará en la pestaña «Generar» al despertar." : "Este perfil requiere asociar una plantilla de la pestaña «Generar». Importa un flujo API en «Generar» antes de guardar.";
  const showRows = kind === "comfy" || CF.edit;
  $("#cmBody").innerHTML = `
    ${CF.edit ? "" : `<div class="cm-head">
      <a href="#" class="mono" id="cmRepo">${esc(r.repo)}${r.rev ? "@" + esc(r.rev) : ""}</a>
      ${r.license ? `<span class="pill sm">Licencia ${esc(r.license)}</span>` : `<span class="pill sm warn">Sin licencia especificada</span>`}
      <span class="muted small">${esc(r.kind_reason || "")}</span></div>
      ${r.gated ? `<p class="warn-note">${esc(r.gated_note || "Requiere token de Hugging Face")}</p>` : ""}`}
    <div class="fld"><span>Tipo</span><div class="seg" id="cmKind">${CM_KINDS.map(([k, n]) => `<button type="button" data-k="${k}" class="${k === kind ? "on" : ""}" ${CF.edit && k !== kind ? "disabled" : ""}>${n}</button>`).join("")}</div></div>
    ${kind === "comfy" ? `<p class="hint" style="margin-top:-6px">Se muestra en la pestaña IA como tarjeta «General»: al despertar se ejecuta con la plantilla asociada de ComfyUI. Los archivos marcados se descargarán en cada arranque.</p>` : ""}
    ${kind === "unknown" ? "" : showRows ? cmRowsHTML() : `<div class="fld"><span>${kind === "llm" ? "Versión cuantizada" : "Archivo de modelo"}</span>${cmFilePicker()}</div>`}
    ${kind === "chroma" && !CF.edit ? `<details class="sub cm-extras"><summary>T5 y VAE (por defecto reutiliza los archivos de Chroma1-HD)</summary>
        ${CF.extras.map((x, i) => `<label class="fld">${CM_ROLE_CN[x.role]}<input class="mono" data-xi="${i}" value="${esc(x.url)}"></label>`).join("")}</details>` : ""}
    <div class="row gap wrap cm-grid">
      <label class="fld grow">Título<input id="cmTitle" value="${esc(CF.title)}" maxlength="80"></label>
      <label class="fld narrow">GPU<select id="cmGpu">${CM_GPUS.map(x => `<option ${x === CF.gpu ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      ${kind === "comfy" ? `<label class="fld narrow">Plantilla vinculada<select id="cmTpl">${tplOpts}</select></label>` : ""}
    </div>
    ${kind === "unknown" ? "" : `<p class="hint cm-gpu" style="margin-top:-6px">Total aprox. <b>${cmGB(total)}</b>; VRAM estimada: ${g.need} GB → ${g.blocked ? `<span class="warn-text">${esc(g.note)}</span>` : `Recomendado: <b>${g.gpu}</b>${g.note ? `<span class="muted"> (${esc(g.note)})</span>` : ""}${CF.gpu !== g.gpu ? ` · Seleccionado: ${CF.gpu}` : ""}`}</p>`}
    ${why ? `<p class="warn-note">${esc(why)}${kind === "comfy" && !tpls.length ? ` <a href="#" id="cmGoGen">Ir a «Generar» →</a>` : ""}</p>` : ""}
    ${kind !== "comfy" && kind !== "unknown" ? `<div class="sec-h sub"><b>Parámetros principales</b><span class="d">Podrás ajustarlos también en la pestaña IA</span></div>${cmParamsHTML(kind, CF.params[kind] || (CF.params[kind] = cmDefaults(kind)))}` : ""}
    <p class="err" id="cmErr"></p>
    <div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="cmSave" ${why ? "disabled" : ""}>${CF.edit ? "Guardar cambios" : "Guardar como perfil de inicio"}</button></div>`;
  const gg = $("#cmGoGen"); if (gg) gg.onclick = e => { e.preventDefault(); closeModal(); show("gen"); };
  const ts = $("#cmTpl"); if (ts) ts.onchange = () => { cmSync(); cmRenderForm(); };
  $$("[data-close]").forEach(b => b.onclick = closeModal);
  const repo = $("#cmRepo"); if (repo) repo.onclick = e => { e.preventDefault(); api("/api/open-url", { json: { url: r.link } }).catch(() => window.open(r.link)); };
  $$("#cmKind button").forEach(b => b.onclick = () => { if (b.disabled) return; cmSync(); CF.kind = b.dataset.k; cmRenderForm(); });
  $$("[name=cmFile]").forEach(i => i.onchange = () => { cmSync(); CF.sel[CF.kind] = i.value; cmRenderForm(); });
  $("#cmGpu").onchange = () => { CF.gpuTouched = true; cmSync(); cmRenderForm(); };
  $$("[data-rdel]").forEach(b => b.onclick = () => { cmSync(); CF.rows.splice(+b.dataset.rdel, 1); cmRenderForm(); });
  $$("[data-rk=on],[data-rk=size_gb],[data-rk=dir]").forEach(i => i.onchange = () => { cmSync(); cmRenderForm(); });
  const add = $("#cmRowAdd"); if (add) add.onclick = () => { cmSync(); CF.rows.push({ role: "extra", url: "", dir: "checkpoints", size_gb: 0, license: r.license, on: true }); cmRenderForm(); };
  $("#cmSave").onclick = cmSave;
}

function cmDefaults(kind) {
  if (kind === "llm") return { ctx: 32768, think: false, temperature: 0.7 };
  if (kind === "chroma") return { width: 1024, height: 1024, steps: 26, cfg: 3.8, sampler: "euler", scheduler: "beta", shift: 1, negative: "" };
  return { width: 1024, height: 1024, steps: 30, cfg: 5, sampler: "dpmpp_sde", scheduler: "karras", negative: "" };
}

function cmTotalGB() {
  if (CF.kind === "comfy" || CF.edit) return (CF.rows || []).filter(f => f.on).reduce((a, f) => a + (+f.size_gb || 0), 0);
  const f = cmCands(CF.kind, CF.r.all_files || CF.r.files || []).find(x => x.path === CF.sel[CF.kind]);
  return (f ? f.size_gb : 0) + (CF.kind === "chroma" ? cmExtrasGB() : 0);
}

// read the form back into CF
function cmSync() {
  if (!$("#cmTitle")) return;
  CF.title = $("#cmTitle").value.trim();
  CF.gpu = $("#cmGpu").value;
  if ($("#cmTpl")) CF.template = $("#cmTpl").value;
  const p = CF.params[CF.kind] || {};
  $$("[data-cp]").forEach(i => {
    const k = i.dataset.cp;
    p[k] = i.type === "checkbox" ? i.checked : i.type === "number" ? (i.value === "" ? undefined : +i.value) : i.value;
  });
  CF.params[CF.kind] = p;
  $$("[data-ri]").forEach(i => {
    const row = CF.rows[+i.dataset.ri]; if (!row) return;
    const k = i.dataset.rk;
    row[k] = k === "on" ? i.checked : k === "size_gb" ? +i.value || 0 : i.value.trim();
  });
  $$("[data-xi]").forEach(i => { CF.extras[+i.dataset.xi].url = i.value.trim(); });
}

function cmSpec() {
  const r = CF.r, kind = CF.kind;
  const spec = { id: CF.id, title: CF.title, kind, gpu: CF.gpu, source: r.link || "", template: CF.template || "" };
  if (kind === "comfy" || CF.edit) {
    spec.files = CF.rows.filter(f => f.on && f.url).map(f => ({ role: kind === "comfy" ? "extra" : f.role, url: f.url, dir: f.dir, name: f.name || "", size_gb: +f.size_gb || 0, license: f.license || r.license || "" }));
  } else {
    const f = cmCands(kind, r.all_files || r.files || []).find(x => x.path === CF.sel[kind]);
    if (!f) return null;
    const dir = { llm: "llm", sdxl: "checkpoints", chroma: "diffusion_models" }[kind];
    spec.files = [{ role: "model", url: cmHF(r.repo, r.rev, f.path), dir, size_gb: f.size_gb, license: r.license || "" }];
    if (kind === "chroma") spec.files.push(...CF.extras.map(x => ({ ...x })));
  }
  const p = CF.params[kind] || {};
  if (kind === "llm") spec.llm = { ctx: +p.ctx || 32768, think: !!p.think, temperature: p.temperature ?? 0.7, system: p.system || "" };
  if (kind === "sdxl" || kind === "chroma") spec.image = { width: +p.width || 1024, height: +p.height || 1024, steps: +p.steps || 30, cfg: +p.cfg || 5, sampler: p.sampler || "euler", scheduler: p.scheduler || "normal", shift: +p.shift || 0, negative: p.negative || "" };
  return spec;
}

async function cmSave() {
  cmSync();
  const spec = cmSpec(), err = $("#cmErr");
  if (!spec || !spec.files.length) { err.textContent = i18n.t("sec_custom_models_select_file"); return; }
  if (!CF.edit) { // a new model never silently replaces an existing one
    const taken = new Set(CM.items.map(x => x.id));
    let id = spec.id || ("custom-" + spec.title), n = 2;
    while (taken.has(id)) id = spec.id.replace(/-\d+$/, "") + "-" + n++;
    spec.id = id;
  }
  const b = $("#cmSave"); b.disabled = true; b.textContent = i18n.t("sec_custom_models_saving"); err.textContent = "";
  try {
    const r = await api("/api/custom-models", { json: spec });
    closeModal();
    toast(CF.edit ? "Cambios guardados" : `Se añadió «${spec.title}»${spec.kind === "comfy" ? " (úsalor en «Generar» al despertar)" : " (selecciónalo en la pestaña IA)"}`);
    await cmRefreshAll();
    return r;
  } catch (e) { err.textContent = e.message; b.disabled = false; b.textContent = CF.edit ? i18n.t("sec_custom_models_save_changes") : i18n.t("sec_custom_models_save_as"); }
}

// the list follows the profile list (settings saved, mode switched, paired, booted)
const _cmLoadProfiles = loadProfiles;
loadProfiles = async function () { await Promise.all([_cmLoadProfiles(), loadCustomModels()]); };

$("#btnCMAdd").onclick = () => cmAdd();
document.addEventListener("click", e => { if (e.target.closest && e.target.closest("#aiAddModel")) cmAdd(); });
