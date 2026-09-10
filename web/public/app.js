const app = document.querySelector("#app");
const runStrip = document.querySelector("#run-strip");
const restartButton = document.querySelector("#restart-button");
const toast = document.querySelector("#toast");
const confirmDialog = document.querySelector("#confirm-dialog");
const cancelRestart = document.querySelector("#cancel-restart");
const confirmRestart = document.querySelector("#confirm-restart");

let config = null;
let run = null;
let season = null;
let setupFormation = "4-3-3";
let setupPlaystyleOptions = [];
let setupPlaystyleId = null;
let fetchingCandidates = false;
let lineupState = null;
let selectedPlayerId = null;
let selectedCandidateId = null;
let lineupSaveQueue = Promise.resolve();
let toastTimer = null;
let seasonTimer = null;
let seasonAutoPlay = true;
let seasonAdvancing = false;
let winterWindowEntered = false;
let selectedWinterSlotId = null;
let pointerDragState = null;
let nativeDragActive = false;
let dragPreviewElement = null;
let dragPointerY = null;
let dragAutoScrollFrame = null;
let suppressSlotClick = false;
let wheelSpin = null;
let wheelSpinTimer = null;
let candidatePickPending = false;
let pvpRoom = null;
let pvpCodeValue = sessionStorage.getItem("fm26-pvp-code") || "";
let pvpToken = sessionStorage.getItem("fm26-pvp-token") || "";
let pvpPollTimer = null;
let pvpPlaybackFrame = null;
let pvpReplayFrame = null;
let pvpLastPlaybackEventIndex = -1;
let pvpLastGoalEventId = null;
let pvpGoalTimer = null;

document.addEventListener("pointerup", (event) => {
  completePointerDrop(event);
  stopPageDragScroll();
  setTimeout(() => { pointerDragState = null; }, 0);
});
document.addEventListener("pointercancel", () => {
  pointerDragState = null;
  stopPageDragScroll();
});
document.addEventListener("pointermove", (event) => {
  if (pointerDragState && pointerMoved(event)) updatePageDragScroll(event.clientY);
});
document.addEventListener("dragover", (event) => {
  if (nativeDragActive) updatePageDragScroll(event.clientY);
});
document.addEventListener("dragend", stopPageDragScroll);
document.addEventListener("drop", stopPageDragScroll);

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `请求失败（${response.status}）`);
  return payload;
}

async function pvpApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { "x-pvp-token": pvpToken, ...(options.headers ?? {}) }
  });
}

function showToast(message, type = "normal") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function setBusy(button, busy, label = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText ?? button.textContent;
    button.disabled = false;
  }
}

function updateTopbar() {
  const active = Boolean(run || pvpRoom);
  restartButton.hidden = !active;
  runStrip.hidden = !active;
  if (!active) return;
  if (pvpRoom) {
    runStrip.innerHTML = `<span class="run-chip"><b>PVP ${escapeHtml(pvpRoom.code)}</b></span><span class="run-chip">${escapeHtml(pvpRoom.side === "host" ? "房主" : "客人")}</span>`;
    return;
  }
  const phase = run.status === "completed"
    ? "赛季完成"
    : run.status === "simulating"
      ? "赛季进行中"
    : run.status === "ready"
      ? "待开赛"
      : "选秀与排阵";
  runStrip.innerHTML = `
    <span class="run-chip"><b>${escapeHtml(run.replacedClub.displayName)}</b> 席位</span>
    <span class="run-chip">${phase}</span>
  `;
}

function render() {
  updateTopbar();
  if (pvpRoom) return renderPvp();
  if (!run) return renderSetup();
  if (run.status === "completed") return renderResults();
  if (run.status === "simulating") return renderSeasonLive();
  if (run.status === "ready") return renderReady();
  return renderDraft();
}

function formationCoordinates(formation) {
  const rows = new Map();
  formation.slots.forEach((position, index) => {
    let y = 50;
    if (position === "GK") y = 91;
    else if (["LB", "LWB", "CB", "RB", "RWB"].includes(position)) y = 76;
    else if (position === "CDM") y = 61;
    else if (["CM", "LM", "RM"].includes(position)) y = 45;
    else if (position === "CAM") y = 30;
    else if (["LW", "RW", "ST"].includes(position)) y = 14;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(index);
  });
  const coordinates = [];
  for (const [y, indexes] of rows) {
    const left = indexes.filter((slotIndex) => ["LB", "LWB", "LM", "LW"].includes(formation.slots[slotIndex]));
    const right = indexes.filter((slotIndex) => ["RB", "RWB", "RM", "RW"].includes(formation.slots[slotIndex]));
    const central = indexes.filter((slotIndex) => !left.includes(slotIndex) && !right.includes(slotIndex));
    left.forEach((slotIndex, index) => { coordinates[slotIndex] = { x: 18 + index * 10, y }; });
    right.forEach((slotIndex, index) => { coordinates[slotIndex] = { x: 82 - (right.length - 1 - index) * 10, y }; });
    central.forEach((slotIndex, index) => {
      coordinates[slotIndex] = { x: 50 + (index - (central.length - 1) / 2) * 22, y };
    });
  }
  return coordinates;
}

function setupPitchHtml(formation) {
  const coordinates = formationCoordinates(formation);
  return formation.slots.map((position, index) => `
    <span class="preview-position" style="--x:${coordinates[index].x}%;--y:${coordinates[index].y}%">
      ${escapeHtml(position)}
    </span>
  `).join("");
}

