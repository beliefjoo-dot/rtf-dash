// ── 전개 상태 상수 ────────────────────────────────────────────────────────────
var BOM_STATUS = { IDLE:"idle", RUNNING:"running", DONE:"done", FAILED:"failed" };
var _bomAnimId = 0;

// ── 컬럼 정의 ─────────────────────────────────────────────────────────────────
var CONSTR_LEFT_COLS = [
  { key:"plant",        label:"플랜트",       width:60,  align:"center" },
  { key:"itemGroup",    label:"품목군",        width:82,  align:"left"   },
  { key:"itemCategory", label:"제약대상 유형", width:80,  align:"center" },
  { key:"shareType",    label:"공용/전용",     width:60,  align:"center" },
  { key:"code",         label:"자재코드",      width:90,  align:"center" },
  { key:"name",         label:"자재명",        width:160, align:"left",  isName:true },
  { key:"impactCount",  label:"영향\n품목수",  width:50,  align:"center" },
  { key:"impactItem",   label:"대표 영향품목", width:130, align:"left"   },
  { key:"note",         label:"확인 필요사항", width:160, align:"left",  isLast:true },
];
var CONSTR_METRIC_W = 70;
var CONSTR_METRICS  = ["필요","가용","부족"];

// ── BOM 전개 엔진 ─────────────────────────────────────────────────────────────
function computeBomExpansion() {
  const planRows      = state.mappedData.plan_monthly;
  const inventoryRows = state.mappedData.inventory_base;
  const bomRows       = state.mappedData.bom_components;
  const masterRows    = state.mappedData.item_master;
  const months        = getRtfMonths();
  const result        = { status:BOM_STATUS.FAILED, failReasons:[], completedAt:null, items:[], stats:{} };

  if (!planRows.length)      result.failReasons.push("판매계획 연결 필요");
  if (!bomRows.length)        result.failReasons.push("BOM 연결 필요");
  if (!inventoryRows.length)  result.failReasons.push("현재고 연결 필요");
  if (result.failReasons.length) return result;

  // 기본 BOM 필터 (alternativeBom 공란 or "1")
  const baseBomRows = bomRows.filter(r => {
    const alt = cleanOptional(r.alternativeBom);
    return alt === "" || alt === "1";
  });
  if (!baseBomRows.length) {
    result.failReasons.push("BOM 연결 필요 (기본 BOM 항목 없음)");
    return result;
  }

  // 완제품 정보 map: rootCode|plant → {code, name}
  const finishedItemMap = new Map();
  baseBomRows.forEach(r => {
    const key = `${r.rootItemCode}|${r.plant}`;
    if (!finishedItemMap.has(key))
      finishedItemMap.set(key, { code:r.rootItemCode, name:cleanText(r.rootItemName, r.rootItemCode) });
  });

  // 완제품 생산계획: code|plant|month → supplyQty (9코드만)
  const prodPlanMap = new Map();
  planRows.forEach(row => {
    const code = cleanOptional(row.itemCode);
    if (!code || !code.startsWith("9")) return;
    const key = `${code}|${cleanOptional(row.plant)}|${cleanOptional(row.month)}`;
    prodPlanMap.set(key, (prodPlanMap.get(key) ?? 0) + (cleanNumber(row.supplyQty) ?? 0));
  });

  // 하위 자재 공급계획: code|plant|month → supplyQty
  const compSupplyMap = new Map();
  planRows.forEach(row => {
    const code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant), month = cleanOptional(row.month);
    if (!code || !plant || !month) return;
    const key = `${code}|${plant}|${month}`;
    compSupplyMap.set(key, (compSupplyMap.get(key) ?? 0) + (cleanNumber(row.supplyQty) ?? 0));
  });

  // 기초재고: code|plant → baseQty
  const inventoryMap = new Map();
  inventoryRows.forEach(row => {
    const code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    const key = `${code}|${plant}`;
    inventoryMap.set(key, (inventoryMap.get(key) ?? 0) + (cleanNumber(row.baseQty) ?? 0));
  });

  // 기준정보 map
  const masterMap = new Map();
  masterRows.forEach(r => { if (r.itemCode && !masterMap.has(r.itemCode)) masterMap.set(r.itemCode, r); });

  // 구성품별 소요량 집계: compCode|plant → comp data
  const compReqs = new Map();
  baseBomRows.forEach(bom => {
    const rootKey = `${bom.rootItemCode}|${bom.plant}`;
    const compKey = `${bom.componentCode}|${bom.plant}`;
    const parent  = finishedItemMap.get(rootKey);

    if (!compReqs.has(compKey)) {
      compReqs.set(compKey, {
        componentCode:   bom.componentCode,
        componentName:   bom.componentName,
        plant:           bom.plant,
        itemCategory:    cleanOptional(bom.itemCategory),
        parentItems:     new Map(),
        requiredByMonth: new Map(),
      });
    }
    const comp = compReqs.get(compKey);
    if (!comp.parentItems.has(rootKey))
      comp.parentItems.set(rootKey, { code:bom.rootItemCode, name:parent?.name || bom.rootItemCode });

    months.forEach(month => {
      const prodQty = prodPlanMap.get(`${bom.rootItemCode}|${bom.plant}|${month}`) ?? 0;
      const ratio   = bom.baseQty > 0 ? bom.componentQty / bom.baseQty : bom.componentQty;
      comp.requiredByMonth.set(month, (comp.requiredByMonth.get(month) ?? 0) + prodQty * ratio);
    });
  });

  // 월별 순차 계산
  const resultItems = [];
  compReqs.forEach(comp => {
    const invKey   = `${comp.componentCode}|${comp.plant}`;
    const hasInv   = inventoryMap.has(invKey);
    const baseQty  = hasInv ? (inventoryMap.get(invKey) ?? 0) : null;
    const master   = masterMap.get(comp.componentCode);
    const isShared = comp.parentItems.size > 1;
    const parentArr = [...comp.parentItems.values()];

    let openingQty = baseQty;
    const monthlyData = [];
    let hasAnyShortage = false;

    months.forEach(month => {
      const requiredQty = comp.requiredByMonth.get(month) ?? 0;
      const supplyQty   = compSupplyMap.get(`${comp.componentCode}|${comp.plant}|${month}`) ?? 0;
      let availableQty = null, shortageQty = null;

      if (openingQty !== null) {
        availableQty = openingQty + supplyQty;
        shortageQty  = Math.max(requiredQty - availableQty, 0);
        const endingQty = Math.max(availableQty - requiredQty, 0);
        if (shortageQty > 0) hasAnyShortage = true;
        openingQty = endingQty;
      }
      monthlyData.push({ month, requiredQty, availableQty, shortageQty });
    });

    const hasReq = monthlyData.some(md => md.requiredQty > 0);
    if (!hasReq) return; // 소요량 없으면 스킵

    let note = "";
    if (!hasInv)                         note = "현재고 데이터 연결 필요";
    else if (isShared && hasAnyShortage) note = "공통자재 부족 발생. 완제품별 배분기준 확인 필요";

    resultItems.push({
      plant:         comp.plant,
      componentCode: comp.componentCode,
      componentName: cleanText(comp.componentName, comp.componentCode),
      itemCategory:  comp.itemCategory || NEED_MASTER,
      itemGroup:     cleanText(master?.itemGroup, NEED_MASTER),
      isShared,
      parentItems:   parentArr,
      hasInventory:  hasInv,
      monthlyData,
      hasAnyShortage,
      note,
    });
  });

  // 제약 대상만 (부족 발생 or 현재고 없음)
  const constraintItems = resultItems.filter(i => i.hasAnyShortage || !i.hasInventory);
  constraintItems.sort((a, b) => {
    const p = a.plant.localeCompare(b.plant, "ko-KR"); if (p) return p;
    const c = a.itemCategory.localeCompare(b.itemCategory, "ko-KR"); if (c) return c;
    return a.componentName.localeCompare(b.componentName, "ko-KR");
  });

  result.status      = BOM_STATUS.DONE;
  result.completedAt = new Date();
  result.items       = constraintItems;
  result.stats = {
    totalConstraints:  constraintItems.filter(i => i.hasAnyShortage).length,
    sharedConstraints: constraintItems.filter(i => i.isShared && i.hasAnyShortage).length,
    dedicatedShortage: constraintItems.filter(i => !i.isShared && i.hasAnyShortage).length,
    needMaster:        constraintItems.filter(i => i.itemGroup === NEED_MASTER || i.itemCategory === NEED_MASTER).length,
    needData:          constraintItems.filter(i => !i.hasInventory).length,
  };
  return result;
}

