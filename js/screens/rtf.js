// ── RTF 계산 ─────────────────────────────────────────────────────────────────
function itemTypeGroup(item) {
  const type = cleanOptional(item.itemType);
  if (type.includes("상품") || String(item.itemCode ?? "").startsWith("7")) return "상품";
  if (type.includes("완제품") || String(item.itemCode ?? "").startsWith("9")) return "완제품";
  return STATUS.UNKNOWN;
}

function higherSeverity(a, b) {
  return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
}

function hasMasterGap(item) {
  if (item.typeGroup === "상품")   return item.businessUnit === NEED_MASTER || item.itemGroup === NEED_MASTER;
  if (item.typeGroup === "완제품") return item.plant === NEED_MASTER || item.itemGroup === NEED_MASTER;
  return true;
}

function computeRtfItems() {
  const planRows      = state.mappedData.plan_monthly;
  const inventoryRows = state.mappedData.inventory_base;
  const masterRows    = state.mappedData.item_master;
  const costMap       = new Map();
  const baseQtyMap    = new Map();
  const inventorySet  = new Set();
  const masterMap     = new Map();
  const planLookup    = new Map();
  const metaMap       = new Map();

  inventoryRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    if (!code) return;
    inventorySet.add(code);
    const cost    = cleanNumber(row.standardCost);
    const baseQty = cleanNumber(row.baseQty);
    if (cost !== null && cost > 0 && !costMap.has(code)) costMap.set(code, cost);
    baseQtyMap.set(code, (baseQtyMap.get(code) ?? 0) + (baseQty ?? 0));
  });
  masterRows.forEach((row) => {
    const code = cleanOptional(row.itemCode);
    if (code && !masterMap.has(code)) masterMap.set(code, row);
  });
  planRows.forEach((row) => {
    const code  = cleanOptional(row.itemCode);
    const month = cleanOptional(row.month);
    if (!code || !month) return;
    planLookup.set(`${code}|${month}`, row);
    if (!metaMap.has(code)) {
      metaMap.set(code, { itemCode: code, itemName: cleanText(row.itemName, code), plant: cleanOptional(row.plant), itemType: cleanOptional(row.itemType) });
    }
  });

  return [...metaMap.values()].map((meta) => {
    const master       = masterMap.get(meta.itemCode);
    const standardCost = costMap.get(meta.itemCode) ?? null;
    const item = {
      ...meta,
      plant:        cleanText(meta.plant, NEED_MASTER),
      businessUnit: cleanText(master?.businessUnit, NEED_MASTER),
      itemGroup:    cleanText(master?.itemGroup, NEED_MASTER),
      standardCost,
      hasCost:      standardCost !== null && standardCost > 0,
      hasInventory: inventorySet.has(meta.itemCode),
      baseQty:      baseQtyMap.get(meta.itemCode) ?? null,
    };
    item.typeGroup = itemTypeGroup(item);
    let runningQty  = item.baseQty;
    const masterGap = hasMasterGap(item);

    item.monthlyStatus = getRtfMonths().map((month) => {
      const plan       = planLookup.get(`${item.itemCode}|${month}`);
      const salesQty   = cleanNumber(plan?.salesQty);
      const supplyQty  = cleanNumber(plan?.supplyQty);
      const noSalesPlan = !plan || salesQty === null || salesQty <= 0;
      const salesAmount = salesQty !== null && salesQty > 0 && item.hasCost ? salesQty * item.standardCost : null;
      let endingQty = null, endingAmount = null;
      let rtfQty = null, rtfAmount = null;
      let shortageQty = null, shortageAmount = null, lostSalesAmount = null;
      let inventoryDays = null;
      let status = STATUS.UNKNOWN;
      let reason = "";

      if (runningQty === null) {
        reason = NEED_DATA;
      } else if (masterGap) {
        reason = NEED_MASTER;
      } else if (noSalesPlan) {
        reason = NO_PLAN;
        if (supplyQty !== null) { runningQty += supplyQty; endingQty = runningQty; }
        rtfQty    = 0;
        rtfAmount = item.hasCost ? 0 : null;
        endingAmount = item.hasCost && endingQty !== null ? Math.max(0, endingQty) * item.standardCost : null;
      } else if (supplyQty === null) {
        reason = NEED_DATA;
      } else {
        runningQty  = runningQty + supplyQty - salesQty;
        endingQty   = runningQty;
        shortageQty = endingQty < 0 ? Math.abs(endingQty) : 0;
        rtfQty      = Math.max(0, salesQty - shortageQty);
        rtfAmount   = item.hasCost ? rtfQty * item.standardCost : null;
        shortageAmount  = shortageQty > 0 && item.hasCost ? shortageQty * item.standardCost : null;
        lostSalesAmount = shortageAmount;
        endingAmount    = item.hasCost ? Math.max(0, endingQty) * item.standardCost : null;
        inventoryDays   = salesQty > 0 && endingQty >= 0 ? (endingQty / salesQty) * 30 : null;
        if (shortageQty > 0)         status = STATUS.SHORTAGE;
        else if (endingQty < salesQty) status = STATUS.WARN;
        else                           status = STATUS.OK;
      }
      return { month, salesQty, supplyQty, rtfQty, rtfAmount, endingQty, endingAmount, shortageQty, shortageAmount, lostSalesAmount, inventoryDays, salesAmount, status, reason, noSalesPlan };
    });
    return item;
  }).filter((item) => item.typeGroup === "상품" || item.typeGroup === "완제품");
}