function ensureSetupPlaystyles() {
  if (setupPlaystyleOptions.length || !config?.draftPlaystyles?.length) return;
  const shuffled = [...config.draftPlaystyles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  setupPlaystyleOptions = shuffled.slice(0, 3).map((playstyle) => playstyle.id);
}

function renderSetup() {
  ensureSetupPlaystyles();
  const activeFormation = config.formations.find((formation) => formation.id === setupFormation);
  const formationCards = config.formations.map((formation) => `
    <button class="formation-choice ${formation.id === setupFormation ? "selected" : ""}" data-formation="${formation.id}" type="button">${formation.id}</button>
  `).join("");
  const playstyleCards = setupPlaystyleOptions.map((playstyleId) => {
    const playstyle = config.draftPlaystyles.find((item) => item.id === playstyleId);
    return `<button class="playstyle-choice ${playstyleId === setupPlaystyleId ? "selected" : ""}" data-playstyle="${escapeHtml(playstyleId)}" type="button"><span>${escapeHtml(playstyle.name)}</span><b>${escapeHtml(playstyle.tagline)}</b><small>${playstyle.demands.map(escapeHtml).join(" · ")}</small></button>`;
  }).join("");
  app.innerHTML = `
    <section class="setup-shell">
      <header class="setup-title"><p class="eyebrow">Fantasy draft · 2025/26 Premier League</p><h1>选阵型，组建你的梦幻球队</h1><p>只选11人，全部放入合法位置即可开赛。</p></header>
      <div class="setup-grid">
        <section class="setup-controls">
          <div class="compact-section"><label>阵型</label><div class="formation-choices">${formationCards}</div></div>
          <div class="compact-section playstyle-section"><label>本局球队风格 <small>随机出现 3 种，选择后锁定</small></label><div class="playstyle-choices">${playstyleCards}</div></div>
          <div class="setup-note"><b>随机池券选秀</b><span>每轮随机获得传奇池、球星池或球员池池券，再从对应候选中选择一人并直接放入阵容。</span></div>
          <div class="setup-note"><b>38轮英超</b><span>随机替代25–26赛季的一支英超球队，对阵其余19队；逐场展示赛况。</span></div>
          <button id="create-run" class="primary-button setup-start" type="button" ${setupPlaystyleId ? "" : "disabled"}>${setupPlaystyleId ? "以此风格开始选秀" : "先选择球队风格"}</button>
          <div class="pvp-entry">
            <button id="create-pvp" class="secondary-button" type="button">创建PVP房间</button>
            <div><input id="pvp-code-input" maxlength="6" autocomplete="off" placeholder="输入6位房间码"><button id="join-pvp" class="secondary-button" type="button">加入</button></div>
          </div>
        </section>
        <section class="setup-preview-panel">
          <div class="preview-heading"><span>阵型预览</span><b>${escapeHtml(activeFormation.id)}</b></div>
          <div class="formation-preview-pitch">${setupPitchHtml(activeFormation)}</div>
        </section>
      </div>
    </section>
  `;

  app.querySelectorAll("[data-formation]").forEach((button) => {
    button.addEventListener("click", () => { setupFormation = button.dataset.formation; renderSetup(); });
  });
  app.querySelectorAll("[data-playstyle]").forEach((button) => {
    button.addEventListener("click", () => { setupPlaystyleId = button.dataset.playstyle; renderSetup(); });
  });
  app.querySelector("#create-run").addEventListener("click", createRun);
  app.querySelector("#create-pvp").addEventListener("click", createPvpRoom);
  app.querySelector("#join-pvp").addEventListener("click", joinPvpRoom);
}

function savePvpIdentity(token, code) {
  pvpToken = token;
  pvpCodeValue = code;
  sessionStorage.setItem("fm26-pvp-token", token);
  sessionStorage.setItem("fm26-pvp-code", code);
}

async function createPvpRoom(event) {
  setBusy(event.currentTarget, true, "创建中…");
  try {
    const result = await api("/api/pvp/rooms", { method: "POST", body: JSON.stringify({ formationId: setupFormation }) });
    savePvpIdentity(result.token, result.room.code);
    pvpRoom = result.room;
    run = null;
    render();
    window.scrollTo(0, 0);
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

async function joinPvpRoom(event) {
  const input = app.querySelector("#pvp-code-input");
  const code = String(input.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showToast("请输入6位房间码", "error");
  setBusy(event.currentTarget, true, "加入中…");
  try {
    const result = await api(`/api/pvp/rooms/${code}/join`, { method: "POST", body: "{}" });
    savePvpIdentity(result.token, result.room.code);
    pvpRoom = result.room;
    run = null;
    render();
    window.scrollTo(0, 0);
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

async function createRun(event) {
  const button = event.currentTarget;
  setBusy(button, true, "正在创建…");
  try {
    run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ formationId: setupFormation, playstyleId: setupPlaystyleId })
    });
    localStorage.setItem("fm26-run-id", run.runId);
    lineupState = hydrateLineupState(run.draftLineup);
    render();
    window.scrollTo(0, 0);
    showToast(`你将替代${run.replacedClub.displayName}的联赛席位`);
  } catch (error) {
    showToast(error.message, "error");
    setBusy(button, false);
  }
}

function buildStatusHtml() {
  const analysis = run?.buildAnalysis;
  if (!analysis) return "";
  const abilities = analysis.signals?.length
    ? analysis.signals.map((signal) => `<span class="ability-${escapeHtml(signal.tone)}"><small>${escapeHtml(signal.label)}</small><b>${escapeHtml(signal.level)}</b></span>`).join("")
    : '<p>选入球员后查看阵容特点</p>';
  return `<section class="build-status"><div class="build-status-head"><div><small>${escapeHtml(analysis.playstyle.name)}</small><b>阵容特点 · ${escapeHtml(analysis.fitLabel)}</b></div><em>${analysis.coreFits} 人适合这套打法</em></div><div class="build-abilities">${abilities}</div></section>`;
}

function renderDraft() {
  if (run.legacyRules) {
    app.innerHTML = `<section class="empty-state"><b>旧版预算存档不能继续</b><span>玩法已改为11轮随机池券，旧存档不会被删除。请点击右上角“重新开始”创建新局。</span></section>`;
    return;
  }
  if (!lineupState) lineupState = hydrateLineupState(run.draftLineup);
  const formation = config.formations.find((item) => item.id === run.formationId);
  const coordinates = formationCoordinates(formation);
  const starterSlots = run.formationSlots.map((slot, index) => slotHtml("starter", slot.slotId, slot.position, slot.label, lineupState.starters[slot.slotId], coordinates[index])).join("");
  const starterCount = Object.values(lineupState.starters).filter(Boolean).length;
  const complete = starterCount === 11 && run.squad.length === config.draft.maxSquadSize;
  const hasCandidates = run.currentCandidates.length > 0;
  const isSpinning = Boolean(wheelSpin);
  const draftFinished = run.squad.length >= config.draft.maxSquadSize;
  const legacySquad = run.squad.length > config.draft.maxSquadSize;
  const candidates = run.currentCandidates.length
    ? `<div class="candidate-grid candidate-list">${run.currentCandidates.map(playerCard).join("")}</div>`
    : `<div class="empty-state draft-empty"><b>${fetchingCandidates ? "正在揭晓池券并抽取候选…" : legacySquad ? `旧版存档含${run.squad.length}人` : `第${run.draftRound}轮尚未揭晓`}</b><span>${legacySquad ? "当前规则固定11人，请点击右上角“重新开始”创建新局" : "点击按钮随机揭晓本轮池券；每轮候选必定能填补至少一个空缺位置"}</span></div>`;
  const voucherLabel = run.currentVoucher?.label || "尚未揭晓";
  const wheel = voucherWheelHtml();
  const draftControls = complete
    ? `<section class="draft-ready-panel">
        <div class="draft-ready-copy"><p class="eyebrow">${pvpRoom ? "PVP READY" : "Season ready"}</p><h2>阵容完成，准备开踢</h2><span>${pvpRoom ? "锁定阵容和战术后等待对手，双方共同进入球场才会开球。" : "开始后逐轮结算38轮比赛，第19轮结束后可以决定是否进行一次冬窗交换。"}</span></div>
        ${run.playstyle ? `<div class="locked-playstyle"><small>已锁定风格</small><b>${escapeHtml(run.playstyle.name)}</b></div>` : `<div class="field"><label for="tactic-select">赛季战术</label><select id="tactic-select">${config.tactics.map((tactic) => `<option value="${tactic.id}" ${tactic.id === lineupState.tacticId ? "selected" : ""}>${escapeHtml(tactic.name)}</option>`).join("")}</select></div>`}
        <div class="chemistry-score">队内默契 <b>${chemistryPreview()} / 22</b></div>
        <button id="start-season" class="primary-button" type="button">${pvpRoom ? "准备比赛" : "开始赛季"}</button>
      </section>`
    : `<section class="draft-toolbar">
        <div class="draft-instruction"><b>${hasCandidates ? `第${run.currentVoucher.round}轮：${escapeHtml(run.currentVoucher.label)}` : `第${run.draftRound}轮随机池券`}</b><span>${hasCandidates ? "本轮必须选择一名并放入阵容，不能更换候选" : "本局池券数量已在上方公开，后续顺序仍然随机"}</span></div>
        <button id="next-candidates" class="primary-button" type="button" ${fetchingCandidates || isSpinning || hasCandidates || draftFinished ? "disabled" : ""}>开始转轮</button>
      </section>
      ${candidates}`;

  app.innerHTML = `
    <header class="phase-header compact-phase-header">
      <div><p class="eyebrow">Draft room</p><h1>挑选球员，组建阵容</h1><p>${run.formationId}${run.playstyle ? ` · ${escapeHtml(run.playstyle.name)}` : ""} · 只选11人，可把候选直接拖入阵容位置</p></div>
      <div class="metric-row">
        <div class="metric"><small>已选 / 上限</small><b class="lime">${run.squad.length} / ${config.draft.maxSquadSize}</b></div>
        <div class="metric"><small>本轮池券</small><b class="gold">${escapeHtml(voucherLabel)}</b></div>
      </div>
    </header>
    <div class="draft-workspace">
      <section class="draft-lineup-column">
        <section class="pitch-panel">
          <header class="panel-head"><h2>我的阵容</h2><span>拖放或点选球员</span></header>
          ${buildStatusHtml()}
          <div class="pitch compact-pitch">${starterSlots}</div>
        </section>
      </section>
      <aside class="draft-selection-column">
        ${wheel}
        ${draftControls}
      </aside>
    </div>
    <dialog id="player-detail-dialog" class="player-detail-dialog"></dialog>
  `;
  const selectedCandidate = run.currentCandidates.find((player) => player.id === selectedCandidateId);
  if (selectedCandidate) {
    const compatibleEmptySlots = new Set(run.formationSlots.filter((slot) => (
      !lineupState.starters[slot.slotId]
      && playerPositions(selectedCandidate).includes(slot.position)
      && (!selectedCandidate.compatibleSlotIds?.length || selectedCandidate.compatibleSlotIds.includes(slot.slotId))
    )).map((slot) => slot.slotId));
    app.querySelectorAll("[data-slot-id]").forEach((slot) => {
      if (compatibleEmptySlots.has(slot.dataset.slotId)) slot.classList.add("selected-target");
    });
  }
  app.querySelector("#next-candidates")?.addEventListener("click", fetchCandidates);
  app.querySelectorAll("[data-candidate-card]").forEach((card) => card.addEventListener("click", (event) => {
    if (event.target.closest("button[data-place-candidate]")) return;
    selectedCandidateId = selectedCandidateId === card.dataset.candidateCard ? null : card.dataset.candidateCard;
    renderDraft();
  }));
  app.querySelectorAll("[data-candidate-card]").forEach((card) => card.addEventListener("dragstart", (event) => {
    nativeDragActive = true;
    const playerId = card.dataset.candidateCard;
    const player = run.currentCandidates.find((candidate) => candidate.id === playerId);
    event.dataTransfer.setData("text/plain", playerId);
    event.dataTransfer.effectAllowed = "move";
    if (player) {
      const preview = createCandidateDragPreview(player);
      event.dataTransfer.setDragImage(preview, Math.min(34, preview.offsetWidth / 2), Math.min(24, preview.offsetHeight / 2));
    }
  }));
  app.querySelectorAll("[data-candidate-card]").forEach((card) => card.addEventListener("pointerdown", (event) => {
    beginPointerDrag(event, card.dataset.candidateCard, card);
  }));
  app.querySelectorAll("[data-place-candidate]").forEach((button) => button.addEventListener("click", pickAndPlaceCandidate));
  wireLineupInteractions();
  requestAnimationFrame(drawAllRadars);
}

function pvpRunAdapter() {
  const player = pvpRoom.player;
  return {
    runId: `pvp-${pvpRoom.code}`,
    status: player.ready ? "ready" : "drafting",
    formationId: player.formationId,
    formationSlots: player.formationSlots,
    draftVersion: 3,
    legacyRules: false,
    replacedClub: { id: "pvp", displayName: pvpRoom.side === "host" ? "房主队" : "客队" },
    squad: player.squad,
    currentCandidates: player.currentCandidates,
    draftRound: player.draftRound,
    currentVoucher: player.currentVoucher,
    voucherSummary: player.voucherSummary,
    draftLineup: player.draftLineup,
    lineup: player.lineup,
    chemistry: player.chemistry
  };
}

function renderPvp() {
  clearTimeout(pvpPollTimer);
  cancelAnimationFrame(pvpPlaybackFrame);
  cancelAnimationFrame(pvpReplayFrame);
  const player = pvpRoom.player;
  if (pvpRoom.match) return renderPvpMatch();
  if (!pvpRoom.opponent) {
    app.innerHTML = `<section class="pvp-lobby">
      <article class="pvp-room-card">
        <p class="eyebrow">ROOM CODE</p>
        <h1>${escapeHtml(pvpRoom.code)}</h1>
        <div class="pvp-room-actions"><button id="copy-pvp-code" class="secondary-button" type="button">复制房间码</button><button id="share-pvp-code" class="primary-button" type="button">分享邀请</button></div>
        <p>把房间码或邀请信息发给朋友，也可以直接加入 AI 对手进行本地测试。</p>
      </article>
      <section class="pvp-player-list"><p class="eyebrow">PLAYERS</p>
        <article class="pvp-player-seat occupied"><span class="pvp-avatar">你</span><div><b>${escapeHtml(player.displayName)}</b><small><i></i>已连接 · ${escapeHtml(player.formationId || "未选阵型")}</small></div><em>未准备</em></article>
        <article class="pvp-player-seat empty"><span class="pvp-avatar">?</span><div><b>等待对手加入…</b><small>分享房间码，或加入 AI 测试</small></div><button id="add-pvp-cpu" class="secondary-button" type="button">＋ 加入 AI</button></article>
      </section>
    </section>`;
    app.querySelector("#copy-pvp-code").addEventListener("click", async () => {
      await navigator.clipboard?.writeText(pvpRoom.code);
      showToast("房间码已复制");
    });
    app.querySelector("#share-pvp-code").addEventListener("click", sharePvpRoom);
    app.querySelector("#add-pvp-cpu").addEventListener("click", addPvpCpu);
    return schedulePvpPoll();
  }
  if (!player.formationId) return renderPvpFormation();
  run = pvpRunAdapter();
  lineupState = hydrateLineupState(run.draftLineup);
  renderDraft();
  app.querySelector(".compact-phase-header h1").textContent = `PVP · ${pvpRoom.code}`;
  app.querySelector(".compact-phase-header p:last-child").textContent = `你已选${player.draftCount}/11 · 对手已选${pvpRoom.opponent.draftCount}/11`;
  if (player.ready) {
    app.querySelector(".draft-selection-column").innerHTML = `<section class="pvp-ready-wait"><p class="eyebrow">READY</p><h2>你的阵容已锁定</h2><p>对手 ${pvpRoom.opponent.ready ? "也已准备，正在生成比赛" : `已选${pvpRoom.opponent.draftCount}/11，等待对手准备`}</p><span class="pvp-waiting"><i></i>双方准备后进入球场</span></section>`;
  }
  schedulePvpPoll();
}

async function sharePvpRoom() {
  const text = `加入我的梦幻选秀PVP房间：${pvpRoom.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "FM26 梦幻选秀", text }); } catch { /* 用户取消分享 */ }
  } else {
    await navigator.clipboard?.writeText(text);
    showToast("邀请信息已复制");
  }
}

async function addPvpCpu(event) {
  setBusy(event.currentTarget, true, "AI组队中…");
  try {
    pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/add-cpu`, { method: "POST", body: "{}" });
    showToast("AI 对手已加入并完成阵容");
    render();
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

function renderPvpFormation() {
  const formationCards = config.formations.map((formation) => `<button class="formation-choice ${formation.id === setupFormation ? "selected" : ""}" data-pvp-formation="${formation.id}" type="button">${formation.id}</button>`).join("");
  const formation = config.formations.find((item) => item.id === setupFormation);
  app.innerHTML = `<section class="setup-shell"><header class="setup-title"><p class="eyebrow">PVP · ${escapeHtml(pvpRoom.code)}</p><h1>选择你的阵型</h1><p>双方阵型可以不同；池券序列相同，候选分别随机。</p></header><div class="setup-grid"><section class="setup-controls"><div class="formation-choices">${formationCards}</div><button id="confirm-pvp-formation" class="primary-button setup-start" type="button">确认并开始选秀</button></section><section class="setup-preview-panel"><div class="preview-heading"><span>阵型预览</span><b>${escapeHtml(formation.id)}</b></div><div class="formation-preview-pitch">${setupPitchHtml(formation)}</div></section></div></section>`;
  app.querySelectorAll("[data-pvp-formation]").forEach((button) => button.addEventListener("click", () => { setupFormation = button.dataset.pvpFormation; renderPvpFormation(); }));
  app.querySelector("#confirm-pvp-formation").addEventListener("click", confirmPvpFormation);
  schedulePvpPoll();
}

function pvpPitchPlayers(match, frame = null) {
  const positions = frame?.positions ?? [
    ...match.teams.home.players.map((player) => ({ id: player.id, team: "home", name: player.shortName, ...player.base })),
    ...match.teams.away.players.map((player) => ({ id: player.id, team: "away", name: player.shortName, ...player.base }))
  ];
  return positions.map((player) => `<span class="match-dot ${player.team}" data-match-player="${player.team}:${player.id}" style="--mx:${player.x}%;--my:${player.y}%"><b>${escapeHtml(player.name)}</b></span>`).join("");
}

function pitchMarkingsHtml() {
  return `<span class="match-goal left"></span><span class="match-goal right"></span><span class="match-box penalty left"></span><span class="match-box penalty right"></span><span class="match-box six left"></span><span class="match-box six right"></span><span class="match-spot left"></span><span class="match-spot right"></span>`;
}

function renderPvpMatch() {
  const match = pvpRoom.match;
  if (!match.playback.bothEntered || !match.playback.startedAt) {
    app.innerHTML = `<section class="pvp-match-gate"><p class="eyebrow">PVP MATCH · ${escapeHtml(pvpRoom.code)}</p><h1>${escapeHtml(match.teams.home.name)} <span>VS</span> ${escapeHtml(match.teams.away.name)}</h1><p>比赛没有跳过功能。双方都进入球场后统一开球，刷新或断线重连仍按同一时间轴继续。</p><div class="pvp-gate-status"><span class="${pvpRoom.player.enteredMatch ? "ready" : ""}">你 ${pvpRoom.player.enteredMatch ? "已进入" : "未进入"}</span><span class="${pvpRoom.opponent.enteredMatch ? "ready" : ""}">对手 ${pvpRoom.opponent.enteredMatch ? "已进入" : "未进入"}</span></div><button id="enter-pvp-match" class="primary-button" type="button" ${pvpRoom.player.enteredMatch ? "disabled" : ""}>${pvpRoom.player.enteredMatch ? "等待对手进入" : "进入球场"}</button></section>`;
    app.querySelector("#enter-pvp-match")?.addEventListener("click", enterPvpMatch);
    return schedulePvpPoll(match.playback.bothEntered ? 350 : 800);
  }
  if (match.version !== 6 || !Array.isArray(match.events) || !Array.isArray(match.frames)) {
    app.innerHTML = `<section class="pvp-match-gate"><p class="eyebrow">MATCH ENGINE UPDATED</p><h1>这场比赛使用旧版镜头数据</h1><p>新版连续2D引擎需要重新选人生成比赛。</p><button id="legacy-rematch" class="primary-button" type="button">重新选人</button></section>`;
    app.querySelector("#legacy-rematch").addEventListener("click", requestPvpRematch);
    return;
  }
  const startedAt = Date.parse(match.playback.startedAt);
  const myMatchSide = pvpRoom.side === "host" ? "home" : "away";
  const resultClass = match.winner === "draw" ? "draw" : match.winner === myMatchSide ? "win" : "loss";
  const tacticName = (tacticId) => config.tactics.find((tactic) => tactic.id === tacticId)?.name ?? tacticId;
  pvpLastGoalEventId = null;
  clearTimeout(pvpGoalTimer);
  app.innerHTML = `<section class="pvp-live-shell">
    <header class="pvp-scoreboard"><div><small>${escapeHtml(match.teams.home.name)}<i>${escapeHtml(tacticName(match.teams.home.tacticId))}</i></small><b id="pvp-home-score">0</b></div><strong><span id="pvp-clock">0'</span><em>连续 2D 比赛模拟</em></strong><div><b id="pvp-away-score">0</b><small>${escapeHtml(match.teams.away.name)}<i>${escapeHtml(tacticName(match.teams.away.tacticId))}</i></small></div></header>
    <div class="pvp-live-grid">
      <section class="pvp-match-pitch" id="pvp-match-pitch">${pitchMarkingsHtml()}${pvpPitchPlayers(match)}<span id="match-ball" class="match-ball" style="--bx:50%;--by:50%"></span><div id="pvp-fast-forward" class="pvp-fast-forward" hidden><b>比赛继续</b><span>时间快速推进</span></div><div id="pvp-goal-banner" class="pvp-goal-banner" hidden></div></section>
      <aside class="pvp-match-side"><div id="pvp-commentary" class="pvp-commentary"><p>双方已经进入球场，等待开球…</p></div><div class="pvp-live-stats"><span>控球 <b id="stat-possession">50% — 50%</b></span><span>传球 <b id="stat-passes">0 — 0</b></span><span>射门 <b id="stat-shots">0 — 0</b></span><span>射正 <b id="stat-on-target">0 — 0</b></span><span>xG <b id="stat-xg">0.00 — 0.00</b></span><span>抢断 <b id="stat-tackles">0 — 0</b></span></div><div id="pvp-action-feed" class="pvp-action-feed"></div></aside>
    </div>
    <section id="pvp-final" class="pvp-final ${resultClass}" hidden></section>
  </section>`;
  startPvpPlayback(startedAt);
}

async function enterPvpMatch(event) {
  setBusy(event.currentTarget, true, "等待对手…");
  try {
    pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/enter-match`, { method: "POST", body: "{}" });
    render();
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

function interpolate(left, right, ratio) {
  return left + (right - left) * ratio;
}

function lastTimelineIndex(items, elapsed) {
  let low = 0;
  let high = items.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].atMs <= elapsed) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function playbackState(match, elapsed) {
  const bounded = clamp(elapsed, 0, match.durationMs);
  const frameIndex = lastTimelineIndex(match.frames, bounded);
  const leftFrame = match.frames[frameIndex];
  const rightFrame = match.frames[Math.min(frameIndex + 1, match.frames.length - 1)];
  const local = rightFrame.cut && leftFrame.mode !== "fast_forward" ? 0 : clamp((bounded - leftFrame.atMs) / Math.max(1, rightFrame.atMs - leftFrame.atMs), 0, 1);
  const index = lastTimelineIndex(match.events, bounded);
  const minute = Math.floor(interpolate(leftFrame.minute, rightFrame.minute, local));
  return { elapsed: bounded, minute, event: match.events[index], index, leftFrame, rightFrame, local, finished: elapsed >= match.durationMs };
}

function animatePvpFrames(match, leftFrame, rightFrame, local) {
  const pitch = app.querySelector("#pvp-match-pitch");
  if (!pitch || !leftFrame || !rightFrame) return;
  const movementRatio = leftFrame.mode === "fast_forward" ? 0 : local;
  for (let index = 0; index < match.playerOrder.length; index += 1) {
      const player = match.playerOrder[index];
      const from = leftFrame.positions[index] ?? rightFrame.positions[index];
      const to = rightFrame.positions[index] ?? from;
      if (!from || !to) continue;
      const dot = pitch.querySelector(`[data-match-player="${player.team}:${CSS.escape(player.id)}"]`);
      dot?.style.setProperty("--mx", `${interpolate(from[0], to[0], movementRatio)}%`);
      dot?.style.setProperty("--my", `${interpolate(from[1], to[1], movementRatio)}%`);
  }
  const ballElement = app.querySelector("#match-ball");
  ballElement?.style.setProperty("--bx", `${interpolate(leftFrame.ball.x, rightFrame.ball.x, movementRatio)}%`);
  ballElement?.style.setProperty("--by", `${interpolate(leftFrame.ball.y, rightFrame.ball.y, movementRatio)}%`);
}

const actionLabels = { kickoff: "开球", pass: "传球", through_ball: "直塞", cross: "传中", carry: "带球突破", tackle: "抢断", interception: "拦截", shot: "射门", save: "扑救", clearance: "解围", goal: "进球", foul: "犯规", offside: "越位", free_kick: "任意球", throw_in: "界外球", corner: "角球", goal_kick: "门球", halftime: "中场休息", extra_time: "加时赛", full_time: "全场结束", penalty: "点球", disallowed_goal: "越位进球无效", penalty_shootout: "点球大战" };

function showPvpGoal(match, event) {
  if (!event || event.id === pvpLastGoalEventId) return;
  const banner = app.querySelector("#pvp-goal-banner");
  if (!banner) return;
  const ownGoal = event.type === "shot" && event.outcome === "own_goal";
  const scoringPlayer = ownGoal
    ? match.teams[event.team === "home" ? "away" : "home"]?.players.find((player) => player.id === event.opponentId)
    : match.teams[event.team]?.players.find((player) => player.id === event.actorId);
  const shootout = event.type === "penalty_shootout";
  const disallowed = event.type === "disallowed_goal";
  const label = shootout
    ? event.outcome === "goal" ? "点球命中" : event.outcome === "saved" ? "点球被扑" : "点球射失"
    : disallowed ? "越位 · 进球无效" : ownGoal ? "乌龙球" : "进球";
  const scoreText = shootout && event.shootoutScore
    ? `${event.shootoutScore.home} — ${event.shootoutScore.away}`
    : disallowed ? "比分不变" : `${event.score.home} — ${event.score.away}`;
  pvpLastGoalEventId = event.id;
  clearTimeout(pvpGoalTimer);
  banner.className = `pvp-goal-banner ${event.team}`;
  banner.innerHTML = `<small>${event.minute}' · ${label}</small><b>${scoreText}</b><strong>${escapeHtml(scoringPlayer?.name ?? event.summary ?? label)}</strong>`;
  banner.hidden = false;
  requestAnimationFrame(() => banner.classList.add("show"));
  pvpGoalTimer = setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => { banner.hidden = true; }, 180);
  }, 2400);
}

