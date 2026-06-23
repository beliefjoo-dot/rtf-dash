// ── 탭 렌더 ──────────────────────────────────────────────────────────────────
function renderTabs(activeId) {
  tabNav.innerHTML = menus.map(([id, label]) =>
    `<button type="button" class="tab-btn ${id === activeId ? "active" : ""}" data-menu-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`,
  ).join("");
  tabNav.querySelectorAll("[data-menu-id]").forEach((btn) =>
    btn.addEventListener("click", () => render(btn.dataset.menuId)));
}

// ── 회의체계 ─────────────────────────────────────────────────────────────────
function renderMeeting() {
  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">local mode</p><h2>로컬 파일 모드</h2></div>
      <p>서버 없이 index.html을 직접 열어 사용합니다. 데이터점검 화면에서 RAW 파일을 선택하면 브라우저 메모리에서만 읽어 RTF 화면에 반영합니다.</p>
    </div>
    <div class="process-grid">
      <article class="card process-card"><h3>1. RAW 선택</h3><p>데이터점검에서 엑셀 파일을 복수 선택합니다.</p></article>
      <article class="card process-card"><h3>2. RTF 확인</h3><p>사업부별/플랜트별/유형별 계층형 월별 매트릭스를 확인합니다.</p></article>
      <article class="card process-card"><h3>3. 상세 점검</h3><p>그룹을 펼쳐 유형, 품목군, 자재별 월별 항목을 확인합니다.</p></article>
    </div>
  </section>`;
}

// ── 데이터점검 ────────────────────────────────────────────────────────────────
function renderDataCheck() {
  const parsedFiles = Object.values(state.rawFiles);
  const uploadRows  = state.uploadedFiles.map((file) => [
    escapeHtml(file.name),
    formatBytes(file.size),
    escapeHtml(file.rawType ?? "-"),
    file.parseSuccess ? badge("ok","읽기 성공") : file.parseStatus === "error" ? badge("missing", file.parseMessage ?? "읽기 실패") : badge("warn","대기"),
    file.sheetNames?.length ? file.sheetNames.map(escapeHtml).join(", ") : "-",
    file.rowCount?.toLocaleString("ko-KR") ?? "-",
  ]);
  const requiredRows = requiredFiles.map((file) => {
    const parsed = parsedFiles.find((raw) => raw.rawType === file.id || raw.name === file.label);
    return [escapeHtml(file.label), parsed ? badge("ok","연결 완료") : badge("missing","미연결"), parsed ? escapeHtml(parsed.name) : "-"];
  });
  const counts = state.mappedData;
  return `<section class="section-band">
    <div class="section-header">
      <div><p class="eyebrow">local raw</p><h2>RAW 파일 선택</h2></div>
      <p>필요한 RAW 엑셀 파일을 모두 선택하세요. 선택한 파일은 브라우저 메모리에서만 읽고 원본은 수정하지 않습니다.</p>
    </div>
    <div class="upload-zone">
      <label for="rawUpload"><strong>RAW 파일 선택</strong></label>
      <input id="rawUpload" type="file" multiple accept=".xlsx,.xls,.xlsm,.csv" />
    </div>
  </section>
  <section class="section-band"><div class="section-header"><h2>필수 파일 연결 여부</h2></div>${renderTable(["필수 파일","상태","선택된 파일"], requiredRows)}</section>
  <section class="section-band"><div class="section-header"><h2>읽기 상태</h2></div>${renderTable(["파일명","크기","RAW 유형","읽기 상태","시트명","행 수"], uploadRows)}</section>
  <section class="section-band"><div class="section-header"><h2>매핑 결과</h2></div>${renderTable(["테이블","행 수"], [
    ["판매/공급계획", formatNumber(counts.plan_monthly.length)],
    ["기초재고",      formatNumber(counts.inventory_base.length)],
    ["사업부 기준정보", formatNumber(counts.item_master.length)],
    ["BOM",          formatNumber(counts.bom_components.length)],
  ])}</section>`;
}

function bindDataCheck() {
  document.querySelector("#rawUpload")?.addEventListener("change", (e) =>
    processFiles(Array.from(e.target.files ?? [])));
}

// ── 플레이스홀더 ──────────────────────────────────────────────────────────────
function renderPlaceholder(title) {
  return `<section class="section-band"><div class="section-header"><h2>${escapeHtml(title)}</h2><p>현재 로컬 파일 모드에서는 데이터점검과 RTF 화면을 중심으로 사용합니다.</p></div></section>`;
}

// ── 재고전망 ──────────────────────────────────────────────────────────────────
function renderInventoryForecast() {
  return `<section class="section-band">
    <div class="section-header">
      <div><h2>현재 계획 기준 재고금액·재고일수 전망</h2></div>
      <p>현재 판매계획·공급계획 기준으로 월별 재고금액 및 재고일수를 전망합니다.</p>
    </div>
    <div class="adj-candidate-area">
      <button type="button" class="adj-candidate-btn" disabled title="조정입력 연계 기능은 후속 단계에서 구현 예정입니다.">조정안에 담기</button>
      <span class="adj-candidate-hint">조정입력 연계 기능은 후속 단계에서 구현 예정입니다.</span>
    </div>
    <div class="notice-no-data">재고전망 화면은 후속 단계에서 구현 예정입니다.</div>
  </section>`;
}

// ── 수급진단 ──────────────────────────────────────────────────────────────────
function renderDiagnosis() {
  const adjTypes = ["RTF 개선","적정재고 초과 조정","생산 Pull-in","생산 이연","입고 추가","입고 이연","공급계획 감량","공통자재 배분 확인"];
  return `<section class="section-band">
    <div class="section-header">
      <div><h2>수급진단 및 조정 대상 선별</h2></div>
      <p>RTF 개선 대상과 적정재고 초과 조정 대상을 함께 선별합니다.</p>
    </div>
    <div class="adj-candidate-area">
      <button type="button" class="adj-candidate-btn" disabled title="조정입력 연계 기능은 후속 단계에서 구현 예정입니다.">조정안에 담기</button>
      <span class="adj-candidate-hint">조정입력 연계 기능은 후속 단계에서 구현 예정입니다.</span>
    </div>
    <div class="notice-no-data">
      <strong>조정 유형 기준 (향후 구현 예정)</strong><br><br>
      ${adjTypes.map(t => `<span class="cause-type-tag" style="margin:3px 4px 3px 0;display:inline-block;">${escapeHtml(t)}</span>`).join(" ")}
    </div>
  </section>`;
}

// ── 화면 전환 ─────────────────────────────────────────────────────────────────
function render(menuId) {
  state.currentMenuId = menuId;
  const menu = menus.find(([id]) => id === menuId) || menus[0];
  screenTitle.textContent = menu[2] || menu[1];
  renderTabs(menu[0]);
  const screens = {
    "meeting":            renderMeeting,
    "data-check":         renderDataCheck,
    "rtf":                 renderRtf,
    "summary":             () => renderPlaceholder("수급관리 종합현황"),
    "constraint":          renderConstraint,
    "inventory-forecast":  renderInventoryForecast,
    "inventory-variance":  () => renderPlaceholder("재고금액 변동분석"),
    "diagnosis":           renderDiagnosis,
    "adjustment":          () => renderPlaceholder("조정안 입력"),
    "impact":              () => renderPlaceholder("조정 후 영향 분석"),
    "minutes":             () => renderPlaceholder("회의록 및 의견 관리"),
  };
  screenRoot.innerHTML = (screens[menu[0]] || renderMeeting)();
  if (menu[0] === "data-check") bindDataCheck();
  if (menu[0] === "rtf")        bindRtf();
  if (menu[0] === "constraint") bindConstraint();
}

// ── 시작 ─────────────────────────────────────────────────────────────────────
render("meeting");
