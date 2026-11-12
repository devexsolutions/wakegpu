"use strict";

function workflowLabel(w) {
  const names = {
    "qwen21-turbo-t2i": i18n.t("qwen_turbo_t2i"),
    "qwen21-t2i": i18n.t("qwen_t2i"),
    "qwen21-turbo-edit": i18n.t("qwen_turbo_edit"),
    "qwen21-edit": i18n.t("qwen_edit")
  };
  return names[w.id] || w.title || w.id || i18n.t("wf_default");
}
function templateProfileMismatch(t) {
  if (!t || !gst || gst.state !== "ready" || !gst.profile) return "";
  const required = t.profile || (t.id.startsWith("ai-") ? t.id.slice(3) : "");
  if (!required || required === gst.profile) return "";
  const p = (profiles && profiles.profiles || []).find(p => p.id === gst.profile);
  return i18n.t("ai_profile_mismatch", { current: p ? p.title : gst.profile, required });
}
function profileWorkspaceHTML(p) {
  const ready = gst && gst.state === "ready" && gst.profile === p.id;
  return `<div class="card profile-workspace"><div class="profile-workspace-head"><div><span class="pill ${ready ? "img" : ""}">${ready ? i18n.t("ai_model_ready") : i18n.t("ai_workflow_mode")}</span><h3>${esc(p.title || p.id)}</h3><p class="muted small">Este perfil utiliza flujos completos de ComfyUI sin necesidad de cambiar de modelo. Abre ComfyUI para empezar; el flujo predeterminado ya estará cargado.</p></div><button type="button" class="btn primary" data-workspace-open ${ready ? "" : "disabled"} data-i18n="ai_flux_btn_open">Abrir en ComfyUI ↗</button></div><div class="profile-workflow-list">${(p.workflows || []).map(w => `<div class="profile-workflow-row"><div><b>${esc(workflowLabel(w))}</b><span class="muted small">${esc(w.id)}.json${w.id === p.app_default ? " · " + i18n.t("ai_flux_default_wf").replace("{id}", "") : " · " + i18n.t("ai_flux_extra_models")}</span></div>${w.embedded ? `<a class="btn sm" data-wf-dl="${esc(w.id)}.json" download href="/api/profile-workflows/${encodeURIComponent(p.id)}/${encodeURIComponent(w.id)}?k=${encodeURIComponent(KEY)}" data-i18n="ai_flux_download">Descargar flujo</a>` : ""}</div>`).join("")}</div><p class="hint" data-i18n="ai_flux_hint">Abre el flujo por su nombre en el panel izquierdo «Workflows» de ComfyUI. Si no aparece, descarga el JSON de arriba y arrástralo a la ventana de ComfyUI. Para usar la cola de tareas de WakeGPU, exporta el formato API desde ComfyUI e impórtalo abajo.</p></div>`;
}
function bindProfileWorkspace(root) {
  $$('[data-workspace-open]', root).forEach(b => b.onclick = async () => { try { await api('/api/open-url', { json: { url: 'comfy' } }); } catch (e) { toast(e.message); } });
  $$('[data-profileworkflows]', root).forEach(b => b.onclick = () => { show('gen'); renderProfileWorkspace(); $('#profileWorkspace').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  $$('[data-wf-dl]', root).forEach(a => a.onclick = async e => {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.saveFile) {
      e.preventDefault();
      try {
        const res = await fetch(a.href);
        const text = await res.text();
        window.webkit.messageHandlers.saveFile.postMessage({ filename: a.dataset.wfDl || 'workflow.json', content: text });
      } catch (err) { toast(err.message); }
    }
  });
}
let profileWorkspaceKey = "";
function renderProfileWorkspace() {
  const box = $('#profileWorkspace');
  const p = (profiles && profiles.profiles || []).find(p => gst && gst.profile === p.id);
  const visible = p && !p.ai && (p.workflows || []).length && gst.state !== 'sleeping' && gst.state !== 'failed';
  box.hidden = !visible;
  const mismatch = templateProfileMismatch(curTpl);
  const submit = $('#genForm button[type=submit]');
  if (mismatch) { submit.disabled = true; submit.dataset.profileMismatch = '1'; }
  else if (submit.dataset.profileMismatch) { submit.disabled = false; delete submit.dataset.profileMismatch; }
  const signature = JSON.stringify([visible && p, gst && gst.state, mismatch]);
  if (signature === profileWorkspaceKey) return;
  profileWorkspaceKey = signature;
  box.innerHTML = visible ? profileWorkspaceHTML(p) + (mismatch ? `<p class="warn-note">${esc(mismatch)}</p>` : '') : '';
  bindProfileWorkspace(box);
}
const _workspaceRenderStatus = renderStatus;
renderStatus = function () { _workspaceRenderStatus(); renderProfileWorkspace(); };
const _workspaceShow = show;
show = function (p) { _workspaceShow(p); if (p === 'gen') renderProfileWorkspace(); };
const _workspaceSelectTpl = selectTpl;
selectTpl = function (...args) { _workspaceSelectTpl(...args); renderProfileWorkspace(); };