// ── 집계 ─────────────────────────────────────────────────────────────────────
function sumNullable(values) {
  let total = 0, hasValue = false;
  values.forEach((v) => { if (Number.isFinite(v)) { total += v; hasValue = true; } });
  return hasValue ? total : null;
}

function aggregateMonth(items, monthIndex) {
  const monthRows    = items.map((item) => item.monthlyStatus[monthIndex]);
  const status       = monthRows.reduce((worst, row) => higherSeverity(worst, row.status), STATUS.OK);
  const salesQty     = sumNullable(monthRows.map((r) => r.salesQty));
  const rtfQty       = sumNullable(monthRows.map((r) => r.rtfQty));
  const shortageQty  = sumNullable(monthRows.map((r) => r.shortageQty));
  const salesAmount  = sumNullable(monthRows.map((r) => r.salesAmount));
  const rtfAmount    = sumNullable(monthRows.map((r) => r.rtfAmount));
  const shortageAmount    = sumNullable(monthRows.map((r) => r.shortageAmount));
  const lostSalesAmount   = sumNullable(monthRows.map((r) => r.lostSalesAmount));
  const endingAmount      = sumNullable(monthRows.map((r) => r.endingAmount));
  const endingQty         = sumNullable(monthRows.map((r) => r.endingQty));
  const hasNoPlan         = monthRows.every((r) => r.noSalesPlan);
  return { status: hasNoPlan ? STATUS.UNKNOWN : status, salesQty, rtfQty, shortageQty, salesAmount, rtfAmount, shortageAmount, lostSalesAmount, endingAmount, endingQty, inventoryDays: null, hasNoPlan };
}

// ── 계층 구조 ─────────────────────────────────────────────────────────────────
function makeNode(id, parentId, level, kind, label, items, cols = {}) {
  return { id, parentId, level, kind, label, items, cols };
}

function sortKo(arr) { return [...arr].sort((a, b) => String(a).localeCompare(String(b), "ko-KR")); }
function uniq(items, key) { return sortKo([...new Set(items.map((i) => i[key]))]); }

