"use strict";
// ---------------- AI page: chat with the profile's LLM, or text-to-image with its checkpoint ----------------
// Relies on app.js globals: $, $$, esc, api, toast, show, page, gst, profiles, jobs, appCfg, KEY, fileURL,
// preview, wake, isLocal, STATE_CN, BUSY.

const AI = { key: "", info: null, infoAt: 0, infoKey: "", busy: null, convs: [], cur: "", pid: "", imgInit: "", galSig: "" };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };

function aiProfiles() { return (profiles && profiles.profiles || []).filter(p => p.ai && p.ai.type); }
// user-added "any model" profiles: no ai block, used through a linked 生成-page template
function aiGenericProfiles() { return (profiles && profiles.profiles || []).filter(p => !p.ai && ((p.workflows || []).length || p.id.startsWith("custom-"))); }
function cmItem(pid) { return typeof CM !== "undefined" ? (CM.items || []).find(x => x.id === pid) : null; }
function aiCurrent() {
  const p = gst && gst.profile && profiles && profiles.profiles && profiles.profiles.find(x => x.id === gst.profile);
  return p && p.ai ? p : null;
}
function aiTplId(pid) { return "ai-" + pid.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""); }

// re-render on every status change (renderStatus runs every second while the GPU is up, so this must stay cheap)
const _aiRS = renderStatus;
renderStatus = function () { _aiRS(); if (page === "ai") aiOnStatus(); };

function aiRender() { AI.key = ""; aiOnStatus(); aiGallery(); }

async function aiOnStatus() {
  const p = aiCurrent();
  const st = gst ? gst.state : "";
  const ready = st === "ready";
  // ask the VM whether the model is loaded (cheap, but not more than every 5 s)
  if (p && ready && (!AI.info || AI.infoKey !== gst.session_started + p.id || (!aiModelReady() && Date.now() - AI.infoAt > 5000))) {
    if (!AI.busyInfo) {
      AI.busyInfo = true; AI.infoAt = Date.now();
      try { AI.info = await api("/api/ai/info"); } catch (e) { AI.info = { error: e.message }; }
      AI.infoKey = gst && (gst.session_started + p.id); AI.busyInfo = false;
    }
  }
  if (!p || !ready) { AI.info = null; AI.infoKey = ""; }
  const key = [st, gst && gst.profile, p && p.id, aiModelReady(), AI.info && AI.info.error, gst ? 1 : 0, profiles ? aiProfiles().length : -1].join("|");
  if (key === AI.key) return;
  AI.key = key;

  // chip
  let chip = "—", cls = "";
  if (!gst) chip = gerr ? i18n.t("state_disconnected") : "—";
  else if (!p) { chip = st === "sleeping" ? i18n.t("ai_chip_gpu_sleeping") : st === "ready" ? i18n.t("ai_chip_flow_mode") : (STATE_CN[st] || st); cls = st === "ready" ? "ok" : ""; }
  else if (BUSY.has(st)) { chip = (p.ai.title || p.title) + " · " + (STATE_CN[st] || st); cls = "busy"; }
  else if (ready && !aiModelReady()) { chip = (p.ai.title || p.title) + (AI.info && AI.info.error ? " · " + i18n.t("ai_chip_not_available") : " · " + i18n.t("ai_chip_loading_model")); cls = AI.info && AI.info.error ? "bad" : "busy"; }
  else if (ready) { chip = (p.ai.title || p.title) + " · " + i18n.t("ai_chip_ready"); cls = "ok"; }
  else chip = STATE_CN[st] || st;
  $("#aiChipText").textContent = chip;
  $("#aiChip").className = "chip ai-chip " + cls;

  const showChat = p && p.ai.type === "llm" && st !== "sleeping" && st !== "failed";
  const showImg = p && p.ai.type === "image" && st !== "sleeping" && st !== "failed";
  $("#aiPick").hidden = !!(showChat || showImg);
  $("#aiChat").hidden = !showChat;
  $("#aiImg").hidden = !showImg;
  if (showChat) aiChatSetup(p);
  else if (showImg) aiImgSetup(p);
  else aiPickRender();
}

function aiModelReady() {
  const p = aiCurrent();
  if (!p || !gst || gst.state !== "ready" || !AI.info || AI.info.error) return false;
  if (p.ai.type === "llm") return !!(AI.info.ready && AI.info.llm_up);
  return AI.info.ready === true;
}