function updatePvpPlayback(match, state) {
  if (state.index > pvpLastPlaybackEventIndex) {
    const newlyReached = match.events.slice(Math.max(0, pvpLastPlaybackEventIndex + 1), state.index + 1);
    const goal = [...newlyReached].reverse().find((event) => (event.type === "shot" && ["goal", "own_goal"].includes(event.outcome)) || event.type === "disallowed_goal" || event.type === "penalty_shootout");
    if (goal) showPvpGoal(match, goal);
    pvpLastPlaybackEventIndex = state.index;
  }
  const latest = state.event;
  const score = latest?.score ?? { home: 0, away: 0 };
  const fastForwarding = state.leftFrame.mode === "fast_forward";
  const pitch = app.querySelector("#pvp-match-pitch");
  const fastForward = app.querySelector("#pvp-fast-forward");
  pitch?.classList.toggle("is-fast-forward", fastForwarding);
  if (fastForward) {
    fastForward.hidden = !fastForwarding;
    if (fastForwarding) fastForward.querySelector("span").textContent = `${Math.floor(state.leftFrame.minute)}' → ${Math.ceil(state.rightFrame.minute)}'`;
  }
  app.querySelector("#pvp-clock").textContent = `${state.minute}'`;
  app.querySelector("#pvp-home-score").textContent = score.home;
  app.querySelector("#pvp-away-score").textContent = score.away;
  if (latest) {
    const commentary = app.querySelector("#pvp-commentary");
    commentary.innerHTML = fastForwarding
      ? `<small>${state.minute}' · 比赛时间推进</small><p>双方保持阵型继续周旋，常规传递和无威胁回合已加速播放，下一段关键画面即将开始。</p>`
      : `<small>${latest.minute}' · ${escapeHtml(actionLabels[latest.type] ?? latest.type)}${latest.xg ? ` · xG ${Number(latest.xg).toFixed(2)}` : ""}</small><p>${escapeHtml(latest.text)}</p>`;
    const stats = latest.stats;
    const possessionTotal = Math.max(1, stats.home.possessionWeight + stats.away.possessionWeight);
    const homePossession = Math.round(stats.home.possessionWeight / possessionTotal * 100);
    app.querySelector("#stat-possession").textContent = `${homePossession}% — ${100 - homePossession}%`;
    app.querySelector("#stat-passes").textContent = `${stats.home.completedPasses}/${stats.home.passes} — ${stats.away.completedPasses}/${stats.away.passes}`;
    app.querySelector("#stat-shots").textContent = `${stats.home.shots} — ${stats.away.shots}`;
    app.querySelector("#stat-on-target").textContent = `${stats.home.shotsOnTarget} — ${stats.away.shotsOnTarget}`;
    app.querySelector("#stat-xg").textContent = `${Number(stats.home.xg).toFixed(2)} — ${Number(stats.away.xg).toFixed(2)}`;
    app.querySelector("#stat-tackles").textContent = `${stats.home.tackles} — ${stats.away.tackles}`;
    const recent = match.events.slice(Math.max(0, state.index - 4), state.index + 1).reverse();
    app.querySelector("#pvp-action-feed").innerHTML = recent.map((event) => `<p class="${event.team}"><time>${event.minute}'</time><span>${escapeHtml(event.summary ?? event.text)}</span></p>`).join("");
  }
  animatePvpFrames(match, state.leftFrame, state.rightFrame, state.local);
  if (state.finished) showPvpFinal(match);
}