function buildHierarchy(items, mode) {
  const nodes = [];
  if (mode === "business") {
    uniq(items, "businessUnit").forEach((bu) => {
      const buItems = items.filter((i) => i.businessUnit === bu);
      const buId    = `b|${bu}`;
      nodes.push(makeNode(buId, "", 0, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type:"", group:"", code:"" }));
      uniq(buItems, "typeGroup").forEach((type) => {
        const typeItems = buItems.filter((i) => i.typeGroup === type);
        const typeId    = `${buId}|${type}`;
        nodes.push(makeNode(typeId, buId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu, plant:"", type, group:"", code:"" }));
        uniq(typeItems, "itemGroup").forEach((group) => {
          const groupItems = typeItems.filter((i) => i.itemGroup === group);
          const groupId    = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu, plant:"", type, group, code:"" }));
          groupItems.forEach((item) => {
            nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
              { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode }));
          });
        });
      });
    });
  } else if (mode === "plant") {
    uniq(items, "plant").forEach((plant) => {
      const plantItems = items.filter((i) => i.plant === plant);
      const plantId    = `p|${plant}`;
      nodes.push(makeNode(plantId, "", 0, "group", `${plant} 계`, plantItems, { div:"플랜트", bu:"", plant, type:"", group:"", code:"" }));
      uniq(plantItems, "typeGroup").forEach((type) => {
        const typeItems = plantItems.filter((i) => i.typeGroup === type);
        const typeId    = `${plantId}|${type}`;
        nodes.push(makeNode(typeId, plantId, 1, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant, type, group:"", code:"" }));
        uniq(typeItems, "itemGroup").forEach((group) => {
          const groupItems = typeItems.filter((i) => i.itemGroup === group);
          const groupId    = `${typeId}|${group}`;
          nodes.push(makeNode(groupId, typeId, 2, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu:"", plant, type, group, code:"" }));
          groupItems.forEach((item) => {
            nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 3, "item", item.itemName, [item],
              { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode }));
          });
        });
      });
    });
  } else {
    uniq(items, "typeGroup").forEach((type) => {
      const typeItems = items.filter((i) => i.typeGroup === type);
      const typeId    = `t|${type}`;
      nodes.push(makeNode(typeId, "", 0, "group", `${type} 계`, typeItems, { div:"유형", bu:"", plant:"", type, group:"", code:"" }));
      uniq(typeItems, "businessUnit").forEach((bu) => {
        const buItems = typeItems.filter((i) => i.businessUnit === bu);
        const buId    = `${typeId}|${bu}`;
        nodes.push(makeNode(buId, typeId, 1, "group", `${bu} 계`, buItems, { div:"사업부", bu, plant:"", type, group:"", code:"" }));
        uniq(buItems, "plant").forEach((plant) => {
          const plantItems = buItems.filter((i) => i.plant === plant);
          const plantId    = `${buId}|${plant}`;
          nodes.push(makeNode(plantId, buId, 2, "group", `${plant} 계`, plantItems, { div:"플랜트", bu, plant, type, group:"", code:"" }));
          uniq(plantItems, "itemGroup").forEach((group) => {
            const groupItems = plantItems.filter((i) => i.itemGroup === group);
            const groupId    = `${plantId}|${group}`;
            nodes.push(makeNode(groupId, plantId, 3, "itemGroup", `${group} 계`, groupItems, { div:"품목군", bu, plant, type, group, code:"" }));
            groupItems.forEach((item) => {
              nodes.push(makeNode(`${groupId}|${item.itemCode}`, groupId, 4, "item", item.itemName, [item],
                { div:"자재", bu:item.businessUnit, plant:item.plant, type:item.typeGroup, group:item.itemGroup, code:item.itemCode }));
            });
          });
        });
      });
    });
  }
  return nodes;
}

// ── 상태 표시 ─────────────────────────────────────────────────────────────────
function statusClass(status) {
  return { 대응가능:"ok", 주의:"warn", 공급부족:"shortage", 판단불가:"unknown" }[status] ?? "unknown";
}

function renderStatus(status) {
  return `<span class="rtf-sbadge ${statusClass(status)}">${escapeHtml(status)}</span>`;
}

// ── 포맷 헬퍼 (RTF 전용) ─────────────────────────────────────────────────────
function getVisibleMonthColumns() {
  return state.rtfExpanded ? MONTH_COLUMNS : MONTH_COLUMNS.filter((m) => !EXTRA_COLUMNS.includes(m));
}