// ---- profile picker ----
const NOVICE_PRESETS = [
  {
    id: "realvisxl-v5",
    icon: "📸",
    badgeKey: "novice_eco_badge",
    badgeType: "eco",
    titleKey: "preset_realvis_title",
    descKey: "preset_realvis_desc",
    title: "Fotografía Ultra-Realista",
    desc: "Retratos de personas, paisajes naturales y fotos con luz natural y estética de lente 85mm.",
    cost: "~2 CU / h (GPU L4 · ~0,20 €/h)",
    type: "image",
    prompts: [
      { label: "📸 Retrato cinematográfico 85mm", text: "cinematic portrait of a person near a window, soft natural lighting, 85mm f/1.4 portrait lens, photorealistic, 8k uhd, film grain, hyperdetailed skin texture" },
      { label: "🏔 Paisaje alpino con lago", text: "breathtaking aerial photography of misty alpine mountains at sunrise, dramatic golden hour light, crystal clear lake reflection, national geographic style, hyperrealistic" },
      { label: "☕ Bodegón café de especialidad", text: "cozy artisan coffee shop aesthetic, steam rising from ceramic cup of latte, warm wooden table, morning sun rays, cinematic lighting, photorealistic" }
    ]
  },
  {
    id: "chroma1-hd",
    icon: "🎨",
    badgeKey: "novice_hi_badge",
    badgeType: "hi",
    titleKey: "preset_chroma_title",
    descKey: "preset_chroma_desc",
    title: "Arte Digital & Ilustración FLUX",
    desc: "Diseño visual, pósters, estética anime, fantasía y escenas futuristas en resolución nativa 1024×1024.",
    cost: "~4 CU / h (GPU G4)",
    type: "image",
    prompts: [
      { label: "🌃 Ciudad Cyberpunk lluviosa", text: "hyperdetailed cyberpunk street market at night during rain, glowing holographic neon signs, wet reflections on asphalt, cinematic atmosphere, 8k resolution" },
      { label: "✨ Bosque mágico estilo Ghibli", text: "gorgeous fantasy anime landscape, ancient floating castle above clouds, lush green meadows, watercolor aesthetic, warm whimsical lighting, Studio Ghibli illustration" },
      { label: "🚀 Póster retrofuturista", text: "minimalist retrofuturistic space exploration poster, vintage color palette, bold geometric shapes, stylish typography, mid-century modern aesthetic" }
    ]
  },
  {
    id: "minimax-h3",
    icon: "🎬",
    badgeKey: "novice_hi_badge",
    badgeType: "hi",
    titleKey: "preset_video_title",
    descKey: "preset_video_desc",
    title: "Vídeo Cinematográfico",
    desc: "Genera planos de vídeo con movimiento de cámara y físicas naturales con MiniMax Hailuo H3.",
    cost: "~4 CU / h (GPU G4)",
    type: "video",
    prompts: [
      { label: "🌊 Cascada sobre arena negra", text: "cinematic drone flight over cascading Icelandic waterfall rushing into black volcanic sand beach, golden hour light, 4k fluid camera movement" },
      { label: "🐆 Guepardo en cámara lenta", text: "slow motion 120fps video of a majestic cheetah running across the savannah at sunset, dust particles in golden backlight, ultra realistic animal movement" },
      { label: "🛰 Nave estelar en el cosmos", text: "slow cinematic camera glide around a futuristic starship approaching an alien ringed planet, realistic nebula lighting in background" }
    ]
  },
  {
    id: "qwen38-27b-chat",
    icon: "💬",
    badgeKey: "novice_hi_badge",
    badgeType: "hi",
    titleKey: "preset_chat_title",
    descKey: "preset_chat_desc",
    title: "Chat & Asistente Creativo",
    desc: "Escribe guiones, idea escenas de vídeo, optimiza prompts y conversa con Qwen 2.5 27B.",
    cost: "~4 CU / h (GPU G4)",
    type: "chat",
    prompts: [
      { label: "✍️ Escribir guion de corto", text: "Escribe la escena de apertura para un cortometraje cinematográfico de suspense y ciencia ficción ambientado en una estación submarina olvidada." },
      { label: "🎯 Optimizar prompts en inglés", text: "Ayúdame a redactar 3 prompts fotográficos hiperrealistas en inglés para generar imágenes con luz de atardecer y lente 85mm." },
      { label: "💡 Idear concepto de campaña", text: "Propón 5 conceptos creativos y disruptivos para una campaña visual de lanzamiento de una marca sostenible de café de especialidad." }
    ]
  }
];