function finalStatRows(match) {
  const rows = [["控球", `${match.stats.home.possession}%`, `${match.stats.away.possession}%`], ["射门", match.stats.home.shots, match.stats.away.shots], ["射正", match.stats.home.shotsOnTarget, match.stats.away.shotsOnTarget], ["xG", match.stats.home.xg.toFixed(2), match.stats.away.xg.toFixed(2)], ["传球", `${match.stats.home.completedPasses}/${match.stats.home.passes}`, `${match.stats.away.completedPasses}/${match.stats.away.passes}`], ["抢断", match.stats.home.tackles, match.stats.away.tackles], ["拦截", match.stats.home.interceptions, match.stats.away.interceptions], ["解围", match.stats.home.clearances, match.stats.away.clearances], ["扑救", match.stats.home.saves, match.stats.away.saves], ["角球", match.stats.home.corners, match.stats.away.corners], ["犯规", match.stats.home.fouls, match.stats.away.fouls], ["越位", match.stats.home.offsides, match.stats.away.offsides]];
  return rows.map(([label, home, away]) => `<div><b>${home}</b><span>${label}</span><b>${away}</b></div>`).join("");
}

function playerRatingCard(player) {
  const defense = player.tackles + player.interceptions + (player.clearances ?? 0);
  const ownGoal = player.ownGoals ? ` · ${player.ownGoals}个乌龙` : "";
  const position = escapeHtml(config.positionLabels[player.position] ?? player.position);
  const primary = player.position === "GK"
    ? `${player.saves}次扑救 · ${player.goalsConceded ?? 0}个失球 · ${player.completedPasses}/${player.passes}传球`
    : `${player.goals}球 ${player.assists}助 · xG ${Number(player.xg ?? 0).toFixed(2)} · xA ${Number(player.xa ?? 0).toFixed(2)}`;
  const secondary = player.position === "GK"
    ? `传球成功率${player.passCompletion}% · ${player.clearances ?? 0}次解围`
    : `${player.shotsOnTarget}/${player.shots}射正/射门 · ${player.completedPasses}/${player.passes}传球 · ${defense}次防守${ownGoal}`;
  return `<div class="pvp-rating-card"><span><b>${escapeHtml(player.name)}</b><small><span>${position} · ${primary}</span><span>${secondary}</span></small></span><em class="rating-${player.rating >= 7.5 ? "great" : player.rating < 6 ? "poor" : "normal"}">${player.rating.toFixed(1)}</em></div>`;
}

function playerRatingsComparison(match) {
  const rows = Array.from({ length: Math.max(match.ratings.home.length, match.ratings.away.length) }, (_, index) => (
    `${match.ratings.home[index] ? playerRatingCard(match.ratings.home[index]) : '<div class="pvp-rating-card empty"></div>'}${match.ratings.away[index] ? playerRatingCard(match.ratings.away[index]) : '<div class="pvp-rating-card empty"></div>'}`
  )).join("");
  return `<section class="pvp-ratings-comparison"><div class="pvp-rating-head"><h3>${escapeHtml(match.teams.home.name)}评分</h3><h3>${escapeHtml(match.teams.away.name)}评分</h3></div><div class="pvp-rating-pairs">${rows}</div></section>`;
}

function showPvpFinal(match) {
  const final = app.querySelector("#pvp-final");
  if (!final || !final.hidden) return;
  final.hidden = false;
  const penaltyText = match.penalties ? `<p>点球大战 ${match.penalties.home} — ${match.penalties.away}</p>` : "";
  const myMatchSide = pvpRoom.side === "host" ? "home" : "away";
  const resultText = match.winner === "draw" ? "双方在这场PVP中战平" : match.winner === myMatchSide ? "你赢得了这场PVP" : "对手赢得了这场PVP";
  const rematchLabel = pvpRoom.player.rematchRequested ? "已申请，等待对手" : "重新选人再来一局";
  final.innerHTML = `<header><div><p class="eyebrow">FULL TIME</p><h2>${match.score.home} — ${match.score.away}</h2>${penaltyText}<strong>${resultText}</strong></div><div class="pvp-final-actions"><button id="pvp-rematch" class="primary-button" type="button" ${pvpRoom.player.rematchRequested ? "disabled" : ""}>${rematchLabel}</button></div></header><div class="pvp-report-grid"><section><h3>球队统计</h3><div class="pvp-team-stat-head"><b>${escapeHtml(match.teams.home.name)}</b><b>${escapeHtml(match.teams.away.name)}</b></div><div class="pvp-team-stat-list">${finalStatRows(match)}</div></section><section><h3>比赛画面</h3><div class="pvp-moment-list">${match.moments.map((moment) => `<button data-replay-event="${moment.eventIndex}" type="button"><time>${moment.minute}'</time><span><b>${escapeHtml(moment.summary ?? moment.text)}</b><small>${escapeHtml(moment.text)}</small></span><em>回看</em></button>`).join("")}</div></section></div>${playerRatingsComparison(match)}`;
  final.querySelector("#pvp-rematch").addEventListener("click", requestPvpRematch);
  final.querySelectorAll("[data-replay-event]").forEach((button) => button.addEventListener("click", replayPvpMoment));
  if (!pvpRoom.opponent.isCpu) schedulePvpPoll(2200);
}

function replayPvpMoment(event) {
  cancelAnimationFrame(pvpReplayFrame);
  const match = pvpRoom.match;
  const action = match.events[Number(event.currentTarget.dataset.replayEvent)];
  const final = app.querySelector("#pvp-final");
  final.hidden = true;
  const started = performance.now();
  const startFrame = action.replayStartFrame;
  const endFrame = action.replayEndFrame;
  const replayStartMs = match.frames[startFrame].atMs;
  const replayEndMs = match.frames[endFrame].atMs;
  const duration = clamp(replayEndMs - replayStartMs, 3000, 15000);
  const tick = (now) => {
    const progress = clamp((now - started) / duration, 0, 1);
    const replayElapsed = interpolate(replayStartMs, replayEndMs, progress);
    const frameIndex = clamp(lastTimelineIndex(match.frames, replayElapsed), startFrame, endFrame);
    const leftFrame = match.frames[frameIndex];
    const rightFrame = match.frames[Math.min(endFrame, frameIndex + 1)];
    const local = rightFrame.cut ? 0 : clamp((replayElapsed - leftFrame.atMs) / Math.max(1, rightFrame.atMs - leftFrame.atMs), 0, 1);
    animatePvpFrames(match, leftFrame, rightFrame, local);
    app.querySelector("#pvp-clock").textContent = `${action.minute}' 回放`;
    app.querySelector("#pvp-commentary").innerHTML = `<small>比赛画面回放 · ${escapeHtml(actionLabels[action.type] ?? action.type)}</small><p>${escapeHtml(action.text)}</p>`;
    if (progress < 1) pvpReplayFrame = requestAnimationFrame(tick);
    else setTimeout(() => { final.hidden = false; }, 350);
  };
  pvpReplayFrame = requestAnimationFrame(tick);
}

async function requestPvpRematch(event) {
  setBusy(event.currentTarget, true, "处理中…");
  try {
    pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/rematch`, { method: "POST", body: "{}" });
    if (pvpRoom.match) showToast("已申请重新选人，等待对手确认");
    render();
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

function startPvpPlayback(startedAt) {
  const match = pvpRoom.match;
  if (!Number.isFinite(startedAt)) {
    schedulePvpPoll(350);
    return;
  }
  pvpLastPlaybackEventIndex = lastTimelineIndex(match.events, clamp(Date.now() - startedAt, 0, match.durationMs));
  const tick = () => {
    if (!pvpRoom?.match || !app.querySelector("#pvp-match-pitch")) return;
    const elapsed = Date.now() - startedAt;
    updatePvpPlayback(match, playbackState(match, elapsed));
    if (elapsed < match.durationMs) pvpPlaybackFrame = requestAnimationFrame(tick);
  };
  pvpPlaybackFrame = requestAnimationFrame(tick);
}

async function confirmPvpFormation(event) {
  setBusy(event.currentTarget, true, "确认中…");
  try {
    pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/formation`, { method: "PUT", body: JSON.stringify({ formationId: setupFormation }) });
    render();
  } catch (error) {
    showToast(error.message, "error");
    setBusy(event.currentTarget, false);
  }
}

function schedulePvpPoll(delay = 1200) {
  clearTimeout(pvpPollTimer);
  pvpPollTimer = setTimeout(refreshPvpRoom, delay);
}