function formatDisplayQtyMoney(qtyValue, amountValue, noPlan = false) {
  if (noPlan) return NO_PLAN;
  if (state.rtfDisplayMode === "amount") return Number.isFinite(amountValue) ? formatMoney(amountValue) : NEED_DATA;
  return Number.isFinite(qtyValue) ? formatNumber(qtyValue) : NEED_DATA;
}

function formatEnding(row) {
  if (state.rtfDisplayMode === "amount") return Number.isFinite(row.endingAmount) ? formatMoney(row.endingAmount) : NEED_DATA;
  return Number.isFinite(row.endingQty) ? formatNumber(row.endingQty) : NEED_DATA;
}

function formatBaseForNode(node) {
  const qty = sumNullable(node.items.map((i) => i.baseQty));
  if (state.rtfDisplayMode === "qty") return Number.isFinite(qty) ? formatNumber(qty, 1) : NEED_DATA;
  if (node.items.some((i) => !i.hasCost || !Number.isFinite(i.baseQty))) return NEED_DATA;
  const amount = sumNullable(node.items.map((i) => i.baseQty * i.standardCost));
  return Number.isFinite(amount) ? formatMoney(amount) : NEED_DATA;
}

// ── 셀 렌더 ──────────────────────────────────────────────────────────────────
function renderMetricCell(row, metric, metricIndex, compressed) {
  const mb     = metricIndex === 0 ? " rtf-month-start" : "";
  const noPlan = row.hasNoPlan || row.noSalesPlan;

  if (metric === "판매계획") {
    const raw  = formatDisplayQtyMoney(row.salesQty, row.salesAmount, noPlan);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "RTF") {
    const raw  = formatDisplayQtyMoney(row.rtfQty, row.rtfAmount, noPlan);
    const disp = compressed ? (SHORT_TEXT[raw] || raw) : raw;
    return `<td class="rtf-metric-cell rtf-rtf-cell rtf-status-text ${statusClass(row.status)}${mb}" title="${escapeHtml(raw)}">${escapeHtml(disp)}</td>`;
  }
  if (metric === "Shortage") {
    const isAmt      = state.rtfDisplayMode === "amount";
    const hasShortage = isAmt ? (Number.isFinite(row.shortageAmount) && row.shortageAmount > 0)
                               : (Number.isFinite(row.shortageQty)   && row.shortageQty   > 0);
    const raw = hasShortage ? (isAmt ? formatMoney(row.shortageAmount) : formatNumber(row.shortageQty)) : "-";
    return `<td class="rtf-metric-cell rtf-shortage-cell ${hasShortage ? "rtf-status-text shortage" : "rtf-neutral-text"}${mb}">${escapeHtml(raw)}</td>`;
  }
  if (metric === "매출")
    return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(Number.isFinite(row.salesAmount) ? formatMoney(row.salesAmount) : NEED_DATA)}</td>`;
  if (metric === "매출차질예상") {
    const val = Number.isFinite(row.lostSalesAmount) && row.lostSalesAmount > 0 ? formatMoney(row.lostSalesAmount) : "-";
    return `<td class="rtf-metric-cell ${val !== "-" ? "rtf-status-text shortage" : "rtf-neutral-text"}${mb}">${escapeHtml(val)}</td>`;
  }
  if (metric === "기말재고")
    return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(formatEnding(row))}</td>`;
  if (metric === "재고일수")
    return `<td class="rtf-metric-cell rtf-muted-metric${mb}">${escapeHtml(Number.isFinite(row.inventoryDays) ? `${formatNumber(row.inventoryDays, 1)}일` : "판단불가")}</td>`;
  return `<td class="rtf-metric-cell${mb}">-</td>`;
}