function aiNovicePickRender() {
  const running = gst && gst.state && gst.state !== "sleeping" && gst.state !== "failed";
  const cur = gst && gst.profile && profiles && profiles.profiles && profiles.profiles.find(x => x.id === gst.profile);
  let html = `<div class="novice-wrap">`;
  html += `<div class="sec-h novice-banner"><div><b data-i18n="ai_novice_title">${esc(i18n.t("ai_novice_title"))}</b><div class="d" data-i18n="ai_novice_sub">${esc(i18n.t("ai_novice_sub"))}</div></div></div>`;
  html += `<div class="novice-grid">`;
  for (const item of NOVICE_PRESETS) {
    const isCurrent = running && cur && cur.id === item.id;
    const badgeText = i18n.t(item.badgeKey) || item.badge;
    const titleText = i18n.t(item.titleKey) || item.title;
    const descText = i18n.t(item.descKey) || item.desc;
    const startBtn = isCurrent
      ? `<button class="btn primary sm" data-novice-open="${esc(item.id)}">${item.type === 'video' ? 'Ir a Generar Vídeo' : 'Usar ahora'}</button>`
      : running
      ? `<button class="btn sm" disabled>GPU en uso</button>`
      : `<button class="btn primary sm" data-novice-wake="${esc(item.id)}" data-i18n="novice_btn_start">${esc(i18n.t("novice_btn_start"))}</button>`;

    html += `<div class="novice-card" data-novice-id="${esc(item.id)}">
      <div class="novice-head">
        <span class="novice-icon">${item.icon}</span>
        <span class="novice-badge ${item.badgeType}">${esc(badgeText)}</span>
      </div>
      <h3>${esc(titleText)}</h3>
      <p class="desc">${esc(descText)}</p>
      <div class="novice-lbl" data-i18n="novice_prompts_label">${esc(i18n.t("novice_prompts_label"))}</div>
      <div class="novice-prompts">
        ${item.prompts.map(p => `<button type="button" class="novice-prompt-btn" data-novice-prompt="${esc(p.text)}" data-target-id="${esc(item.id)}" data-target-type="${esc(item.type)}" title="Pulsar para rellenar este prompt y arrancar el modelo">${esc(p.label)}</button>`).join("")}
      </div>
      <div class="novice-foot">
        <span class="cost">${esc(item.cost)}</span>
        ${startBtn}
      </div>
    </div>`;
  }
  html += `</div>`;
  html += `<div class="novice-switch-notice">
    <span data-i18n="novice_switch_tip">${esc(i18n.t("novice_switch_tip"))}</span>
    <button type="button" data-switch-adv data-i18n="novice_btn_switch_adv">${esc(i18n.t("novice_btn_switch_adv"))}</button>
  </div>`;
  html += `</div>`;
  $("#aiPick").innerHTML = html;

  $$("#aiPick [data-novice-wake]").forEach(b => b.onclick = () => aiNoviceLaunch(b.dataset.noviceWake));
  $$("#aiPick [data-novice-open]").forEach(b => b.onclick = () => {
    const id = b.dataset.noviceOpen;
    if (id === "minimax-h3") { show("gen"); }
    else { aiOnStatus(); }
  });
  $$("#aiPick [data-switch-adv]").forEach(b => b.onclick = () => {
    if (typeof setExpMode === "function") setExpMode("advanced");
  });
  $$("#aiPick [data-novice-prompt]").forEach(b => b.onclick = async () => {
    const id = b.dataset.targetId;
    const type = b.dataset.targetType;
    const text = b.dataset.novicePrompt;
    if (type === "image") {
      const s = lsGet("ckwb.ai.img." + id, {});
      s.prompt = text;
      lsSet("ckwb.ai.img." + id, s);
      const prInput = $("#aiPrompt"); if (prInput) prInput.value = text;
    } else if (type === "chat") {
      const txInput = $("#aiText"); if (txInput) txInput.value = text;
    } else if (type === "video") {
      const jt = $("#jobTitle"); if (jt) jt.value = "Vídeo MiniMax H3";
      try {
        const d = lsGet("ckwb.draft." + id, {});
        d.prompt = text;
        lsSet("ckwb.draft." + id, d);
      } catch (e) {}
    }
    await aiNoviceLaunch(id);
    if (type === "video") show("gen");
  });
}

async function aiNoviceLaunch(pid) {
  const p = (profiles && profiles.profiles || []).find(x => x.id === pid);
  if (!p) {
    $("#wakeProfile").value = pid;
    await wake();
    return;
  }
  await aiWake(pid);
}

const AI_ADD_CARD = `<button type="button" class="card ai-card ai-add" id="aiAddModel"><span class="ai-add-plus">＋</span><b>Añadir modelo</b>
  <span class="muted small">Pega un enlace de Hugging Face; detectará tipo, tamaño y recomendará GPU y parámetros</span></button>`;