async function refreshPvpRoom() {
  if (!pvpRoom) return;
  try {
    const previous = JSON.stringify({ status: pvpRoom.status, opponent: pvpRoom.opponent, matchStart: pvpRoom.match?.playback?.startedAt, player: { ready: pvpRoom.player.ready, enteredMatch: pvpRoom.player.enteredMatch } });
    pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}`);
    const next = JSON.stringify({ status: pvpRoom.status, opponent: pvpRoom.opponent, matchStart: pvpRoom.match?.playback?.startedAt, player: { ready: pvpRoom.player.ready, enteredMatch: pvpRoom.player.enteredMatch } });
    if (previous !== next) render();
    else schedulePvpPoll();
  } catch (error) {
    showToast(error.message, "error");
    schedulePvpPoll(2500);
  }
}

function voucherWheelHtml() {
  const pools = config.draftPools;
  const summary = run.voucherSummary || { totals: {}, revealed: {}, remaining: {} };
  const wheelCounts = wheelSpin?.counts || summary.remaining;
  const total = pools.reduce((sum, pool) => sum + Number(wheelCounts[pool.id] || 0), 0);
  let cursor = 0;
  const stops = [];
  const colors = { legend: "#f2a62b", star: "#3787ff", player: "#37c875" };
  for (const pool of pools) {
    const count = Number(wheelCounts[pool.id] || 0);
    if (!count || !total) continue;
    const start = cursor;
    cursor += count / total * 360;
    stops.push(`${colors[pool.id]} ${start}deg ${cursor}deg`);
  }
  const wheelBackground = stops.length ? stops.join(",") : "#17352b 0deg 360deg";
  const style = `--wheel-segments:${wheelBackground};--wheel-end:0deg`;
  const tallies = pools.map((pool) => {
    const remaining = Number(summary.remaining[pool.id] || 0);
    const poolTotal = Number(summary.totals[pool.id] || 0);
    const tickets = Array.from({ length: poolTotal }, (_, index) => `<i class="ticket-dot ${index < remaining ? "live" : "used"}"></i>`).join("");
    return `<div class="voucher-tally ${pool.id} ${remaining ? "" : "empty"}"><span>${escapeHtml(pool.name)}</span><b>${remaining}<em>/${poolTotal}</em></b><small>${remaining ? "剩余池券" : "已用完"}</small><div class="ticket-dots">${tickets}</div></div>`;
  }).join("");
  return `<section class="voucher-board"><div class="voucher-title"><small>DRAFT WHEEL</small><strong>本局池券</strong><span>共11轮 · 顺序随机</span></div><div class="voucher-tallies">${tallies}</div><div class="wheel-shell"><span class="wheel-pointer"></span><div class="voucher-wheel ${wheelSpin ? "spinning" : ""}" style="${style}"><span>GO</span></div></div></section>`;
}

function wheelLandingRotation(poolId, totals) {
  const order = config.draftPools.map((pool) => pool.id);
  const total = order.reduce((sum, id) => sum + Number(totals[id] || 0), 0) || 1;
  let start = 0;
  for (const id of order) {
    const angle = Number(totals[id] || 0) / total * 360;
    if (id === poolId) return 1440 - start - angle / 2;
    start += angle;
  }
  return 1440;
}

function chemistryTotalForPlayers(players) {
  let total = 0;
  for (const player of players) {
    const others = players.filter((other) => other.id !== player.id);
    if (others.some((other) => other.nation === player.nation)) total += 1;
    if (others.some((other) => other.league === player.league)) total += 1;
  }
  return total;
}

function candidateFeedbackHtml(player) {
  if (!player.tacticalFit || !run.playstyle) return "";
  const currentPlayers = Object.values(lineupState.starters).filter(Boolean).map((id) => run.squad.find((item) => item.id === id)).filter(Boolean);
  const chemistryDelta = chemistryTotalForPlayers([...currentPlayers, player]) - chemistryTotalForPlayers(currentPlayers);
  const chemistry = chemistryDelta > 0 ? `默契 +${chemistryDelta}` : "暂未形成默契";
  return `<div class="candidate-feedback"><span class="fit-${escapeHtml(player.tacticalFit.tone)}" title="擅长：${escapeHtml(player.tacticalFit.strongest)}；需要适应：${escapeHtml(player.tacticalFit.weakest)}"><small>这套打法</small><b>${escapeHtml(player.tacticalFit.strongest)} · ${escapeHtml(player.tacticalFit.label)}</b></span><span class="${chemistryDelta > 0 ? "chemistry-up" : ""}"><small>队内默契</small><b>${escapeHtml(chemistry)}</b></span></div>`;
}

function playerCard(player) {
  const ratings = Object.entries(player.summaryRatings);
  const positions = [
    ...player.positionDisplay.primary.map((label) => `<span class="position-badge primary">${escapeHtml(label)}</span>`),
    ...player.positionDisplay.secondary.map((label) => `<span class="position-badge">${escapeHtml(label)} 95%</span>`),
    ...player.positionDisplay.other.map((label) => `<span class="position-badge">${escapeHtml(label)} 90%</span>`)
  ].join("");
  const placement = candidatePlacementHtml(player);
  const form = player.form ? `<span class="player-form form-${escapeHtml(player.form.tone)}" title="当前状态：${escapeHtml(player.form.label)}">${escapeHtml(player.form.label)}</span>` : "";
  return `
    <article class="player-card compact-player-card pool-${escapeHtml(player.draftPool)} ${selectedCandidateId === player.id ? "selected" : ""}" data-candidate-card="${player.id}" draggable="true">
      <div class="player-card-main">
        <div class="card-kicker"><span class="${player.type === "legend" ? "legend-label" : ""}">${escapeHtml(player.typeDisplay)}</span><span>${escapeHtml(player.preferredFoot)}</span></div>
        <h3 title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</h3>
        <div class="player-meta">${escapeHtml(player.nation)} · ${escapeHtml(player.club)} · ${player.age}岁</div>
        <div class="position-badges">${positions}</div>
        <div class="rating-grid">${ratings.map(([name, value]) => `<div class="rating-item"><small>${escapeHtml(name)}</small><b>${Number(value).toFixed(1)}</b></div>`).join("")}</div>
      </div>
      ${form}
      <div class="radar-wrap"><canvas data-radar='${escapeHtml(JSON.stringify({ ratings: player.summaryRatings, pool: player.draftPool }))}' aria-label="${escapeHtml(player.name)}八维雷达图"></canvas></div>
      ${candidateFeedbackHtml(player)}
      ${selectedCandidateId === player.id ? `<div class="candidate-placement"><b>放入阵容</b><div>${placement}</div></div>` : ""}
    </article>
  `;
}

function candidatePlacementHtml(player) {
  const starterOptions = run.formationSlots.filter((slot) => (
    !lineupState.starters[slot.slotId]
    && playerPositions(player).includes(slot.position)
    && (!player.compatibleSlotIds?.length || player.compatibleSlotIds.includes(slot.slotId))
  )).map((slot) => `<button class="placement-button starter" data-place-candidate="${player.id}" data-place-kind="starter" data-place-id="${slot.slotId}" type="button">${escapeHtml(slot.label)}</button>`);
  return starterOptions.join("") || '<span class="no-placement">当前没有兼容空位</span>';
}

async function fetchCandidates() {
  if (fetchingCandidates || !run || run.currentCandidates.length || run.squad.length >= config.draft.maxSquadSize) return;
  fetchingCandidates = true;
  try {
    const preSpinCounts = { ...(run.voucherSummary?.remaining ?? {}) };
    const result = pvpRoom
      ? await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/draft/candidates`, {
        method: "POST",
        body: JSON.stringify({})
      })
      : await api(`/api/runs/${run.runId}/draft/candidates`, {
      method: "POST",
      body: JSON.stringify({})
    });
    run.currentCandidates = result.candidates;
    run.currentVoucher = result.voucher;
    run.voucherSummary = result.voucherSummary;
    if (pvpRoom) {
      pvpRoom.player.currentCandidates = result.candidates;
      pvpRoom.player.currentVoucher = result.voucher;
      pvpRoom.player.voucherSummary = result.voucherSummary;
    }
    wheelSpin = {
      pool: result.voucher.pool,
      counts: preSpinCounts,
      rotation: wheelLandingRotation(result.voucher.pool, preSpinCounts)
    };
    fetchingCandidates = false;
    render();
    const wheel = app.querySelector(".voucher-wheel");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wheel?.style.setProperty("--wheel-end", `${wheelSpin?.rotation ?? 0}deg`);
    }));
    clearTimeout(wheelSpinTimer);
    wheelSpinTimer = setTimeout(() => {
      wheelSpin = null;
      wheelSpinTimer = null;
      if (run?.currentCandidates?.length) render();
    }, 900);
  } catch (error) {
    showToast(error.message, "error");
    fetchingCandidates = false;
    render();
  }
}

async function pickAndPlaceCandidate(event) {
  const button = event.currentTarget;
  const playerId = button.dataset.placeCandidate;
  const slotId = button.dataset.placeId;
  await pickCandidateIntoSlot(playerId, slotId, button);
}