// ── 행 렌더 ──────────────────────────────────────────────────────────────────
function renderHierarchyRow(node) {
  const isItem      = node.kind === "item";
  const isItemGroup = node.kind === "itemGroup";
  const item        = isItem ? node.items[0] : null;
  const { div, bu, plant, type, group, code } = node.cols;
  const baseQty     = formatBaseForNode(node);
  const compressed  = !state.rtfExpanded;
  const isHidden    = compressed ? node.level > 0 : (isItem && !state.expandedItemGroups.has(node.parentId));
  const monthColumns = getVisibleMonthColumns();
  const cells = getRtfMonths().map((_, mIdx) => {
    const monthRow = isItem ? item.monthlyStatus[mIdx] : aggregateMonth(node.items, mIdx);
    return monthColumns.map((metric, colIdx) => renderMetricCell(monthRow, metric, colIdx, compressed)).join("");
  }).join("");
  const toggleBtn = isItemGroup && state.rtfExpanded
    ? `<button type="button" class="rtf-item-toggle" data-node-id="${escapeHtml(node.id)}">${state.expandedItemGroups.has(node.id) ? "-" : "+"}</button>`
    : "";
  return `<tr class="rtf-h-row level-${node.level} ${isItem ? "is-item" : "is-group"}" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId)}"${isHidden ? " hidden" : ""}>
    <td class="rtf-sticky rtf-col-div">${toggleBtn}<span class="rtf-div-label">${escapeHtml(div)}</span></td>
    <td class="rtf-sticky rtf-col-bu">${escapeHtml(bu)}</td>
    <td class="rtf-sticky rtf-col-plant">${escapeHtml(plant)}</td>
    <td class="rtf-sticky rtf-col-type">${escapeHtml(type)}</td>
    <td class="rtf-sticky rtf-col-group">${escapeHtml(group)}</td>
    <td class="rtf-sticky rtf-col-code">${escapeHtml(code)}</td>
    <td class="rtf-sticky rtf-col-name" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</td>
    <td class="rtf-sticky rtf-col-base">${escapeHtml(baseQty)}</td>
    ${cells}
  </tr>`;
}