function aiPickRender() {
  const isSimple = typeof getExpMode === "function" && getExpMode() === "simple";
  if (isSimple) {
    aiNovicePickRender();
    return;
  }
  const list = aiProfiles().concat(aiGenericProfiles());
  const running = gst && gst.state && gst.state !== "sleeping" && gst.state !== "failed";
  const cur = gst && gst.profile && profiles && profiles.profiles && profiles.profiles.find(x => x.id === gst.profile);
  let html = "";
  if (running && cur && !cur.ai) html += profileWorkspaceHTML(cur);
  if (!list.length) {
    html += `<div class="card empty">${isLocal() ? i18n.t("ai_no_profiles") : i18n.t("ai_no_profiles_gateway")}</div>`;
    html += `<div class="ai-cards">${AI_ADD_CARD}</div>`;
  } else {
    html += `<div class="ai-cards">` + list.map(p => {
      const it = cmItem(p.id), problem = it && it.problem;
      const wakeBtn = problem ? `<button class="btn sm" data-cmdel="${esc(p.id)}" data-i18n="ai_delete">Eliminar</button>`
        : running ? `<button class="btn sm" disabled>Detén la GPU actual primero</button>` : `<button class="btn primary sm" data-aiwake="${esc(p.id)}" data-i18n="ai_btn_wake_with">Despertar con este</button>`;
      const bad = problem ? `<p class="err">No disponible: ${esc(problem)}</p>` : "";
      if (!p.ai) { // General
        if ((p.workflows || []).length) {
          const current = running && cur && cur.id === p.id;
          return `<div class="card ai-card"><div class="row between"><span class="pill" data-i18n="ai_flux_title">Flujos oficiales</span><span class="muted small">${current ? "Desplegado actualmente" : `aprox. ${p.size_gb_default ?? "?"} GB`}</span></div><h3>${esc(p.title || p.id)}</h3><p class="muted small">${p.workflows.length} flujos · Usar en ComfyUI</p><p class="small">${esc(workflowLabel((p.workflows || []).find(w => w.id === p.app_default) || {}))}</p><div class="row end">${current ? `<button class="btn primary sm" data-profileworkflows="${esc(p.id)}">Usar modelo actual</button>` : wakeBtn}</div></div>`;
        }
        const tid = it && it.spec && it.spec.template, tpl = (templates || []).find(t => t.id === tid);
        return `<div class="card ai-card"><div class="row between"><span class="pill ${problem ? "bad" : ""}">General</span><span class="muted small mono">aprox. ${p.size_gb_default ?? "?"} GB</span></div>
          <h3>${esc(p.title || p.id)}</h3><p class="muted small">Modelo personalizado · Archivos ComfyUI</p>
          ${problem ? "" : `<p class="small">Tras despertar, úsalo en «Generar» con la plantilla${tpl ? ` «<span class="tpl-link" data-tpl="${esc(tpl.id)}">${esc(tpl.name)}</span>»` : ""}</p>`}
          <p class="muted small">Recomendado: ${esc(p.accelerator || "L4")}</p>${bad}<div class="row end">${wakeBtn}</div></div>`;
      }
      const a = p.ai, llm = a.type === "llm";
      const chroma = !llm && a.image.arch === "chroma";
      const meta = llm ? `Ollama · Contexto ${Math.round((a.llm.ctx || 32768) / 1024)}K` : `${chroma ? "Chroma (FLUX)" : "Punto de control SDXL"} · ${a.image.width}×${a.image.height} · ${a.image.steps} pasos`;
      const gpu = p.id.startsWith("custom-") ? `Recomendado: ${p.accelerator || "L4"}` : llm ? "Recomendado G4 / A100 / H100 (VRAM ≥ 40 GB)" : chroma ? "Recomendado G4 / A100 (VRAM ≥ 32 GB)" : "Cualquier GPU (L4 es suficiente)";
      const btn = wakeBtn;
      return `<div class="card ai-card"><div class="row between"><span class="pill ${problem ? "bad" : llm ? "llm" : "img"}">${llm ? "Chat" : "Imagen"}</span><span class="muted small mono">aprox. ${p.size_gb_default ?? "?"} GB</span></div>
        <h3>${esc(a.title || p.title)}</h3><p class="muted small">${p.id.startsWith("custom-") ? "Modelo personalizado" : esc(p.title)}</p><p class="small">${esc(meta)}</p><p class="muted small">${esc(gpu)}</p>${bad}
        <div class="row end">${btn}</div></div>`;
    }).join("") + AI_ADD_CARD + `</div>`;
  }
  $("#aiPick").innerHTML = html;
  bindProfileWorkspace($("#aiPick"));
  $$("[data-aiwake]").forEach(b => b.onclick = () => aiWake(b.dataset.aiwake));
  $$("#aiPick [data-cmdel]").forEach(b => b.onclick = () => cmDelete(b.dataset.cmdel));
  $$("#aiPick [data-tpl]").forEach(s => s.onclick = () => { show("gen"); selectTpl(s.dataset.tpl); });
}

async function aiWake(pid) {
  const p = (profiles && profiles.profiles || []).find(x => x.id === pid); if (!p) return;
  const acc = p.accelerator || "";
  const accSel = $("#wakeAcc");
  const canAcc = accSel && !accSel.disabled && !$("#accWrap").hidden;
  if (!await appConfirm(`¿Despertar la GPU con «${(p.ai && p.ai.title) || p.title}»?\n\nDescargará aprox. ${p.size_gb_default ?? "?"} GB de modelo${canAcc && acc ? ` en GPU ${acc}` : ""}.`)) return;
  $("#wakeProfile").value = pid;
  $("#wakeProfile").dispatchEvent(new Event("change"));
  if (canAcc && acc && [...accSel.options].some(o => o.value === acc)) accSel.value = acc;
  await wake();
  AI.key = "";
}