async function pickCandidateIntoSlot(playerId, slotId, button = null) {
  if (candidatePickPending) return;
  const player = run.currentCandidates.find((item) => item.id === playerId);
  const slot = run.formationSlots.find((item) => item.slotId === slotId);
  if (!player || !slot) return;
  if (!playerPositions(player).includes(slot.position)) {
    return showToast(`${player.name}没有登记${config.positionLabels[slot.position]}位置`, "error");
  }
  candidatePickPending = true;
  if (button) button.disabled = true;
  try {
    if (pvpRoom) {
      pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/draft/picks`, { method: "POST", body: JSON.stringify({ playerId, slotId }) });
      run = pvpRunAdapter();
    } else {
      run = await api(`/api/runs/${run.runId}/draft/picks`, { method: "POST", body: JSON.stringify({ playerId, slotId }) });
    }
    lineupState = hydrateLineupState(run.draftLineup);
    selectedCandidateId = null;
    clearTimeout(wheelSpinTimer);
    wheelSpinTimer = null;
    wheelSpin = null;
    render();
  } catch (error) {
    showToast(error.message, "error");
    if (button) button.disabled = false;
  } finally {
    candidatePickPending = false;
  }
}

function drawAllRadars() {
  document.querySelectorAll("canvas[data-radar]").forEach((canvas) => {
    const data = JSON.parse(canvas.dataset.radar);
    const labels = Object.keys(data.ratings);
    const values = Object.values(data.ratings).map(Number);
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 180;
    const height = canvas.clientHeight || 145;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    const centerX = width / 2;
    const compact = width < 160;
    const centerY = height / 2;
    const radius = Math.min(width * (compact ? .35 : .34), height * (compact ? .34 : .31));
    const points = values.length;
    const point = (index, value) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / points;
      return [centerX + Math.cos(angle) * radius * value, centerY + Math.sin(angle) * radius * value];
    };
    context.lineWidth = 1;
    for (const ring of [0.25, 0.5, 0.75, 1]) {
      context.beginPath();
      for (let index = 0; index < points; index += 1) {
        const [x, y] = point(index, ring);
        index ? context.lineTo(x, y) : context.moveTo(x, y);
      }
      context.closePath();
      context.strokeStyle = "rgba(220,255,235,.12)";
      context.stroke();
    }
    for (let index = 0; index < points; index += 1) {
      const [x, y] = point(index, 1);
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(x, y);
      context.strokeStyle = "rgba(220,255,235,.10)";
      context.stroke();
    }
    context.beginPath();
    for (let index = 0; index < points; index += 1) {
      const [x, y] = point(index, values[index] / 100);
      index ? context.lineTo(x, y) : context.moveTo(x, y);
    }
    context.closePath();
    const radarColors = {
      legend: { line: "#f2a62b", fill: "rgba(242,166,43,.24)" },
      star: { line: "#3787ff", fill: "rgba(55,135,255,.23)" },
      player: { line: "#37c875", fill: "rgba(55,200,117,.22)" }
    };
    const radarColor = radarColors[data.pool] || radarColors.player;
    context.fillStyle = radarColor.fill;
    context.strokeStyle = radarColor.line;
    context.lineWidth = 2;
    context.fill();
    context.stroke();
    for (let index = 0; index < points; index += 1) {
      const [x, y] = point(index, values[index] / 100);
      context.beginPath();
      context.arc(x, y, 2.2, 0, Math.PI * 2);
      context.fillStyle = radarColor.line;
      context.fill();
    }
    context.fillStyle = "#a8beb4";
    context.font = `700 ${compact ? 7 : 9}px system-ui, sans-serif`;
    for (let index = 0; index < points; index += 1) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / points;
      const labelRadius = radius + (compact ? 7 : 18);
      const label = `${labels[index]} ${Math.round(values[index])}`;
      const textWidth = context.measureText(label).width;
      let x = centerX + Math.cos(angle) * labelRadius;
      let y = centerY + Math.sin(angle) * labelRadius;
      const horizontal = Math.cos(angle);
      const vertical = Math.sin(angle);
      const alignment = horizontal > .25 ? "left" : horizontal < -.25 ? "right" : "center";
      context.textAlign = alignment;
      context.textBaseline = vertical > .25 ? "top" : vertical < -.25 ? "bottom" : "middle";
      if (alignment === "left") x = Math.min(x, width - textWidth - 3);
      else if (alignment === "right") x = Math.max(x, textWidth + 3);
      else x = Math.max(textWidth / 2 + 3, Math.min(width - textWidth / 2 - 3, x));
      y = Math.max(9, Math.min(height - 9, y));
      context.fillText(label, x, y);
    }
  });
}

function playerPositions(player) {
  return [...player.positions.primary, ...player.positions.secondary, ...player.positions.other];
}

function hydrateLineupState(savedLineup) {
  return {
    starters: Object.fromEntries((savedLineup?.starters ?? []).map((item) => [item.slotId, item.playerId])),
    tacticId: savedLineup?.tacticId || run?.playstyle?.id || "balanced"
  };
}

function chemistryPreview() {
  const playerIds = Object.values(lineupState?.starters ?? {}).filter(Boolean);
  return chemistryTotalForPlayers(playerIds.map((id) => run.squad.find((item) => item.id === id)).filter(Boolean));
}

function slotHtml(kind, id, positionOrRole, label, playerId, coordinate = null) {
  const player = run.squad.find((item) => item.id === playerId);
  const style = coordinate ? `style="--x:${coordinate.x}%;--y:${coordinate.y}%"` : "";
  const poolClass = player?.draftPool ? `pool-${player.draftPool}` : "";
  return `
    <button class="slot ${poolClass}" ${style} data-slot-kind="starter" data-slot-id="${id}" data-position="${positionOrRole}" data-filled="${Boolean(player)}" ${player ? `data-slot-player-id="${player.id}" draggable="true"` : ""} type="button">
      <span class="slot-position">${escapeHtml(label)}</span>
      ${player ? `<span class="slot-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</span>` : '<span class="slot-empty">放置球员</span>'}
    </button>
  `;
}

function beginPointerDrag(event, playerId, source) {
  if (event.button !== 0) return;
  pointerDragState = { playerId, source, startX: event.clientX, startY: event.clientY };
}

function createCandidateDragPreview(player) {
  dragPreviewElement?.remove();
  const preview = document.createElement("div");
  preview.className = `candidate-drag-preview pool-${player.draftPool}`;
  preview.innerHTML = `<b>${escapeHtml(player.name)}</b><span>${escapeHtml(player.positionDisplay.primary.join(" / "))}</span>`;
  document.body.append(preview);
  dragPreviewElement = preview;
  return preview;
}

function updatePageDragScroll(clientY) {
  dragPointerY = clientY;
  if (dragAutoScrollFrame === null) dragAutoScrollFrame = requestAnimationFrame(runPageDragScroll);
}

function runPageDragScroll() {
  dragAutoScrollFrame = null;
  if ((!pointerDragState && !nativeDragActive) || dragPointerY === null) return;
  const viewportHeight = window.innerHeight;
  const edge = Math.min(110, Math.max(64, viewportHeight * 0.16));
  let speed = 0;
  if (dragPointerY < edge) speed = -Math.ceil((edge - dragPointerY) / edge * 18);
  else if (dragPointerY > viewportHeight - edge) speed = Math.ceil((dragPointerY - viewportHeight + edge) / edge * 18);
  if (!speed) return;
  window.scrollBy(0, speed);
  dragAutoScrollFrame = requestAnimationFrame(runPageDragScroll);
}

function stopPageDragScroll() {
  nativeDragActive = false;
  dragPreviewElement?.remove();
  dragPreviewElement = null;
  dragPointerY = null;
  if (dragAutoScrollFrame !== null) cancelAnimationFrame(dragAutoScrollFrame);
  dragAutoScrollFrame = null;
}

function pointerMoved(event) {
  if (!pointerDragState) return false;
  return Math.hypot(event.clientX - pointerDragState.startX, event.clientY - pointerDragState.startY) > 8;
}

function completePointerDrop(event) {
  if (!pointerDragState || !pointerMoved(event)) return;
  const dropTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-slot-id]");
  if (!dropTarget || dropTarget === pointerDragState.source) return;
  const playerId = pointerDragState.playerId;
  pointerDragState = null;
  suppressSlotClick = true;
  placeDraggedPlayer(playerId, dropTarget);
  setTimeout(() => { suppressSlotClick = false; }, 0);
}

function placeDraggedPlayer(playerId, slot) {
  if (run.currentCandidates.some((item) => item.id === playerId)) pickCandidateIntoSlot(playerId, slot.dataset.slotId);
  else assignToSlot(playerId, slot);
}

function wireLineupInteractions() {
  app.querySelectorAll("[data-slot-id]").forEach((slot) => {
    slot.addEventListener("dragstart", (event) => {
      const playerId = slot.dataset.slotPlayerId;
      if (!playerId) return event.preventDefault();
      nativeDragActive = true;
      event.dataTransfer.setData("text/plain", playerId);
      event.dataTransfer.effectAllowed = "move";
    });
    slot.addEventListener("pointerdown", (event) => {
      if (slot.dataset.slotPlayerId) beginPointerDrag(event, slot.dataset.slotPlayerId, slot);
    });
    slot.addEventListener("pointerup", (event) => {
      if (!pointerDragState || pointerDragState.source === slot || !pointerMoved(event)) return;
      const playerId = pointerDragState.playerId;
      pointerDragState = null;
      suppressSlotClick = true;
      placeDraggedPlayer(playerId, slot);
      setTimeout(() => { suppressSlotClick = false; }, 150);
    });
    slot.addEventListener("dragover", (event) => { event.preventDefault(); slot.classList.add("drop-ready"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("drop-ready"));
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      slot.classList.remove("drop-ready");
      const playerId = event.dataTransfer.getData("text/plain") || selectedPlayerId;
      suppressSlotClick = true;
      placeDraggedPlayer(playerId, slot);
      setTimeout(() => { suppressSlotClick = false; }, 150);
    });
    slot.addEventListener("click", () => {
      if (suppressSlotClick) return;
      const current = lineupState.starters[slot.dataset.slotId];
      if (current) showPlayerDetails(current);
    });
  });
  app.querySelector("#tactic-select")?.addEventListener("change", (event) => {
    lineupState.tacticId = event.target.value;
    persistDraftLineup();
  });
  app.querySelector("#start-season")?.addEventListener("click", startSeason);
}

function removeAssignment(playerId) {
  for (const [slotId, id] of Object.entries(lineupState.starters)) if (id === playerId) delete lineupState.starters[slotId];
}

function assignToSlot(playerId, slotElement) {
  if (!playerId) return;
  const player = run.squad.find((item) => item.id === playerId);
  const slotId = slotElement.dataset.slotId;
  if (!player) return;
  const position = slotElement.dataset.position;
  if (!playerPositions(player).includes(position)) return showToast(`${player.name}没有登记${config.positionLabels[position]}位置`, "error");
  const displaced = lineupState.starters[slotId];
  const sourceSlotId = Object.entries(lineupState.starters).find(([, id]) => id === playerId)?.[0];
  if (displaced && displaced !== playerId) {
    const displacedPlayer = run.squad.find((item) => item.id === displaced);
    const sourceSlot = run.formationSlots.find((item) => item.slotId === sourceSlotId);
    if (!sourceSlot || !displacedPlayer || !playerPositions(displacedPlayer).includes(sourceSlot.position)) {
      return showToast(`${displacedPlayer?.name ?? "该球员"}不能胜任${sourceSlot ? config.positionLabels[sourceSlot.position] : "原位置"}，无法交换`, "error");
    }
    lineupState.starters[sourceSlotId] = displaced;
    lineupState.starters[slotId] = playerId;
    selectedPlayerId = null;
    persistDraftLineup();
    return renderDraft();
  }
  removeAssignment(playerId);
  lineupState.starters[slotId] = playerId;
  selectedPlayerId = null;
  persistDraftLineup();
  renderDraft();
}

function showPlayerDetails(playerId) {
  const player = run.squad.find((item) => item.id === playerId);
  openPlayerDetails(player);
}

function openPlayerDetails(player, { stats = null, actionLabel = null, onAction = null } = {}) {
  const dialog = app.querySelector("#player-detail-dialog");
  if (!player || !dialog) return;
  const positions = [
    ...player.positionDisplay.primary.map((label) => `<span class="position-badge primary">${escapeHtml(label)}</span>`),
    ...player.positionDisplay.secondary.map((label) => `<span class="position-badge">${escapeHtml(label)} 95%</span>`),
    ...player.positionDisplay.other.map((label) => `<span class="position-badge">${escapeHtml(label)} 90%</span>`)
  ].join("");
  const ratings = Object.entries(player.summaryRatings)
    .map(([name, value]) => `<div class="rating-item"><small>${escapeHtml(name)}</small><b>${Number(value).toFixed(1)}</b></div>`)
    .join("");
  const form = player.form ? `<span class="player-form form-${escapeHtml(player.form.tone)}">${escapeHtml(player.form.label)}</span>` : "";
  const recentRatings = stats?.recentRatings?.length
    ? `<div class="recent-ratings"><small>最近5场</small>${stats.recentRatings.map((item) => `<span class="rating-${item.rating >= 7.5 ? "great" : item.rating <= 5.5 ? "poor" : "normal"}"><i>R${item.round}</i><b>${item.rating.toFixed(1)}</b></span>`).join("")}</div>`
    : "";
  const statLine = stats ? `<div class="player-detail-stats"><span>出场 <b>${stats.appearances ?? 0}</b></span><span>评分 <b>${stats.averageRating?.toFixed(2) ?? "—"}</b></span><span>进球 <b>${stats.goals ?? 0}</b></span><span>助攻 <b>${stats.assists ?? 0}</b></span><span>失误致失球 <b>${stats.errorsLeadingToGoal ?? 0}</b></span><span>乌龙 <b>${stats.ownGoals ?? 0}</b></span></div>${recentRatings}` : "";
  const action = actionLabel ? `<div class="player-detail-action"><button id="player-detail-action" class="primary-button" type="button">${escapeHtml(actionLabel)}</button></div>` : "";
  dialog.innerHTML = `<div class="player-detail-head"><div><div class="player-detail-kicker"><small>${escapeHtml(player.typeDisplay)}</small>${form}</div><h2>${escapeHtml(player.name)}</h2><p>${escapeHtml(player.nation)} · ${escapeHtml(player.club)} · ${player.age}岁 · ${escapeHtml(player.preferredFoot)}</p></div><button class="detail-close" type="button" aria-label="关闭">×</button></div><div class="position-badges">${positions}</div>${statLine}<div class="player-detail-body"><div class="rating-grid">${ratings}</div><div class="radar-wrap"><canvas data-radar='${escapeHtml(JSON.stringify({ ratings: player.summaryRatings, pool: player.draftPool }))}'></canvas></div></div>${action}`;
  dialog.querySelector(".detail-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector("#player-detail-action")?.addEventListener("click", () => {
    dialog.close();
    onAction?.();
  });
  dialog.showModal();
  requestAnimationFrame(drawAllRadars);
}

function winterStatsHtml(option) {
  const stats = option.stats ?? {};
  const common = [
    ["出场", stats.appearances ?? 0],
    ["评分", stats.averageRating?.toFixed(2) ?? "—"]
  ];
  const positionStats = option.position === "GK"
    ? [["失球", stats.goalsConceded ?? 0], ["零封", stats.cleanSheets ?? 0], ["扑救", stats.saves ?? 0]]
    : ["LB", "LWB", "CB", "RB", "RWB"].includes(option.position)
      ? [["进球", stats.goals ?? 0], ["助攻", stats.assists ?? 0], ["零封", stats.cleanSheets ?? 0]]
      : [["进球", stats.goals ?? 0], ["助攻", stats.assists ?? 0]];
  const values = [...common, ...positionStats];
  const recent = stats.recentRatings?.length
    ? `<div class="winter-recent"><small>最近5场</small>${stats.recentRatings.map((item) => `<span class="rating-${item.rating >= 7.5 ? "great" : item.rating <= 5.5 ? "poor" : "normal"}">${item.rating.toFixed(1)}</span>`).join("")}</div>`
    : "";
  return `<dl>${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>${recent}`;
}

function lineupPayload() {
  const starters = run.formationSlots
    .filter((slot) => lineupState.starters[slot.slotId])
    .map((slot) => ({ slotId: slot.slotId, position: slot.position, playerId: lineupState.starters[slot.slotId] }));
  return { starters, tacticId: lineupState.tacticId };
}

function persistDraftLineup() {
  const payload = lineupPayload();
  lineupSaveQueue = lineupSaveQueue
    .catch(() => undefined)
    .then(() => pvpRoom ? pvpApi(`/api/pvp/rooms/${pvpRoom.code}/lineup/draft`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }) : api(`/api/runs/${run.runId}/lineup/draft`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }))
    .then((result) => {
      run.draftLineup = result.draftLineup;
      if (pvpRoom) pvpRoom.player.draftLineup = result.draftLineup;
    })
    .catch((error) => showToast(`阵容暂存失败：${error.message}`, "error"));
  return lineupSaveQueue;
}

async function startSeason(event) {
  const button = event.currentTarget;
  setBusy(button, true, pvpRoom ? "正在生成比赛…" : "正在生成赛程…");
  try {
    await lineupSaveQueue;
    if (pvpRoom) {
      pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpRoom.code}/ready`, { method: "POST", body: JSON.stringify(lineupPayload()) });
      return render();
    }
    run = await api(`/api/runs/${run.runId}/lineup`, {
      method: "PUT",
      body: JSON.stringify(lineupPayload())
    });
    button.textContent = "正在生成赛程…";
    season = await api(`/api/runs/${run.runId}/season/simulate`, { method: "POST", body: "{}" });
    run.status = season.completed ? "completed" : "simulating";
    seasonAutoPlay = true;
    render();
  } catch (error) {
    showToast(error.message, "error");
    if (run.status === "ready") renderReady();
    else setBusy(button, false);
  }
}