// ── 전개 완료 요약 카드 ────────────────────────────────────────────────────────
function renderConstraintSummaryCard(result) {
  const s       = result.stats;
  const fmtTime = result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : "-";
  const items = [
    { label:"전개상태",           value:"완료",                              cls:"ok"       },
    { label:"전개완료시각",       value:fmtTime,                             cls:""         },
    { label:"제약대상 수",        value:s.totalConstraints  > 0 ? String(s.totalConstraints)  : "-", cls:s.totalConstraints  > 0 ? "shortage" : "" },
    { label:"공용자재 제약 수",   value:s.sharedConstraints > 0 ? String(s.sharedConstraints) : "-", cls:s.sharedConstraints > 0 ? "warn"     : "" },
    { label:"전용자재 부족 수",   value:s.dedicatedShortage > 0 ? String(s.dedicatedShortage) : "-", cls:s.dedicatedShortage > 0 ? "shortage" : "" },
    { label:"기준정보 확인 필요", value:s.needMaster        > 0 ? String(s.needMaster)        : "-", cls:s.needMaster        > 0 ? "warn"     : "" },
    { label:"데이터 연결 필요",   value:s.needData          > 0 ? String(s.needData)          : "-", cls:s.needData          > 0 ? "warn"     : "" },
  ];
  return `<section class="cst-card cst-summary-card">
    <div class="cst-summary-grid">${items.map(i =>
      `<div class="cst-sum-item"><div class="cst-sum-label">${escapeHtml(i.label)}</div><div class="cst-sum-value${i.cls ? " " + i.cls : ""}">${escapeHtml(i.value)}</div></div>`
    ).join("")}</div>
  </section>`;
}