// ---- chat ----
function aiConvKey() { return "ckwb.ai.convs." + AI.pid; }
function aiChatSetup(p) {
  const ready = aiModelReady();
  if (AI.pid !== p.id) {
    AI.pid = p.id;
    AI.convs = lsGet(aiConvKey(), []);
    AI.cur = lsGet(aiConvKey() + ".cur", "");
    if (!AI.convs.find(c => c.id === AI.cur)) AI.cur = AI.convs[0] ? AI.convs[0].id : "";
    const s = lsGet("ckwb.ai.chatset." + p.id, null) || { think: p.ai.llm.think !== false, temp: p.ai.llm.temperature ?? 0.7, sys: p.ai.llm.system || "" };
    $("#aiThink").checked = !!s.think; $("#aiTemp").value = s.temp; $("#aiTempV").textContent = (+s.temp).toFixed(2); $("#aiSys").value = s.sys || "";
    $("#aiSys").hidden = !s.sys;
    aiConvList(); aiMsgs();
  }
  $("#aiText").disabled = !ready;
  $("#aiSend").disabled = !ready && !AI.busy;
  $("#aiText").placeholder = ready ? "Escribe un mensaje, Enter para enviar, Shift+Enter para nueva línea" : (AI.info && AI.info.error ? AI.info.error : "Cargando modelo; estará disponible cuando la GPU pase a estado listo y complete la fase «llm»");
}
function aiSaveSet() {
  lsSet("ckwb.ai.chatset." + AI.pid, { think: $("#aiThink").checked, temp: +$("#aiTemp").value, sys: $("#aiSys").value });
}
$("#aiThink").onchange = aiSaveSet;
$("#aiTemp").oninput = () => { $("#aiTempV").textContent = (+$("#aiTemp").value).toFixed(2); aiSaveSet(); };
$("#aiSys").oninput = aiSaveSet;
$("#aiSysBtn").onclick = () => { $("#aiSys").hidden = !$("#aiSys").hidden; if (!$("#aiSys").hidden) $("#aiSys").focus(); };
if ($("#aiApiBtn")) {
  $("#aiApiBtn").onclick = () => {
    const port = location.port || (location.protocol === "https:" ? "443" : "80");
    const baseUrl = `${location.protocol}//${location.hostname}:${port}/v1`;
    const curModel = (AI.info && AI.info.llm && AI.info.llm.name) || (AI.p && AI.p.ai && AI.p.ai.llm && AI.p.ai.llm.name) || "qwen2.5-coder";
    openModal(`<div class="cm" style="max-width:580px;">
      <h3>🔌 Conectar modelo con tu IDE (VS Code / Cursor / Cline)</h3>
      <p class="hint">WakeGPU expone una API compatible con OpenAI para que uses este modelo de Colab directamente en tus extensiones de código favoritas sin gastar cuotas de APIs de pago.</p>
      
      <div style="margin:16px 0;">
        <label class="small muted" style="font-weight:600;display:block;margin-bottom:4px;">Endpoint OpenAI Base URL:</label>
        <div class="row gap"><input class="grow mono small" readonly value="${esc(baseUrl)}" id="aiApiUrl"><button class="btn xs" onclick="navigator.clipboard.writeText('${esc(baseUrl)}');toast('URL copiada');">Copiar</button></div>
      </div>

      <div style="margin:16px 0;">
        <label class="small muted" style="font-weight:600;display:block;margin-bottom:4px;">Nombre del modelo:</label>
        <div class="row gap"><input class="grow mono small" readonly value="${esc(curModel)}" id="aiApiModel"><button class="btn xs" onclick="navigator.clipboard.writeText('${esc(curModel)}');toast('Modelo copiado');">Copiar</button></div>
      </div>

      <div style="margin:16px 0;">
        <label class="small muted" style="font-weight:600;display:block;margin-bottom:4px;">Ejemplo de configuración para Continue.dev (<code>config.json</code>):</label>
        <pre style="background:var(--bg,#090a0f);border:1px solid var(--line,rgba(255,255,255,0.1));border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;" class="mono">{
  "models": [
    {
      "title": "WakeGPU (Colab GPU)",
      "provider": "openai",
      "model": "${esc(curModel)}",
      "apiBase": "${esc(baseUrl)}",
      "apiKey": "wakegpu"
    }
  ]
}</pre>
      </div>

      <div class="muted small" style="margin-top:12px;line-height:1.5;">
        💡 <b>Ahorro Zero-Waste</b>: Cuando termines de programar o estés inactivo, el Guardián de WakeGPU apagará la GPU automáticamente para no gastar Compute Units.
      </div>
      <div style="text-align:right;margin-top:16px;"><button class="btn primary sm" onclick="closeModal()">Entendido</button></div>
    </div>`);
  };
}

function aiSaveConvs() {
  AI.convs = AI.convs.slice(0, 60);
  lsSet(aiConvKey(), AI.convs); lsSet(aiConvKey() + ".cur", AI.cur);
}
function aiConv() { return AI.convs.find(c => c.id === AI.cur); }
function aiConvList() {
  const box = $("#aiConvList");
  box.innerHTML = AI.convs.length ? AI.convs.map(c => `<div class="ai-conv ${c.id === AI.cur ? "on" : ""}" data-cid="${c.id}"><span>${esc(c.title || i18n.t("ai_conv_empty"))}</span><button class="x" data-cdel="${c.id}" title="Eliminar">×</button></div>`).join("")
    : `<p class="muted small ai-conv-empty" data-i18n="ai_no_convs">Aún no hay conversaciones</p>`;
  $$("[data-cid]", box).forEach(el => el.onclick = e => { if (e.target.dataset.cdel) return; if (AI.busy) return; AI.cur = el.dataset.cid; aiSaveConvs(); aiConvList(); aiMsgs(); });
  $$("[data-cdel]", box).forEach(b => b.onclick = async () => {
    if (AI.busy && AI.cur === b.dataset.cdel) return;
    if (!await appConfirm("¿Eliminar esta conversación?")) return;
    AI.convs = AI.convs.filter(c => c.id !== b.dataset.cdel);
    if (AI.cur === b.dataset.cdel) AI.cur = AI.convs[0] ? AI.convs[0].id : "";
    aiSaveConvs(); aiConvList(); aiMsgs();
  });
}
$("#aiNew").onclick = () => { if (AI.busy) return; AI.cur = ""; aiSaveConvs(); aiConvList(); aiMsgs(); $("#aiText").focus(); };