function renderReady() {
  const tactic = config.tactics.find((item) => item.id === run.lineup?.tacticId);
  app.innerHTML = `
    <section class="simulation-panel">
      <p class="eyebrow">Season ready</p>
      <h1>38轮，准备开踢。</h1>
      <p>11人阵容和“${escapeHtml(tactic?.name ?? "均衡")}”战术已经锁定。赛季将逐轮结算，第19轮结束后进入冬季转会窗口。</p>
      <button id="simulate-season" class="primary-button" type="button" style="margin-top:1.5rem;min-width:220px">开始赛季</button>
    </section>
  `;
  app.querySelector("#simulate-season").addEventListener("click", simulateSeason);
}

async function simulateSeason(event) {
  const button = event.currentTarget;
  setBusy(button, true, "正在生成赛程…");
  app.querySelector(".simulation-panel p:last-of-type").textContent = "正在生成赛程，第一轮将在开始后结算…";
  try {
    season = await api(`/api/runs/${run.runId}/season/simulate`, { method: "POST", body: "{}" });
    run.status = season.completed ? "completed" : "simulating";
    seasonAutoPlay = true;
    render();
  } catch (error) {
    showToast(error.message, "error");
    run.status = "ready";
    render();
  }
}

function renderSeasonLive() {
  if (!season) {
    app.innerHTML = '<section class="loading-panel"><span class="loader"></span><p>正在恢复逐场赛季…</p></section>';
    loadSeason();
    return;
  }
  if (season.winterWindow?.status === "open") {
    seasonAutoPlay = false;
    clearTimeout(seasonTimer);
    renderWinterWindow();
    return;
  }
  if (season.winterWindow?.status === "transferred" && season.winterWindow.transfer?.acknowledged === false) {
    seasonAutoPlay = false;
    clearTimeout(seasonTimer);
    renderWinterTransferResult();
    return;
  }
  if (season.pendingEvent) {
    seasonAutoPlay = false;
    clearTimeout(seasonTimer);
    renderSeasonEvent();
    return;
  }
  const latest = season.playerFixtures.at(-1);
  const standing = season.playerStanding;
  const transfer = season.winterWindow?.transfer;
  const transferNotice = transfer && season.progress === 19
    ? `<div class="season-notice"><span>冬窗交换完成</span><b>${escapeHtml(transfer.outgoingPlayer.name)} → ${escapeHtml(transfer.incomingPlayer.name)}</b><small>${escapeHtml(config.positionLabels?.[transfer.position] ?? transfer.position)}位置已经自动更新</small></div>`
    : "";
  app.innerHTML = `
    <section class="live-season-header">
      <div><p class="eyebrow">Live season</p><h1>${season.progress} / 38</h1><p>${latest ? `刚刚：${escapeHtml(latest.opponentName)} ${latest.goalsFor}–${latest.goalsAgainst}` : "赛季已生成，等待第一轮开球"}</p></div>
      <div class="live-record"><span>排名 <b>${standing?.rank ?? "—"}</b></span><span>积分 <b>${standing?.points ?? 0}</b></span><span>净胜球 <b>${standing ? `${standing.goalDifference >= 0 ? "+" : ""}${standing.goalDifference}` : "0"}</b></span></div>
      <div class="season-controls">
        <button id="toggle-season" class="secondary-button" type="button">${seasonAutoPlay ? "暂停" : "继续自动"}</button>
        <button id="next-match" class="secondary-button" type="button" ${seasonAdvancing ? "disabled" : ""}>下一场</button>
      </div>
    </section>
    ${transferNotice}
    <div class="live-season-grid">
      <section class="table-card live-matches-card"><header class="panel-head"><h2>逐场战况</h2><span>自动滚动到最新比赛</span></header><div id="live-match-list" class="live-match-list">${season.playerFixtures.length ? season.playerFixtures.map((fixture, index) => liveFixtureItem(fixture, index === season.playerFixtures.length - 1)).join("") : '<div class="empty-kickoff">等待开球…</div>'}</div></section>
      <section class="table-card"><header class="panel-head"><h2>实时积分榜</h2><span>第${season.progress}轮</span></header><div class="table-wrap">${season.standings.length ? standingsTable() : '<div class="empty-kickoff">第一轮结束后显示</div>'}</div></section>
    </div>
  `;
  app.querySelector("#toggle-season").addEventListener("click", () => {
    seasonAutoPlay = !seasonAutoPlay;
    clearTimeout(seasonTimer);
    renderSeasonLive();
  });
  app.querySelector("#next-match").addEventListener("click", () => {
    seasonAutoPlay = false;
    advanceSeason();
  });
  requestAnimationFrame(() => {
    const list = app.querySelector("#live-match-list");
    if (list) list.scrollTop = list.scrollHeight;
  });
  scheduleSeasonTick();
}

function renderWinterWindow() {
  const options = season.winterWindow.options ?? [];
  const selection = options.find((option) => option.slotId === selectedWinterSlotId);
  app.innerHTML = `
    <section class="season-interruption winter-window">
      <p class="eyebrow">Winter window · R19</p>
      <h1>是否参加冬窗？</h1>
      ${winterWindowEntered ? `
        <p>点击球员查看完整属性与半程数据，再在详情中选择交换位置。确认后该球员立即离队，系统随机换入一名同位置球员，不能取消或重选。</p>
        <div class="winter-player-grid">${options.map((option) => {
          const stats = option.stats ?? {};
          return `<button class="winter-player-card ${option.slotId === selectedWinterSlotId ? "selected" : ""}" data-winter-slot="${escapeHtml(option.slotId)}" type="button">
            <header><span>${escapeHtml(option.positionLabel)}</span><b>${escapeHtml(option.player.name)}</b><em class="player-form form-${escapeHtml(option.player.form?.tone ?? "normal")}">${escapeHtml(option.player.form?.label ?? "状态正常")}</em></header>
            ${winterStatsHtml(option)}
          </button>`;
        }).join("")}</div>
        <div class="winter-confirm-bar"><span>${selection ? `已选择：${escapeHtml(selection.positionLabel)} · ${escapeHtml(selection.player.name)}` : "请选择一个位置"}</span><button id="confirm-winter-transfer" class="primary-button" type="button" ${selection ? "" : "disabled"}>确认交换 · 不可撤销</button></div>
      ` : `
        <p>参加后选择一个位置进行一换一；换入球员完全随机，可能更强，也可能更差。</p>
        <div class="season-decision-actions"><button id="skip-winter-window" class="secondary-button" type="button">不参加</button><button id="enter-winter-window" class="primary-button" type="button">参加冬窗</button></div>
      `}
    </section>
    <dialog id="player-detail-dialog" class="player-detail-dialog"></dialog>
  `;
  app.querySelector("#enter-winter-window")?.addEventListener("click", () => {
    winterWindowEntered = true;
    renderWinterWindow();
  });
  app.querySelector("#skip-winter-window")?.addEventListener("click", (event) => decideWinterWindow(false, null, event.currentTarget));
  app.querySelectorAll("[data-winter-slot]").forEach((button) => button.addEventListener("click", () => {
    const option = options.find((item) => item.slotId === button.dataset.winterSlot);
    if (!option) return;
    openPlayerDetails(option.player, {
      stats: option.stats,
      actionLabel: `交换 ${option.positionLabel} 位置`,
      onAction: () => {
        selectedWinterSlotId = option.slotId;
        renderWinterWindow();
      }
    });
  }));
  app.querySelector("#confirm-winter-transfer")?.addEventListener("click", (event) => decideWinterWindow(true, selectedWinterSlotId, event.currentTarget));
}

async function decideWinterWindow(participate, slotId, button) {
  setBusy(button, true, participate ? "正在交换…" : "正在关闭…");
  try {
    season = await api(`/api/runs/${run.runId}/season/winter-window`, {
      method: "POST",
      body: JSON.stringify({ participate, ...(slotId ? { slotId } : {}) })
    });
    run = await api(`/api/runs/${run.runId}`);
    winterWindowEntered = false;
    selectedWinterSlotId = null;
    seasonAutoPlay = !participate;
    if (participate && season.winterWindow.transfer) {
      showToast(`${season.winterWindow.transfer.incomingPlayer.name} 已完成冬窗加盟`);
    }
    render();
  } catch (error) {
    showToast(error.message, "error");
    renderWinterWindow();
  }
}

function winterComparisonCard(player, label, comparison = null) {
  const ratings = Object.entries(player.summaryRatings).map(([name, value]) => {
    const delta = comparison ? Number(value) - Number(comparison.summaryRatings?.[name] ?? value) : 0;
    return `<div><small>${escapeHtml(name)}</small><b>${Number(value).toFixed(1)}</b>${comparison ? `<em class="${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta > 0 ? "+" : ""}${delta.toFixed(1)}</em>` : ""}</div>`;
  }).join("");
  return `<article class="winter-comparison-card"><header><span>${escapeHtml(label)}</span><div><h2>${escapeHtml(player.name)}</h2><p>${escapeHtml(player.club)} · ${escapeHtml(player.bestPositionDisplay)}</p></div><em class="player-form form-${escapeHtml(player.form?.tone ?? "normal")}">${escapeHtml(player.form?.label ?? "状态正常")}</em></header><div class="winter-comparison-ratings">${ratings}</div><div class="radar-wrap"><canvas data-radar='${escapeHtml(JSON.stringify({ ratings: player.summaryRatings, pool: player.draftPool }))}'></canvas></div></article>`;
}

function renderWinterTransferResult() {
  const transfer = season.winterWindow.transfer;
  app.innerHTML = `
    <section class="season-interruption winter-result">
      <p class="eyebrow">Winter window · 交换完成</p>
      <h1>${escapeHtml(config.positionLabels?.[transfer.position] ?? transfer.position)}位置已经换人</h1>
      <p>交换已经生效，下面是离队与加盟球员的当前属性、状态及逐项差值。</p>
      <div class="winter-comparison-grid">
        ${winterComparisonCard(transfer.outgoingPlayer, "离队球员")}
        ${winterComparisonCard(transfer.incomingPlayer, "加盟球员", transfer.outgoingPlayer)}
      </div>
      <div class="winter-result-action"><button id="continue-after-transfer" class="primary-button" type="button">继续联赛</button></div>
    </section>
  `;
  app.querySelector("#continue-after-transfer")?.addEventListener("click", acknowledgeWinterTransfer);
  requestAnimationFrame(drawAllRadars);
}

async function acknowledgeWinterTransfer(event) {
  setBusy(event.currentTarget, true, "继续中…");
  try {
    season = await api(`/api/runs/${run.runId}/season/winter-window/acknowledge`, { method: "POST", body: "{}" });
    seasonAutoPlay = true;
    render();
  } catch (error) {
    showToast(error.message, "error");
    renderWinterTransferResult();
  }
}