// ── 결과 표 ──────────────────────────────────────────────────────────────────
function renderConstraintTable(items) {
  const months = getRtfMonths();
  let leftPos  = 0;
  const cols   = CONSTR_LEFT_COLS.map(c => { const r = { ...c, left:leftPos }; leftPos += c.width; return r; });
  const minW   = leftPos + months.length * CONSTR_METRICS.length * CONSTR_METRIC_W;

  const colgroup = [
    ...cols.map(c => `<col style="width:${c.width}px;">`),
    ...months.flatMap(() => CONSTR_METRICS.map(() => `<col style="width:${CONSTR_METRIC_W}px;">`)),
  ].join("");

  const leftHeaders = cols.map(col => {
    const aCls = col.align === "left" ? " cst-cell-left" : "";
    const xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
    return `<th class="cst-sticky${aCls}${xCls}" style="left:${col.left}px;width:${col.width}px;" rowspan="2">${escapeHtml(col.label)}</th>`;
  }).join("");

  const monthHead = months.map((m, mi) =>
    `<th class="cst-month-head${mi > 0 ? " cst-month-start" : ""}" colspan="${CONSTR_METRICS.length}">${escapeHtml(monthLabel(m))}</th>`
  ).join("");

  const metricHead = months.flatMap((_, mi) =>
    CONSTR_METRICS.map((metric, ci) =>
      `<th class="cst-sub-head${metric === "부족" ? " cst-key-sub" : ""}${ci === 0 && mi > 0 ? " cst-month-start" : ""}">${escapeHtml(metric)}</th>`
    )
  ).join("");

  const bodyRows = items.length ? items.map(item => {
    const leftCells = cols.map(col => {
      const aCls = col.align === "left" ? " cst-cell-left" : "";
      const xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
      let value = "";
      if      (col.key === "plant")        value = displayPlantName(item.plant);
      else if (col.key === "itemGroup")    value = item.itemGroup === NEED_MASTER ? "확인필요" : item.itemGroup;
      else if (col.key === "itemCategory") value = item.itemCategory === NEED_MASTER ? "확인필요" : item.itemCategory;
      else if (col.key === "shareType")    value = item.isShared ? "공용" : "전용";
      else if (col.key === "code")         value = item.componentCode;
      else if (col.key === "name")         value = item.componentName;
      else if (col.key === "impactCount")  value = String(item.parentItems.length);
      else if (col.key === "impactItem")   value = item.parentItems[0]?.name || "-";
      else if (col.key === "note")         value = item.note || "-";
      const titleAttr = (col.isName || col.key === "note" || col.key === "impactItem") ? ` title="${escapeHtml(value)}"` : "";
      return `<td class="cst-sticky cst-td${aCls}${xCls}" style="left:${col.left}px;width:${col.width}px;"${titleAttr}>${escapeHtml(value)}</td>`;
    }).join("");

    const metricCells = item.monthlyData.flatMap((md, mi) =>
      CONSTR_METRICS.map((metric, ci) => {
        const borderCls = ci === 0 && mi > 0 ? " cst-month-start" : "";
        let value = "-", cls = "cst-metric-cell";
        if (metric === "필요") {
          value = md.requiredQty > 0 ? formatNumber(Math.round(md.requiredQty)) : "-";
        } else if (metric === "가용") {
          value = md.availableQty !== null ? formatNumber(Math.round(md.availableQty)) : "연결필요";
        } else {
          if      (md.shortageQty === null)  { value = "연결필요"; cls += " cst-neutral-cell"; }
          else if (md.shortageQty > 0)       { value = formatNumber(Math.round(md.shortageQty)); cls += " cst-shortage-cell"; }
          else                               { value = "-"; cls += " cst-neutral-cell"; }
        }
        return `<td class="${cls}${borderCls}">${escapeHtml(value)}</td>`;
      })
    ).join("");

    const rowCls = !item.hasInventory ? "cst-row-nodata" : (item.isShared ? "cst-row-shared" : "cst-row-dedicated");
    return `<tr class="${rowCls}">${leftCells}${metricCells}</tr>`;
  }).join("") : `<tr><td colspan="${cols.length + months.length * CONSTR_METRICS.length}" class="cst-empty">공급 제약 대상이 없습니다</td></tr>`;

  return `<section class="cst-card cst-table-block">
    <div class="cst-sec-title">BOM 전개 공급원인 분석</div>
    <div class="cst-h-scroll">
      <table class="cst-table" style="min-width:${minW}px;">
        <colgroup>${colgroup}</colgroup>
        <thead>
          <tr>${leftHeaders}${monthHead}</tr>
          <tr>${metricHead}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  </section>`;
}