function mdLite(s) {
  const parts = String(s || "").split(/```/);
  return parts.map((p, i) => {
    if (i % 2) { const nl = p.indexOf("\n"); const code = nl >= 0 && /^[\w+-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p; return `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`; }
    return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/^#{1,6} (.+)$/gm, "<b class=\"h\">$1</b>");
  }).join("");
}
function aiMsgHTML(m, i, last) {
  if (m.role === "user") return `<div class="ai-msg user" data-i="${i}"><div class="bubble">${esc(m.content)}</div></div>`;
  const think = m.thinking ? `<details class="ai-think" ${m.streaming && !m.content ? "open" : ""}><summary data-i18n="ai_thinking">Proceso de razonamiento${m.streaming && !m.content ? "…" : ""}</summary><div>${esc(m.thinking)}</div></details>` : "";
  const body = m.error ? `<p class="err">${esc(m.error)}</p>` : `<div class="md">${mdLite(m.content)}${m.streaming ? '<span class="caret"></span>' : ""}</div>`;
  const acts = m.streaming ? "" : `<div class="ai-acts"><button class="btn ghost xs" data-ma="copy" data-i="${i}" data-i18n="ai_copy">Copiar</button><button class="btn ghost xs" data-ma="use" data-i="${i}" data-i18n="ai_use_as_prompt">Usar como prompt</button>${last ? `<button class="btn ghost xs" data-ma="again" data-i="${i}">Reintentar</button>` : ""}<span class="muted small mono">${esc(m.stats || "")}</span></div>`;
  return `<div class="ai-msg bot" data-i="${i}">${think}${body}${acts}</div>`;
}
function aiMsgs() {
  const c = aiConv(), box = $("#aiMsgs");
  if (!c || !c.msgs.length) {
    box.innerHTML = `<div class="ai-hello"><b>${esc((aiCurrent() && (aiCurrent().ai.title || aiCurrent().title)) || i18n.t("ai_chat_title"))}</b><p class="muted small">El modelo se ejecuta en tu GPU de Colab y las conversaciones se guardan en este Mac.</p></div>`;
    return;
  }
  box.innerHTML = c.msgs.map((m, i) => aiMsgHTML(m, i, i === c.msgs.length - 1)).join("");
  $$("[data-ma]", box).forEach(b => b.onclick = () => aiMsgAct(b.dataset.ma, +b.dataset.i));
  box.scrollTop = box.scrollHeight;
}
function aiUpdateLast() {
  const c = aiConv(); if (!c) return;
  const i = c.msgs.length - 1, box = $("#aiMsgs");
  const el = box.querySelector(`.ai-msg[data-i="${i}"]`);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const tmp = document.createElement("div"); tmp.innerHTML = aiMsgHTML(c.msgs[i], i, true);
  const fresh = tmp.firstChild;
  // keep the user's open/closed choice on the thinking block
  const oldD = el && el.querySelector("details"), newD = fresh.querySelector("details");
  if (oldD && newD && oldD.dataset.touched) { newD.open = oldD.open; newD.dataset.touched = "1"; }
  if (el) el.replaceWith(fresh); else box.appendChild(fresh);
  const d = fresh.querySelector("details"); if (d) d.addEventListener("toggle", () => d.dataset.touched = "1", { once: true });
  $$("[data-ma]", fresh).forEach(b => b.onclick = () => aiMsgAct(b.dataset.ma, +b.dataset.i));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function aiMsgAct(act, i) {
  const c = aiConv(); if (!c) return; const m = c.msgs[i]; if (!m) return;
  if (act === "copy") { try { await navigator.clipboard.writeText(m.content); toast("Copiado al portapapeles"); } catch { toast("Error al copiar"); } }
  if (act === "use") aiUseAsPrompt(m.content);
  if (act === "again") { if (AI.busy) return; c.msgs.splice(i, 1); aiSaveConvs(); aiMsgs(); aiStream(c); }
}
function aiUseAsPrompt(text) {
  show("gen");
  setTimeout(() => {
    const ta = $$("#primaryFields textarea").find(t => !/negative|negativo|反向/i.test(t.closest(".fld") ? t.closest(".fld").textContent : ""));
    if (!ta) { navigator.clipboard && navigator.clipboard.writeText(text); toast("Selecciona una plantilla a la izquierda; el texto se ha copiado al portapapeles"); return; }
    ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
    toast("Prompt insertado");
  }, 60);
}

$("#aiText").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); aiSend(); }
});
$("#aiSend").onclick = () => AI.busy ? AI.busy.abort() : aiSend();

function aiSend() {
  const text = $("#aiText").value.trim();
  if (!text || AI.busy || !aiModelReady()) return;
  let c = aiConv();
  if (!c) { c = { id: Date.now().toString(36), title: text.slice(0, 24), msgs: [], created: Date.now() }; AI.convs.unshift(c); AI.cur = c.id; }
  c.msgs.push({ role: "user", content: text });
  $("#aiText").value = "";
  aiSaveConvs(); aiConvList(); aiMsgs();
  aiStream(c);
}

async function aiStream(c) {
  const p = aiCurrent(); if (!p) return;
  const msgs = [];
  const sys = $("#aiSys").value.trim();
  if (sys) msgs.push({ role: "system", content: sys });
  for (const m of c.msgs) if (!m.error) msgs.push({ role: m.role, content: m.content });
  const bot = { role: "assistant", content: "", thinking: "", streaming: true };
  c.msgs.push(bot); aiMsgs();
  const ctl = new AbortController(); AI.busy = ctl;
  $("#aiSend").textContent = "Detener"; $("#aiSend").disabled = false;
  const t0 = performance.now();
  let raf = 0; const paint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (AI.cur === c.id) aiUpdateLast(); }); };
  try {
    const r = await fetch("/api/ai/chat", {
      method: "POST", signal: ctl.signal, headers: { "X-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: p.ai.llm.name, messages: msgs, think: $("#aiThink").checked, temperature: +$("#aiTemp").value })
    });
    if (!r.ok) { let e = "HTTP " + r.status; try { e = (await r.json()).error || e; } catch { } throw new Error(e); }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (; ;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.error) throw new Error(d.error);
        const m = d.message || {};
        if (m.thinking) bot.thinking += m.thinking;
        if (m.content) bot.content += m.content;
        if (d.done) {
          if (typeof obMark === "function") obMark("generate"); // first chat counts for the checklist
          const tps = d.eval_count && d.eval_duration ? (d.eval_count / (d.eval_duration / 1e9)).toFixed(1) : "";
          bot.stats = `${d.eval_count || 0} tokens${tps ? " · " + tps + " tok/s" : ""} · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
        }
        paint();
      }
    }
    // models that don't separate their reasoning: pull <think>…</think> out of the text
    const mt = bot.content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
    if (mt) { bot.thinking += mt[1]; bot.content = bot.content.slice(mt[0].length); }
    if (!bot.content && !bot.thinking) bot.error = "El modelo no devolvió ningún contenido";
  } catch (e) {
    if (e.name === "AbortError") bot.stats = "Detenido";
    else bot.error = "Error: " + e.message;
  } finally {
    bot.streaming = false; AI.busy = null;
    $("#aiSend").textContent = "Enviar";
    if (c.title === "" || !c.title) c.title = (c.msgs[0] && c.msgs[0].content || "").slice(0, 24);
    aiSaveConvs();
    if (AI.cur === c.id) aiMsgs();
    $("#aiStats").textContent = bot.stats || "";
    AI.key = ""; aiOnStatus();
  }
}