function renderSeasonEvent() {
  const event = season.pendingEvent;
  const resolved = event.status === "resolved";
  const choices = resolved ? "" : `<div class="season-event-choices">${event.choices.map((choice) => `
    <button type="button" data-event-choice="${escapeHtml(choice.id)}">
      <b>${escapeHtml(choice.label)}</b>
      <span>${escapeHtml(choice.description)}</span>
    </button>
  `).join("")}</div>`;
  const subject = event.scope === "team"
    ? `<article><span>全队</span><b>球队整体</b><small>效果会影响全部首发</small></article>`
    : `<article class="season-event-player" role="button" tabindex="0" title="查看球员当前属性"><span>${escapeHtml(config.positionLabels?.[event.position] ?? event.position)}</span><b>${escapeHtml(event.playerName)}${event.secondaryPlayerName ? ` / ${escapeHtml(event.secondaryPlayerName)}` : ""}</b><small>查看当前状态与属性</small></article>`;
  const effectLines = event.result?.effects?.length
    ? `<ul class="season-event-effects">${event.result.effects.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : "";
  app.innerHTML = `
    <section class="season-interruption season-event ${escapeHtml(event.tone ?? "pending")}">
      <p class="eyebrow">球队事件 · R${event.round}</p>
      <h1>${escapeHtml(event.title)}</h1>
      <p>${escapeHtml(event.description)}</p>
      ${subject}
      ${resolved ? `<div class="season-event-result ${escapeHtml(event.tone)}"><b>${event.result.positive ? "处理奏效" : "事与愿违"}</b><span>${escapeHtml(event.result.summary)}</span></div>${effectLines}<button id="acknowledge-season-event" class="primary-button" type="button">继续赛季</button>` : choices}
    </section>
    <dialog id="player-detail-dialog" class="player-detail-dialog"></dialog>
  `;
  const showEventPlayer = () => openPlayerDetails(event.player);
  app.querySelector(".season-event-player")?.addEventListener("click", showEventPlayer);
  app.querySelector(".season-event-player")?.addEventListener("keydown", (keyEvent) => {
    if (["Enter", " "].includes(keyEvent.key)) showEventPlayer();
  });
  app.querySelectorAll("[data-event-choice]").forEach((button) => button.addEventListener("click", (clickEvent) => chooseSeasonEvent(button.dataset.eventChoice, clickEvent.currentTarget)));
  app.querySelector("#acknowledge-season-event")?.addEventListener("click", acknowledgeSeasonEvent);
}

async function chooseSeasonEvent(choiceId, button) {
  setBusy(button, true, "结算中…");
  try {
    season = await api(`/api/runs/${run.runId}/season/event/choose`, {
      method: "POST",
      body: JSON.stringify({ choiceId })
    });
    renderSeasonEvent();
  } catch (error) {
    showToast(error.message, "error");
    renderSeasonEvent();
  }
}

async function acknowledgeSeasonEvent(event) {
  setBusy(event.currentTarget, true, "继续中…");
  try {
    season = await api(`/api/runs/${run.runId}/season/event/acknowledge`, { method: "POST", body: "{}" });
    seasonAutoPlay = true;
    render();
  } catch (error) {
    showToast(error.message, "error");
    renderSeasonEvent();
  }
}

function scheduleSeasonTick() {
  clearTimeout(seasonTimer);
  if (!seasonAutoPlay || seasonAdvancing || season?.completed) return;
  seasonTimer = setTimeout(advanceSeason, 900);
}

async function advanceSeason() {
  if (seasonAdvancing || season?.completed) return;
  seasonAdvancing = true;
  try {
    season = await api(`/api/runs/${run.runId}/season/advance`, { method: "POST", body: "{}" });
    run.status = season.completed ? "completed" : "simulating";
    seasonAdvancing = false;
    render();
  } catch (error) {
    seasonAutoPlay = false;
    showToast(error.message, "error");
    renderSeasonLive();
  } finally {
    seasonAdvancing = false;
  }
}

function matchEventHtml(event) {
  const side = event.side === "player" ? "mine" : "theirs";
  let text = "";
  if (event.type === "goal") text = `⚽ ${escapeHtml(event.playerName)}${event.assistPlayerName ? `（助攻 ${escapeHtml(event.assistPlayerName)}）` : ""}`;
  else if (event.type === "own_goal") text = `⚽ 乌龙球 · ${escapeHtml(event.description ?? event.playerName)}`;
  else if (event.type === "error") text = `⚠ ${escapeHtml(event.description ?? `${event.playerName}出现失误`)}`;
  return `<li class="event-${side}"><time>${event.minute}'</time><span>${text}</span></li>`;
}

function liveFixtureItem(fixture, open = false) {
  const badge = fixture.outcome === "win" ? "胜" : fixture.outcome === "draw" ? "平" : "负";
  const ratings = fixture.playerRatings?.length ? `<div class="match-player-ratings"><small>本场评分</small>${fixture.playerRatings.map((player) => `<span><b>${escapeHtml(player.name)}</b><i>${escapeHtml(player.summary)}</i><em class="rating-${player.rating >= 7.5 ? "great" : player.rating <= 5.5 ? "poor" : "normal"}">${player.rating.toFixed(1)}</em></span>`).join("")}</div>` : "";
  return `<details class="live-fixture ${fixture.outcome}" ${open ? "open" : ""}><summary><span class="round">R${fixture.round}</span><span><b>${escapeHtml(fixture.opponentName)}</b><small>${fixture.venue === "home" ? "主场" : "客场"}</small></span><i class="form-badge ${fixture.outcome}">${badge}</i><strong>${fixture.goalsFor} — ${fixture.goalsAgainst}</strong></summary><ul class="event-timeline">${fixture.events.length ? fixture.events.map(matchEventHtml).join("") : "<li><span>本场没有进球</span></li>"}</ul>${ratings}</details>`;
}

function buildReviewHtml() {
  const review = season.review;
  if (!review) return "";
  const observations = [
    review.leaders.scorer ? `队内射手王：${review.leaders.scorer}` : null,
    review.leaders.creator ? `队内助攻王：${review.leaders.creator}` : null,
    review.runs.bestWin !== "—" ? `最大胜利：${review.runs.bestWin}` : null,
    review.runs.worstLoss !== "—" ? `最重失利：${review.runs.worstLoss}` : null,
    `最长连胜${review.runs.longestWinningRun}场，最长不败${review.runs.longestUnbeatenRun}场`,
    review.decisions.transfer,
    review.decisions.event ? `影响最大的事件：${review.decisions.event}` : null
  ].filter(Boolean);
  const standout = review.standout;
  return `<section class="build-review"><header><div><p class="eyebrow">赛季总结</p><h2>${escapeHtml(review.headline)}</h2></div></header><div class="build-review-grid"><div><small>前19轮</small><b>${review.firstHalf.points} 分</b><p>${review.firstHalf.rank ? `半程第 ${review.firstHalf.rank} 名` : "半程排名暂无"}</p></div><div><small>后19轮</small><b>${review.secondHalf.points} 分</b><p>最终第 ${review.secondHalf.rank} 名</p></div><div><small>赛季最佳</small><b>${standout ? escapeHtml(standout.name) : "—"}</b><p>${standout ? `${standout.rating.toFixed(2)}分 · ${standout.goals}球${standout.assists}助 · 参与${standout.involvementPct}%进球` : "暂无评分"}</p></div><ol>${observations.map((observation) => `<li>${escapeHtml(observation)}</li>`).join("")}</ol></div></section>`;
}

function renderResults() {
  if (!season) {
    app.innerHTML = '<section class="loading-panel"><span class="loader"></span><p>正在读取赛季结果…</p></section>';
    loadSeason();
    return;
  }
  const standing = season.playerStanding;
  const form = season.playerFixtures.slice(-5).map((fixture) => `<span class="form-badge ${fixture.outcome}">${fixture.outcome === "win" ? "胜" : fixture.outcome === "draw" ? "平" : "负"}</span>`).join("");
  app.innerHTML = `
    <section class="result-hero">
      <div class="rank-orb"><span><b>${season.playerRank}</b><small>最终排名</small></span></div>
      <div><p class="eyebrow">Season complete</p><h1>${standing.points}分 · ${standing.goalDifference >= 0 ? "+" : ""}${standing.goalDifference}净胜球</h1><p>末五轮走势 ${form}</p></div>
      <div class="record"><div><b>${standing.won}</b><small>胜</small></div><div><b>${standing.drawn}</b><small>平</small></div><div><b>${standing.lost}</b><small>负</small></div></div>
    </section>
    ${buildReviewHtml()}
    <div class="result-grid">
      <section class="table-card"><header class="panel-head"><h2>英超积分榜</h2><span>38轮最终排名</span></header><div class="table-wrap">${standingsTable()}</div></section>
      <section class="table-card"><header class="panel-head"><h2>我的38场</h2><span>点击查看进球与球员评分</span></header><div class="results-list detailed-results">${season.playerFixtures.map((fixture) => liveFixtureItem(fixture)).join("")}</div></section>
    </div>
    <section class="table-card" style="margin-top:1rem"><header class="panel-head"><h2>队内球员数据</h2><span>实际比赛事件累计</span></header><div class="table-wrap">${playerStatsTable()}</div></section>
    <div class="final-actions"><button id="result-restart" class="primary-button" type="button">重新选秀</button></div>
  `;
  app.querySelector("#result-restart").addEventListener("click", () => confirmDialog.showModal());
}

async function loadSeason() {
  try {
    season = await api(`/api/runs/${run.runId}/season`);
    if (season.completed) run.status = "completed";
    render();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function standingsTable() {
  return `<table><thead><tr><th>#</th><th>球队</th><th>赛</th><th>胜</th><th>平</th><th>负</th><th>进</th><th>失</th><th>净</th><th>分</th></tr></thead><tbody>${season.standings.map((row) => `<tr class="${row.isPlayer ? "player-row" : ""}"><td>${row.rank}</td><td>${escapeHtml(row.name)}</td><td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td>${row.goalsFor}</td><td>${row.goalsAgainst}</td><td>${row.goalDifference}</td><td><b>${row.points}</b></td></tr>`).join("")}</tbody></table>`;
}

function resultItem(fixture) {
  const badge = fixture.outcome === "win" ? "胜" : fixture.outcome === "draw" ? "平" : "负";
  return `<article class="result-item"><div class="round">R${fixture.round}</div><div><b>${escapeHtml(fixture.opponentName)}</b><span>${fixture.venue === "home" ? "主场" : "客场"} · <i class="form-badge ${fixture.outcome}">${badge}</i></span></div><span class="scoreline">${fixture.goalsFor} — ${fixture.goalsAgainst}</span></article>`;
}

function playerStatsTable() {
  return `<table><thead><tr><th>#</th><th>球员</th><th>位置</th><th>出场</th><th>进球</th><th>助攻</th><th>评分</th><th>最近5场</th><th>阶段</th></tr></thead><tbody>${season.playerStats.map((row, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.bestPosition)}</td><td>${row.appearances}</td><td><b>${row.goals}</b></td><td>${row.assists}</td><td>${row.averageRating?.toFixed(2) ?? "—"}</td><td class="table-recent-ratings">${row.recentRatings?.map((item) => `<span class="rating-${item.rating >= 7.5 ? "great" : item.rating <= 5.5 ? "poor" : "normal"}">${item.rating.toFixed(1)}</span>`).join("") || "—"}</td><td>${row.rosterStatus === "departed" ? "冬窗离队" : row.rosterStatus === "winterArrival" ? "冬窗加盟" : "全程在队"}</td></tr>`).join("")}</tbody></table>`;
}

restartButton.addEventListener("click", () => confirmDialog.showModal());
cancelRestart.addEventListener("click", () => confirmDialog.close());
confirmRestart.addEventListener("click", async () => {
  confirmRestart.disabled = true;
  try {
    if (run && !pvpRoom) await api(`/api/runs/${run.runId}`, { method: "DELETE" });
    localStorage.removeItem("fm26-run-id");
    sessionStorage.removeItem("fm26-pvp-code");
    sessionStorage.removeItem("fm26-pvp-token");
    pvpRoom = null;
    pvpCodeValue = "";
    pvpToken = "";
    clearTimeout(pvpPollTimer);
    cancelAnimationFrame(pvpPlaybackFrame);
    run = null;
    season = null;
    winterWindowEntered = false;
    selectedWinterSlotId = null;
    setupPlaystyleOptions = [];
    setupPlaystyleId = null;
    lineupState = null;
    selectedPlayerId = null;
    selectedCandidateId = null;
    confirmDialog.close();
    render();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    confirmRestart.disabled = false;
  }
});

async function initialize() {
  try {
    config = await api("/api/config");
    if (pvpCodeValue && pvpToken) {
      try {
        pvpRoom = await pvpApi(`/api/pvp/rooms/${pvpCodeValue}`);
      } catch {
        sessionStorage.removeItem("fm26-pvp-code");
        sessionStorage.removeItem("fm26-pvp-token");
        pvpCodeValue = "";
        pvpToken = "";
      }
    }
    const savedRunId = localStorage.getItem("fm26-run-id");
    if (savedRunId && !pvpRoom) {
      try {
        run = await api(`/api/runs/${savedRunId}`);
        lineupState = hydrateLineupState(run.draftLineup);
      } catch {
        localStorage.removeItem("fm26-run-id");
      }
    }
    render();
  } catch (error) {
    app.innerHTML = `<section class="empty-state"><b>无法启动游戏</b><span>${escapeHtml(error.message)}</span></section>`;
  }
}

initialize();