// ── 화면 렌더 ─────────────────────────────────────────────────────────────────
function renderConstraint() {
  const hasData   = state.mappedData.plan_monthly.length > 0;
  const bomStatus = state.bomStatus || BOM_STATUS.IDLE;
  const months    = getRtfMonths();

  const isRunning = bomStatus === BOM_STATUS.RUNNING;
  const btnLabel  = bomStatus === BOM_STATUS.DONE ? "BOM 재전개" : "BOM 전개 실행";
  const btnHtml   = `<button type="button" id="bomExpandBtn" class="cst-bom-btn${isRunning ? " running" : ""}"${isRunning ? " disabled" : ""}>${escapeHtml(btnLabel)}</button>`;
  const warnHtml  = !hasData ? `<span class="cst-toolbar-warn">데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.</span>` : "";

  const headerHtml = `<section class="cst-card cst-top">
    <h2 class="cst-title">공급제한 원인 분석</h2>
    <div class="cst-meta">기준월: ${escapeHtml(months[0])} | 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))}</div>
  </section>`;

  let contentHtml = "";
  if (bomStatus === BOM_STATUS.IDLE) {
    contentHtml = `<div class="cst-guide-box">BOM 전개 전입니다. 기준월과 대상기간을 확인한 뒤 BOM 전개 실행 버튼을 눌러 공급제약 대상을 산출하십시오.</div>`;
  } else if (bomStatus === BOM_STATUS.RUNNING) {
    contentHtml = `<div class="cst-progress-box">
      <div class="cst-spinner"></div>
      <span class="cst-progress-label">${escapeHtml(state.bomProgressStep || "BOM 전개 중")}</span>
    </div>`;
  } else if (bomStatus === BOM_STATUS.FAILED) {
    const reasons = (state.bomResult?.failReasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join("");
    contentHtml = `<div class="cst-fail-box">
      <p>BOM 전개를 완료할 수 없습니다. 필수 데이터 연결 상태를 확인하십시오.</p>
      ${reasons ? `<ul class="cst-fail-list">${reasons}</ul>` : ""}
    </div>`;
  } else if (bomStatus === BOM_STATUS.DONE && state.bomResult) {
    contentHtml = renderConstraintSummaryCard(state.bomResult) + renderConstraintTable(state.bomResult.items);
  }

  return `<div class="cst-screen">
    <div class="cst-toolbar">
      ${btnHtml}
      <button type="button" class="adj-candidate-btn" disabled title="조정입력 연계 기능은 후속 단계에서 구현 예정입니다.">조정안에 담기</button>
      ${warnHtml}
    </div>
    ${headerHtml}
    ${contentHtml}
  </div>`;
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindConstraint() {
  document.querySelector("#bomExpandBtn")?.addEventListener("click", () => {
    if (state.bomStatus === BOM_STATUS.RUNNING) return;
    const myId  = ++_bomAnimId;
    const steps = ["데이터 확인 중","소요량 산출 중","가용수량 비교 중","공용자재 확인 중"];
    let stepIdx = 0;

    state.bomStatus       = BOM_STATUS.RUNNING;
    state.bomProgressStep = "BOM 전개 중";
    render("constraint");

    const advance = () => {
      if (myId !== _bomAnimId) return;
      if (stepIdx < steps.length) {
        state.bomProgressStep = steps[stepIdx++];
        render("constraint");
        setTimeout(advance, 160);
      } else {
        const result          = computeBomExpansion();
        state.bomResult       = result;
        state.bomStatus       = result.status;
        state.bomProgressStep = "";
        render("constraint");
      }
    };
    setTimeout(advance, 100);
  });
}