// ---- text to image ----
function aiImgKey() { return "ckwb.ai.img." + AI.pid; }
function aiImgSetup(p) {
  const im = p.ai.image;
  if (AI.imgInit !== p.id) {
    AI.imgInit = p.id; AI.pid = p.id;
    const s = lsGet(aiImgKey(), {});
    $("#aiPrompt").value = s.prompt || "";
    $("#aiNeg").value = s.neg ?? (im.negative || "");
    $("#aiW").value = s.w || im.width; $("#aiH").value = s.h || im.height;
    $("#aiSteps").value = s.steps || im.steps; $("#aiCfg").value = s.cfg || im.cfg;
    $("#aiCount").value = s.count || 1; $("#aiSeed").value = s.seed ?? "";
    aiSizeSync();
    AI.galSig = ""; aiGallery();
  }
  const isAdv = typeof getExpMode === "function" && getExpMode() === "advanced";
  const advDetails = $("#aiAdvDetails");
  if (advDetails) advDetails.open = isAdv;

  if (!aiImgSetup._chipsWired) {
    aiImgSetup._chipsWired = true;
    $$("#aiQuickChips .chip-btn").forEach(btn => {
      btn.onclick = () => {
        const add = btn.dataset.add;
        const cur = $("#aiPrompt").value.trim();
        $("#aiPrompt").value = cur ? cur + ", " + add : add;
        aiImgSave();
        $("#aiPrompt").focus();
      };
    });
  }

  const ready = aiModelReady();
  $("#aiGen").disabled = false;
  $("#aiImgHint").textContent = ready ? `Modelo: ${im.checkpoint || im.unet_name} · ${im.sampler} / ${im.scheduler}` : "La GPU aún no está lista: se añadirá a la cola y comenzará en cuanto esté disponible.";
}
function aiImgSave() {
  lsSet(aiImgKey(), { prompt: $("#aiPrompt").value, neg: $("#aiNeg").value, w: +$("#aiW").value, h: +$("#aiH").value, steps: +$("#aiSteps").value, cfg: +$("#aiCfg").value, count: +$("#aiCount").value, seed: $("#aiSeed").value });
}
function aiSizeSync() {
  const s = $("#aiW").value + "x" + $("#aiH").value;
  const preset = $$("#aiSize button").find(b => b.dataset.s === s);
  $$("#aiSize button").forEach(b => b.classList.toggle("on", preset ? b === preset : b.dataset.s === "custom"));
  $("#aiWH").hidden = !!preset && !AI.customSize;
}
$$("#aiSize button").forEach(b => b.onclick = () => {
  if (b.dataset.s === "custom") { AI.customSize = true; $("#aiWH").hidden = false; $$("#aiSize button").forEach(x => x.classList.toggle("on", x === b)); return; }
  AI.customSize = false;
  const [w, h] = b.dataset.s.split("x"); $("#aiW").value = w; $("#aiH").value = h; aiSizeSync(); aiImgSave();
});
["#aiPrompt", "#aiNeg", "#aiW", "#aiH", "#aiSteps", "#aiCfg", "#aiCount", "#aiSeed"].forEach(s => $(s).addEventListener("input", aiImgSave));
$("#aiPrompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiGenerate(); } });
$("#aiGen").onclick = aiGenerate;

async function aiGenerate() {
  const p = aiCurrent(); if (!p || p.ai.type !== "image") return;
  const prompt = $("#aiPrompt").value.trim();
  $("#aiErr").textContent = "";
  if (!prompt) { $("#aiErr").textContent = i18n.t("ai_err_write_prompt"); return; }
  const im = p.ai.image;
  const w = Math.round((+$("#aiW").value || im.width) / 16) * 16, h = Math.round((+$("#aiH").value || im.height) / 16) * 16;
  $("#aiGen").disabled = true;
  try {
    const t = await api("/api/ai/image-template", { json: { profile: p.id, title: p.ai.title || p.title, ...im } });
    const K = t.keys || {};
    const seed = $("#aiSeed").value.trim();
    const values = {
      [K.prompt]: prompt, [K.negative]: $("#aiNeg").value, [K.width]: w, [K.height]: h,
      [K.steps]: +$("#aiSteps").value || im.steps, [K.cfg]: +$("#aiCfg").value || im.cfg, [K.seed]: seed ? +seed : 0
    };
    const fd = new FormData();
    fd.append("spec", JSON.stringify({ template_id: t.id, values, random_seeds: seed ? [] : [K.seed], title: "Generación IA " + prompt.slice(0, 20), count: Math.max(1, Math.min(20, +$("#aiCount").value || 1)) }));
    const r = await api("/api/jobs", { method: "POST", body: fd });
    toast(i18n.t("ai_toast_added", { n: r.ids.length }));
    loadJobs();
  } catch (e) { $("#aiErr").textContent = i18n.t("ai_err_send", { err: e.message }); }
  finally { $("#aiGen").disabled = false; }
}

function aiGallery() {
  const p = aiCurrent(); const box = $("#aiGallery"); if (!box) return;
  if (!p || p.ai.type !== "image") return;
  const tid = aiTplId(p.id);
  const mine = (jobs || []).filter(j => j.template_id === tid).slice(0, 30);
  const sig = JSON.stringify(mine.map(j => [j.id, j.status, Math.round((j.progress || 0) * 20), (j.outputs || []).length]));
  if (sig === AI.galSig) return;
  AI.galSig = sig;
  if (!mine.length) { box.innerHTML = `<div class="ai-gal-empty muted small" data-i18n="ai_gallery_empty">Las imágenes generadas aparecen aquí</div>`; return; }
  const items = [];
  for (const j of mine) {
    const imgs = (j.outputs || []).filter(o => o.kind === "image");
    if (j.status === "done" && imgs.length) imgs.forEach(o => items.push(`<button class="ai-tile" data-path="${esc(o.path)}" title="${esc(j.title)}"><img loading="lazy" src="${fileURL(o.path)}"></button>`));
    else if (j.status === "failed" || j.status === "canceled") items.push(`<div class="ai-tile st bad" title="${esc(j.message || "")}"><span>${j.status === "failed" ? i18n.t("ai_status_failed") : i18n.t("ai_status_canceled")}</span><small>${esc((j.message || "").slice(0, 60))}</small></div>`);
    else if (j.status !== "done") items.push(`<div class="ai-tile st"><span>${esc((JST && JST[j.status]) || j.status)}</span>${j.status === "running" ? `<div class="mini"><div style="width:${Math.round((j.progress || 0) * 100)}%"></div></div>` : ""}</div>`);
  }
  box.innerHTML = items.join("");
  $$("[data-path]", box).forEach(b => b.onclick = () => preview(b.dataset.path, "image"));
}