// ── 섹션 렌더 ────────────────────────────────────────────────────────────────
function renderMatrixSection(title, mode, items, sectionId) {
  const months       = getRtfMonths();
  const nodes        = buildHierarchy(items, mode);
  const monthColumns = getVisibleMonthColumns();
  const COL_W        = { "판매계획":75, "RTF":75, "Shortage":80, "매출":75, "매출차질예상":90, "기말재고":75, "재고일수":75 };
  const metricCols   = months.flatMap(() => monthColumns.map((m) => `<col style="width:${COL_W[m]||75}px;min-width:${COL_W[m]||75}px;">`)).join("");
  const colCount     = 8 + months.length * monthColumns.length;
  const monthHeader  = months.map((month) => `<th class="rtf-month-head" colspan="${monthColumns.length}">${escapeHtml(monthLabel(month))}</th>`).join("");
  const metricHeader = months.map(() =>
    monthColumns.map((m, i) => `<th class="rtf-sub-head${["RTF","Shortage"].includes(m) ? " rtf-key-sub" : ""}${i === 0 ? " rtf-month-start" : ""}">${escapeHtml(m)}</th>`).join("")
  ).join("");
  const body = nodes.length
    ? nodes.map((node) => renderHierarchyRow(node)).join("")
    : `<tr><td colspan="${colCount}" class="rtf-empty">데이터 없음</td></tr>`;
  return `<section id="${escapeHtml(sectionId)}" class="rtf-card rtf-block rtf-matrix-block">
    <div class="rtf-sec-title"><span>${escapeHtml(title)}</span></div>
    <div class="rtf-h-scroll">
      <table class="rtf-h-matrix-table ${state.rtfExpanded ? "is-expanded" : "is-collapsed"}">
        <colgroup>
          <col class="rtf-col-div"><col class="rtf-col-bu"><col class="rtf-col-plant"><col class="rtf-col-type">
          <col class="rtf-col-group"><col class="rtf-col-code"><col class="rtf-col-name"><col class="rtf-col-base">
          ${metricCols}
        </colgroup>
        <thead>
          <tr>
            <th class="rtf-sticky rtf-col-div"   rowspan="2">구분</th>
            <th class="rtf-sticky rtf-col-bu"    rowspan="2">사업부</th>
            <th class="rtf-sticky rtf-col-plant" rowspan="2">플랜트</th>
            <th class="rtf-sticky rtf-col-type"  rowspan="2">유형</th>
            <th class="rtf-sticky rtf-col-group" rowspan="2">품목군</th>
            <th class="rtf-sticky rtf-col-code"  rowspan="2">자재코드</th>
            <th class="rtf-sticky rtf-col-name"  rowspan="2">자재명</th>
            <th class="rtf-sticky rtf-col-base"  rowspan="2">기초재고</th>
            ${monthHeader}
          </tr>
          <tr>${metricHeader}</tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

// ── RTF 화면 ─────────────────────────────────────────────────────────────────
function renderRtf() {
  const items = computeRtfItems();
  if (!state.mappedData.plan_monthly.length) {
    return `<div class="rtf-screen"><section class="rtf-card rtf-top"><h2 class="rtf-title">RTF 월별 대응 현황</h2><div class="rtf-nodata">데이터 연결 필요<br>데이터점검 화면에서 RAW 파일을 선택해 주세요.</div></section></div>`;
  }
  const months = getRtfMonths();
  return `<div class="rtf-screen rtf-excel-layout">
    <section class="rtf-card rtf-top">
      <h2 class="rtf-title">RTF 월별 대응 현황</h2>
      <div class="rtf-meta">기준월: ${escapeHtml(months[0])} | 대상기간: ${escapeHtml(months.map(monthLabel).join(" ~ "))} | 표시: ${state.rtfDisplayMode === "qty" ? "수량" : "금액"}</div>
      <div class="rtf-insight">RTF 컬럼은 판매계획 대비 공급 가능 수량(또는 금액)입니다. Shortage 발생 시 Shortage 컬럼에 붉은색으로 표시됩니다.</div>
    </section>
    <div class="rtf-toolbar">
      <div class="rtf-mode-group" aria-label="표시 단위">
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "qty" ? "active" : ""}" data-rtf-mode="qty">수량</button>
        <button type="button" class="rtf-mode-btn ${state.rtfDisplayMode === "amount" ? "active" : ""}" data-rtf-mode="amount">금액</button>
      </div>
      <button type="button" id="rtfExpandToggle" class="rtf-extra-toggle ${state.rtfExpanded ? "active" : ""}">${state.rtfExpanded ? "축소" : "확대"}</button>
      <span class="rtf-toolbar-hint">${state.rtfExpanded ? "품목군까지 표시 · 품목군 행의 + 버튼으로 자재 상세 확인" : "계 행 + 판매계획/RTF/Shortage 표시"}</span>
    </div>
    ${renderMatrixSection("사업부별", "business", items, "rtfBusinessMatrix")}
    ${renderMatrixSection("플랜트별", "plant",    items, "rtfPlantMatrix")}
    ${renderMatrixSection("유형별",   "type",     items, "rtfTypeMatrix")}
  </div>`;
}

// ── RTF 이벤트 바인딩 ─────────────────────────────────────────────────────────
function bindRtf() {
  document.querySelector("#rtfExpandToggle")?.addEventListener("click", () => {
    state.rtfExpanded = !state.rtfExpanded;
    state.expandedItemGroups.clear();
    render("rtf");
  });
  document.querySelectorAll("[data-rtf-mode]").forEach((btn) => btn.addEventListener("click", () => {
    if (state.rtfDisplayMode === btn.dataset.rtfMode) return;
    state.rtfDisplayMode = btn.dataset.rtfMode;
    render("rtf");
  }));
  document.querySelectorAll(".rtf-item-toggle").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nodeId      = btn.dataset.nodeId;
    const wasExpanded = state.expandedItemGroups.has(nodeId);
    if (wasExpanded) { state.expandedItemGroups.delete(nodeId); btn.textContent = "+"; }
    else             { state.expandedItemGroups.add(nodeId);    btn.textContent = "-"; }
    document.querySelectorAll(`tr[data-parent-id="${CSS.escape(nodeId)}"]`).forEach((row) => { row.hidden = wasExpanded; });
  }));
}
