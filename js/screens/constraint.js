// ── 전개 상태 상수 ────────────────────────────────────────────────────────────
var BOM_STATUS = { IDLE:"idle", RUNNING:"running", DONE:"done", FAILED:"failed" };
var _bomAnimId = 0;

// ── 컬럼 / 메트릭 정의 ───────────────────────────────────────────────────────
var CONSTR_LEFT_COLS = [
  { key:"plant",        label:"플랜트",       width:60,  align:"center" },
  { key:"parentGroup",  label:"영향 품목군",  width:90,  align:"left"   },
  { key:"itemCategory", label:"제약대상 유형",width:80,  align:"center" },
  { key:"shareType",    label:"공용/전용",    width:60,  align:"center" },
  { key:"code",         label:"자재코드",     width:90,  align:"center" },
  { key:"name",         label:"자재명",       width:160, align:"left",  isName:true },
  { key:"unit",         label:"단위",         width:52,  align:"center" },
  { key:"impactCount",  label:"영향품목수",   width:58,  align:"center" },
  { key:"impactItem",   label:"대표 영향품목",width:130, align:"left"   },
  { key:"note",         label:"확인 필요사항",width:170, align:"left",  isLast:true },
];
var CONSTR_METRIC_W = 72;
var CONSTR_METRICS  = ["필요","가용","부족"];

// ── 제약대상 유형 표시 매핑 ──────────────────────────────────────────────────
var ITEM_CATEGORY_DISPLAY = {
  "L":"자재","N":"자재","D":"자재","R":"원료","U":"반제품","T":"자재",
  "ROH":"원료","HALB":"반제품","FERT":"완제품","HIBE":"자재","VERP":"자재","NLAG":"자재","UNBW":"자재",
  "원료":"원료","자재":"자재","반제품":"반제품","재공품":"재공품","완제품":"완제품",
  "상품":"상품공급","소모품":"자재","포장재":"자재","세미":"반제품",
};
var _DISPLAY_VALID = new Set(["원료","자재","반제품","재공품","상품공급","완제품","기준정보"]);

function displayItemCategory(raw) {
  if (!raw || raw === NEED_MASTER) return "확인필요";
  var t = String(raw).trim();
  if (!t) return "확인필요";
  return ITEM_CATEGORY_DISPLAY[t] || ITEM_CATEGORY_DISPLAY[t.toUpperCase()] || (_DISPLAY_VALID.has(t) ? t : "확인필요");
}

// ── BOM 전개 엔진 ─────────────────────────────────────────────────────────────
function computeBomExpansion() {
  var planRows      = state.mappedData.plan_monthly;
  var inventoryRows = state.mappedData.inventory_base;
  var bomRows       = state.mappedData.bom_components;
  var masterRows    = state.mappedData.item_master;
  var months        = getRtfMonths();
  var result        = { status:BOM_STATUS.FAILED, failReasons:[], completedAt:null, items:[], stats:{} };

  if (!planRows.length)      result.failReasons.push("판매계획 연결 필요");
  if (!bomRows.length)       result.failReasons.push("BOM 연결 필요");
  if (!inventoryRows.length) result.failReasons.push("현재고 연결 필요");
  if (result.failReasons.length) return result;

  // 대체 BOM 존재 여부 추적 (rootCode|plant)
  var rootsWithAltBom = new Set();
  bomRows.forEach(function(r) {
    var alt = cleanOptional(r.alternativeBom);
    if (alt !== "" && alt !== "1") rootsWithAltBom.add(r.rootItemCode + "|" + r.plant);
  });

  // 기본 BOM 필터 (alternativeBom 공란 or "1")
  var baseBomRows = bomRows.filter(function(r) {
    var alt = cleanOptional(r.alternativeBom);
    return alt === "" || alt === "1";
  });
  if (!baseBomRows.length) {
    result.failReasons.push("BOM 연결 필요 (기본 BOM 항목 없음)");
    return result;
  }

  // 완제품 정보 map: rootCode|plant → {code, name}
  var finishedItemMap = new Map();
  baseBomRows.forEach(function(r) {
    var key = r.rootItemCode + "|" + r.plant;
    if (!finishedItemMap.has(key))
      finishedItemMap.set(key, { code:r.rootItemCode, name:cleanText(r.rootItemName, r.rootItemCode) });
  });

  // 완제품 생산계획: code|plant|month → supplyQty (9코드만)
  var prodPlanMap = new Map();
  planRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode);
    if (!code || !code.startsWith("9")) return;
    var key = code + "|" + cleanOptional(row.plant) + "|" + cleanOptional(row.month);
    prodPlanMap.set(key, (prodPlanMap.get(key) || 0) + (cleanNumber(row.supplyQty) || 0));
  });

  // 하위 자재 공급계획: code|plant|month → { qty, unit }
  var compSupplyMap = new Map();
  planRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant), month = cleanOptional(row.month);
    if (!code || !plant || !month) return;
    var key = code + "|" + plant + "|" + month;
    var unit = cleanOptional(row.unit) || "";
    var qty  = cleanNumber(row.supplyQty) || 0;
    var ex   = compSupplyMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else compSupplyMap.set(key, { qty:qty, unit:unit });
  });

  // 기초재고: code|plant → { qty, unit }
  var inventoryMap = new Map();
  inventoryRows.forEach(function(row) {
    var code = cleanOptional(row.itemCode), plant = cleanOptional(row.plant);
    if (!code || !plant) return;
    var key  = code + "|" + plant;
    var unit = cleanOptional(row.unit) || "";
    var qty  = cleanNumber(row.baseQty) || 0;
    var ex   = inventoryMap.get(key);
    if (ex) { ex.qty += qty; if (!ex.unit && unit) ex.unit = unit; }
    else inventoryMap.set(key, { qty:qty, unit:unit });
  });

  // 기준정보 map
  var masterMap = new Map();
  masterRows.forEach(function(r) { if (r.itemCode && !masterMap.has(r.itemCode)) masterMap.set(r.itemCode, r); });

  // 구성품별 소요량 집계: compCode|plant → comp data
  var compReqs = new Map();
  baseBomRows.forEach(function(bom) {
    var rootKey = bom.rootItemCode + "|" + bom.plant;
    var compKey = bom.componentCode + "|" + bom.plant;
    var parent  = finishedItemMap.get(rootKey);
    var rootMaster = masterMap.get(bom.rootItemCode);

    if (!compReqs.has(compKey)) {
      compReqs.set(compKey, {
        componentCode:   bom.componentCode,
        componentName:   bom.componentName,
        plant:           bom.plant,
        itemCategory:    cleanOptional(bom.itemCategory),
        bomUnit:         cleanOptional(bom.componentUnit) || "",
        parentItems:     new Map(),
        requiredByMonth: new Map(),
      });
    }
    var comp = compReqs.get(compKey);
    if (!comp.bomUnit && bom.componentUnit) comp.bomUnit = cleanOptional(bom.componentUnit) || "";

    if (!comp.parentItems.has(rootKey)) {
      comp.parentItems.set(rootKey, {
        code:      bom.rootItemCode,
        name:      parent ? parent.name : bom.rootItemCode,
        plant:     bom.plant,
        itemGroup: cleanText(rootMaster ? rootMaster.itemGroup : null, NEED_MASTER),
        monthly:   new Map(),
      });
    }
    var pi = comp.parentItems.get(rootKey);

    months.forEach(function(month) {
      var prodQty  = prodPlanMap.get(bom.rootItemCode + "|" + bom.plant + "|" + month) || 0;
      var ratio    = bom.baseQty > 0 ? bom.componentQty / bom.baseQty : bom.componentQty;
      var addReq   = prodQty * ratio;
      comp.requiredByMonth.set(month, (comp.requiredByMonth.get(month) || 0) + addReq);
      if (!pi.monthly.has(month)) pi.monthly.set(month, { prodQty:prodQty, reqQty:0 });
      pi.monthly.get(month).reqQty += addReq;
    });
  });

  // 결과 아이템 생성
  var resultItems = [];
  compReqs.forEach(function(comp) {
    var invKey    = comp.componentCode + "|" + comp.plant;
    var invData   = inventoryMap.get(invKey);
    var hasInv    = !!invData;
    var baseQty   = hasInv ? (invData.qty || 0) : null;
    var invUnit   = (invData && invData.unit) ? invData.unit : "";
    var master    = masterMap.get(comp.componentCode);
    var masterUnit = cleanOptional(
      master ? (master.unit || master.unitOfMeasure || master.baseUnit || "") : ""
    ) || "";
    var isShared  = comp.parentItems.size > 1;

    // 단위 결정 (우선순위: BOM > 재고 > 공급계획 > 기준정보)
    var firstSupplyUnit = "";
    months.some(function(m) {
      var sd = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + m);
      if (sd && sd.unit) { firstSupplyUnit = sd.unit; return true; }
      return false;
    });
    var resolvedUnit = comp.bomUnit || invUnit || firstSupplyUnit || masterUnit || "확인필요";

    // 단위 정합성 체크 (BOM 단위 vs 재고/기준정보 단위)
    var compareUnit = invUnit || masterUnit;
    var unitMismatch = !!(
      comp.bomUnit && compareUnit &&
      comp.bomUnit.toLowerCase() !== compareUnit.toLowerCase()
    );
    var unitMissing = resolvedUnit === "확인필요";

    // 대체 BOM 존재 여부
    var parentArr = [];
    comp.parentItems.forEach(function(pi) { parentArr.push(pi); });
    var hasAltBom = parentArr.some(function(p) { return rootsWithAltBom.has(p.code + "|" + comp.plant); });

    // 영향 품목군 (부모 완제품 기준)
    var parentGroups = [];
    var groupSeen = new Set();
    parentArr.forEach(function(p) {
      if (p.itemGroup && p.itemGroup !== NEED_MASTER && !groupSeen.has(p.itemGroup)) {
        groupSeen.add(p.itemGroup); parentGroups.push(p.itemGroup);
      }
    });
    var parentItemGroup;
    if (parentGroups.length === 0)      parentItemGroup = NEED_MASTER;
    else if (parentGroups.length === 1) parentItemGroup = parentGroups[0];
    else                                parentItemGroup = parentGroups[0] + " 외 " + (parentGroups.length - 1) + "개";

    // 월별 순차 계산
    var monthlyData = [];
    var hasAnyShortage = false;
    var totalShortage  = 0;

    if (unitMismatch) {
      // 단위 불일치: 필요수량은 표시, 가용/부족은 판단불가
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:null, shortageQty:null, unitMismatch:true });
      });
    } else {
      var openingQty = baseQty;
      months.forEach(function(month) {
        var requiredQty = comp.requiredByMonth.get(month) || 0;
        var sd          = compSupplyMap.get(comp.componentCode + "|" + comp.plant + "|" + month);
        var supplyQty   = sd ? sd.qty : 0;
        var availableQty = null, shortageQty = null;
        if (openingQty !== null) {
          availableQty = openingQty + supplyQty;
          shortageQty  = Math.max(requiredQty - availableQty, 0);
          var endingQty = Math.max(availableQty - requiredQty, 0);
          if (shortageQty > 0) { hasAnyShortage = true; totalShortage += shortageQty; }
          openingQty = endingQty;
        }
        monthlyData.push({ month:month, requiredQty:requiredQty, availableQty:availableQty, shortageQty:shortageQty, unitMismatch:false });
      });
    }

    var hasReq = monthlyData.some(function(md) { return md.requiredQty > 0; });
    if (!hasReq) return;

    // 확인 필요사항 구성
    var notes = [];
    if (!hasInv)                          notes.push("현재고 데이터 연결 필요");
    if (isShared && hasAnyShortage)       notes.push("공통자재 부족 발생. 완제품별 배분기준 확인 필요");
    if (hasAltBom)                        notes.push("대체 BOM 존재. 적용 기준 확인 필요");
    if (unitMismatch)                     notes.push("단위 정합 확인 필요");
    else if (unitMissing && !unitMismatch) notes.push("단위 기준정보 확인 필요");

    var needsMaster = !comp.itemCategory || comp.itemCategory === NEED_MASTER || displayItemCategory(comp.itemCategory) === "확인필요";
    var parentArrForResult = parentArr.map(function(p) {
      return {
        code:      p.code,
        name:      p.name,
        plant:     p.plant,
        itemGroup: p.itemGroup,
        monthly:   months.map(function(m) { return Object.assign({ month:m }, p.monthly.get(m) || { prodQty:0, reqQty:0 }); }),
      };
    });

    resultItems.push({
      plant:           comp.plant,
      componentCode:   comp.componentCode,
      componentName:   cleanText(comp.componentName, comp.componentCode),
      itemCategory:    comp.itemCategory,
      displayCategory: displayItemCategory(comp.itemCategory),
      parentItemGroup: parentItemGroup,
      unit:            resolvedUnit,
      unitMismatch:    unitMismatch,
      unitMissing:     unitMissing,
      isShared:        isShared,
      parentItems:     parentArrForResult,
      hasInventory:    hasInv,
      monthlyData:     monthlyData,
      hasAnyShortage:  hasAnyShortage,
      totalShortage:   totalShortage,
      hasAltBom:       hasAltBom,
      needsMaster:     needsMaster,
      notes:           notes,
      note:            notes.join(" | "),
    });
  });

  // 제약 대상만 (부족 발생 or 현재고 없음 or 단위불일치)
  var constraintItems = resultItems.filter(function(i) {
    return i.hasAnyShortage || !i.hasInventory || i.unitMismatch;
  });
  var sorted = sortConstraintItems(constraintItems);

  result.status      = BOM_STATUS.DONE;
  result.completedAt = new Date();
  result.items       = sorted;
  result.stats = {
    totalConstraints:  sorted.filter(function(i) { return i.hasAnyShortage; }).length,
    sharedConstraints: sorted.filter(function(i) { return i.isShared && i.hasAnyShortage; }).length,
    dedicatedShortage: sorted.filter(function(i) { return !i.isShared && i.hasAnyShortage; }).length,
    needMaster:        sorted.filter(function(i) { return i.needsMaster; }).length,
    needData:          sorted.filter(function(i) { return !i.hasInventory; }).length,
  };
  return result;
}

// ── 정렬 ─────────────────────────────────────────────────────────────────────
function sortConstraintItems(items) {
  function priority(item) {
    if (item.hasAnyShortage && item.isShared)  return 0;
    if (item.hasAnyShortage && !item.isShared) return 1;
    if (item.needsMaster)                      return 2;
    if (!item.hasInventory)                    return 3;
    return 4;
  }
  return items.slice().sort(function(a, b) {
    var pd = priority(a) - priority(b);
    if (pd !== 0) return pd;
    if (a.hasAnyShortage && b.hasAnyShortage) return b.totalShortage - a.totalShortage;
    return 0;
  });
}

// ── 필터 ─────────────────────────────────────────────────────────────────────
function filterConstraintItems(items) {
  var filter = state.constraintFilter || "all";
  var search = ((state.constraintSearch || "")).toLowerCase().trim();
  var filtered = items;
  if      (filter === "shortage")     filtered = items.filter(function(i) { return i.hasAnyShortage; });
  else if (filter === "shared")       filtered = items.filter(function(i) { return i.isShared && i.hasAnyShortage; });
  else if (filter === "dedicated")    filtered = items.filter(function(i) { return !i.isShared && i.hasAnyShortage; });
  else if (filter === "need-master")  filtered = items.filter(function(i) { return i.needsMaster; });
  else if (filter === "need-data")    filtered = items.filter(function(i) { return !i.hasInventory; });
  if (search) {
    filtered = filtered.filter(function(i) {
      return i.componentCode.toLowerCase().includes(search) ||
             i.componentName.toLowerCase().includes(search) ||
             i.parentItems.some(function(p) {
               return p.code.toLowerCase().includes(search) || p.name.toLowerCase().includes(search);
             });
    });
  }
  return filtered;
}

// ── 요약 카드 ─────────────────────────────────────────────────────────────────
function renderConstraintSummaryCard(result) {
  var s = result.stats;
  var fmtTime = result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : "-";
  var items = [
    { label:"전개상태",          value:"완료",                                                                           cls:"ok"       },
    { label:"전개완료시각",      value:fmtTime,                                                                         cls:""         },
    { label:"확정부족 제약대상", value:s.totalConstraints  > 0 ? String(s.totalConstraints)  : "-",  cls:s.totalConstraints  > 0 ? "shortage":""  },
    { label:"공용자재 제약",     value:s.sharedConstraints > 0 ? String(s.sharedConstraints) : "-",  cls:s.sharedConstraints > 0 ? "warn"    :""  },
    { label:"전용자재 부족",     value:s.dedicatedShortage > 0 ? String(s.dedicatedShortage) : "-",  cls:s.dedicatedShortage > 0 ? "shortage":""  },
    { label:"기준정보 확인 필요",value:s.needMaster        > 0 ? String(s.needMaster)        : "-",  cls:s.needMaster        > 0 ? "warn"    :""  },
    { label:"데이터 연결 필요",  value:s.needData          > 0 ? String(s.needData)          : "-",  cls:s.needData          > 0 ? "warn"    :""  },
  ];
  return "<section class=\"cst-card cst-summary-card\"><div class=\"cst-summary-grid\">" +
    items.map(function(i) {
      return "<div class=\"cst-sum-item\"><div class=\"cst-sum-label\">" + escapeHtml(i.label) +
             "</div><div class=\"cst-sum-value" + (i.cls ? " " + i.cls : "") + "\">" + escapeHtml(i.value) + "</div></div>";
    }).join("") + "</div></section>";
}

// ── 필터 바 ──────────────────────────────────────────────────────────────────
function renderConstraintFilterBar(allItems) {
  var f = state.constraintFilter || "all";
  var filters = [
    { key:"all",         label:"전체",         count:allItems.length },
    { key:"shortage",    label:"부족만",        count:allItems.filter(function(i){return i.hasAnyShortage;}).length },
    { key:"shared",      label:"공용자재",      count:allItems.filter(function(i){return i.isShared&&i.hasAnyShortage;}).length },
    { key:"dedicated",   label:"전용자재",      count:allItems.filter(function(i){return !i.isShared&&i.hasAnyShortage;}).length },
    { key:"need-master", label:"기준정보 확인", count:allItems.filter(function(i){return i.needsMaster;}).length },
    { key:"need-data",   label:"데이터 연결",   count:allItems.filter(function(i){return !i.hasInventory;}).length },
  ];
  var btns = filters.map(function(ft) {
    return "<button type=\"button\" class=\"cst-filter-btn" + (f === ft.key ? " active" : "") +
           "\" data-cst-filter=\"" + escapeHtml(ft.key) + "\">" + escapeHtml(ft.label) +
           "<span class=\"cst-filter-count\">" + ft.count + "</span></button>";
  }).join("");
  return "<div class=\"cst-filter-bar\"><div class=\"cst-filter-btns\">" + btns +
         "</div><input type=\"search\" class=\"cst-search\" id=\"cstSearch\" placeholder=\"자재코드·자재명·영향품목 검색\" value=\"" +
         escapeHtml(state.constraintSearch || "") + "\"></div>";
}

// ── 결과 표 섹션 ─────────────────────────────────────────────────────────────
function renderConstraintTableSection(result, bomStatus, months) {
  var isRunning = bomStatus === BOM_STATUS.RUNNING;
  var isDone    = bomStatus === BOM_STATUS.DONE;
  var lastTime  = isDone && result && result.completedAt
    ? result.completedAt.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : null;
  var statusLabels = { idle:"미실행", running:"진행중", done:"완료", failed:"실패" };
  var statusLabel  = statusLabels[bomStatus] || "-";
  var statusCls    = isDone ? " cst-status-done" : bomStatus === BOM_STATUS.FAILED ? " cst-status-fail" : "";

  var headerRight = "<div class=\"cst-sec-actions\">" +
    "<span class=\"cst-status-badge" + statusCls + "\">전개상태: " + escapeHtml(statusLabel) + "</span>" +
    (lastTime ? "<span class=\"cst-status-time\">마지막 전개: " + escapeHtml(lastTime) + "</span>" : "") +
    "<button type=\"button\" id=\"bomExpandBtn\" class=\"cst-bom-btn" + (isRunning ? " running" : "") + "\"" +
    (isRunning ? " disabled" : "") + ">BOM 전개</button></div>";

  var tableContent = "";
  if (bomStatus === BOM_STATUS.IDLE) {
    tableContent = "<div class=\"cst-guide-box\">BOM 전개 전입니다. 기준월과 대상기간을 확인한 뒤 BOM 전개 버튼을 눌러 공급제약 대상을 산출하십시오.</div>";
  } else if (bomStatus === BOM_STATUS.RUNNING) {
    tableContent = "<div class=\"cst-progress-box\"><div class=\"cst-spinner\"></div>" +
                   "<span class=\"cst-progress-label\">" + escapeHtml(state.bomProgressStep || "BOM 전개 중") + "</span></div>";
  } else if (bomStatus === BOM_STATUS.FAILED) {
    var reasons = ((result && result.failReasons) || []).map(function(r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("");
    tableContent = "<div class=\"cst-fail-box\"><p>BOM 전개를 완료할 수 없습니다. 필수 데이터 연결 상태를 확인하십시오.</p>" +
                   (reasons ? "<ul class=\"cst-fail-list\">" + reasons + "</ul>" : "") + "</div>";
  } else if (isDone && result) {
    var filtered = filterConstraintItems(result.items);
    tableContent = renderConstraintFilterBar(result.items) + renderConstraintTableBody(filtered, months, result.items.length);
  }

  return "<section class=\"cst-card cst-table-block\">" +
         "<div class=\"cst-sec-title\">BOM 전개 공급원인 분석" + headerRight + "</div>" +
         tableContent + "</section>";
}

// ── 결과 표 본문 ─────────────────────────────────────────────────────────────
function renderConstraintTableBody(items, months) {
  var leftPos = 0;
  var cols = CONSTR_LEFT_COLS.map(function(c) { var r = Object.assign({}, c, { left:leftPos }); leftPos += c.width; return r; });
  var totalLeftW  = leftPos;
  var totalCols   = cols.length + months.length * CONSTR_METRICS.length;
  var minW        = totalLeftW + months.length * CONSTR_METRICS.length * CONSTR_METRIC_W;

  var colgroup = cols.map(function(c) { return "<col style=\"width:" + c.width + "px;\">"; }).join("") +
    months.reduce(function(acc) {
      return acc + CONSTR_METRICS.map(function() { return "<col style=\"width:" + CONSTR_METRIC_W + "px;\">"; }).join("");
    }, "");

  var leftHeaders = cols.map(function(col) {
    var aCls = col.align === "left" ? " cst-cell-left" : "";
    var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
    return "<th class=\"cst-sticky" + aCls + xCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\" rowspan=\"2\">" +
           escapeHtml(col.label) + "</th>";
  }).join("");

  var monthHead = months.map(function(m, mi) {
    return "<th class=\"cst-month-head" + (mi > 0 ? " cst-month-start" : "") + "\" colspan=\"" + CONSTR_METRICS.length + "\">" +
           escapeHtml(monthLabel(m)) + "</th>";
  }).join("");

  var metricHead = months.map(function(_, mi) {
    return CONSTR_METRICS.map(function(metric, ci) {
      return "<th class=\"cst-sub-head" + (metric === "부족" ? " cst-key-sub" : "") +
             (ci === 0 && mi > 0 ? " cst-month-start" : "") + "\">" + escapeHtml(metric) + "</th>";
    }).join("");
  }).join("");

  var bodyRows;
  if (!items.length) {
    bodyRows = "<tr><td colspan=\"" + totalCols + "\" class=\"cst-empty\">공급 제약 대상이 없습니다</td></tr>";
  } else {
    bodyRows = items.map(function(item) {
      var compKey    = item.componentCode + "|" + item.plant;
      var isExpanded = state.expandedConstraintRows && state.expandedConstraintRows.has(compKey);
      var unitTitle  = item.unitMismatch
        ? "BOM 단위와 현재고/공급계획 단위가 일치하지 않아 부족수량 계산이 불가능합니다."
        : item.unitMissing
          ? "단위 기준정보가 없어 단위 정합성을 확인할 수 없습니다."
          : "";

      var leftCells = cols.map(function(col) {
        var aCls = col.align === "left" ? " cst-cell-left" : "";
        var xCls = col.isName ? " cst-col-name" : col.isLast ? " cst-col-last-sticky" : "";
        var value = "", extra = "", titleAttr = "";
        if      (col.key === "plant")        value = displayPlantName(item.plant);
        else if (col.key === "parentGroup")  value = item.parentItemGroup === NEED_MASTER ? "확인필요" : item.parentItemGroup;
        else if (col.key === "itemCategory") value = item.displayCategory;
        else if (col.key === "shareType")    value = item.isShared ? "공용" : "전용";
        else if (col.key === "code")         value = item.componentCode;
        else if (col.key === "name")         value = item.componentName;
        else if (col.key === "unit") {
          value = item.unit;
          if (unitTitle) titleAttr = " title=\"" + escapeHtml(unitTitle) + "\"";
        }
        else if (col.key === "impactCount") {
          var icon = isExpanded ? "▲" : "▼";
          extra = "<button type=\"button\" class=\"cst-expand-btn\" data-comp-key=\"" + escapeHtml(compKey) + "\" title=\"영향 완제품 목록 " + (isExpanded ? "접기" : "펼치기") + "\">" + icon + "</button>";
          value = String(item.parentItems.length);
        }
        else if (col.key === "impactItem") {
          value = item.parentItems.length > 0 ? item.parentItems[0].name : "-";
          titleAttr = " title=\"" + escapeHtml(value) + "\"";
        }
        else if (col.key === "note") {
          value = item.note || "-";
          titleAttr = " title=\"" + escapeHtml(value) + "\"";
        }
        if ((col.isName) && !titleAttr) titleAttr = " title=\"" + escapeHtml(value) + "\"";
        var unitWarnCls = (col.key === "unit" && (item.unitMismatch || item.unitMissing)) ? " cst-unit-warn" : "";
        return "<td class=\"cst-sticky cst-td" + aCls + xCls + unitWarnCls + "\" style=\"left:" + col.left + "px;width:" + col.width + "px;\"" + titleAttr + ">" + extra + escapeHtml(value) + "</td>";
      }).join("");

      var metricCells = item.monthlyData.map(function(md, mi) {
        return CONSTR_METRICS.map(function(metric, ci) {
          var borderCls = ci === 0 && mi > 0 ? " cst-month-start" : "";
          var value = "-", cls = "cst-metric-cell";
          if (metric === "필요") {
            value = md.requiredQty > 0 ? formatNumber(Math.round(md.requiredQty)) : "-";
          } else if (metric === "가용") {
            if (item.unitMismatch)         { value = "판단불가"; cls += " cst-neutral-cell"; }
            else if (md.availableQty===null){ value = "연결필요"; cls += " cst-neutral-cell"; }
            else                            { value = formatNumber(Math.round(md.availableQty)); }
          } else {
            if (item.unitMismatch || md.shortageQty===null) { value = "판단불가"; cls += " cst-neutral-cell"; }
            else if (md.shortageQty > 0) { value = formatNumber(Math.round(md.shortageQty)); cls += " cst-shortage-cell"; }
            else                         { value = "-"; cls += " cst-neutral-cell"; }
          }
          return "<td class=\"" + cls + borderCls + "\">" + escapeHtml(value) + "</td>";
        }).join("");
      }).join("");

      var rowCls = !item.hasInventory ? "cst-row-nodata" : item.isShared ? "cst-row-shared" : "cst-row-dedicated";
      var mainRow = "<tr class=\"" + rowCls + "\" data-comp-key=\"" + escapeHtml(compKey) + "\">" + leftCells + metricCells + "</tr>";

      var detailRow = "";
      if (isExpanded && item.parentItems.length > 0) {
        var detailMonthHeads = months.map(function(m) { return "<th colspan=\"2\">" + escapeHtml(monthLabel(m)) + "</th>"; }).join("");
        var detailSubHeads   = months.map(function() { return "<th>생산계획</th><th>필요수량</th>"; }).join("");
        var detailBodyRows   = item.parentItems.map(function(p) {
          var monthlyCells = p.monthly.map(function(md) {
            return "<td>" + (md.prodQty > 0 ? formatNumber(Math.round(md.prodQty)) : "-") + "</td>" +
                   "<td>" + (md.reqQty  > 0 ? formatNumber(Math.round(md.reqQty))  : "-") + "</td>";
          }).join("");
          return "<tr class=\"cst-detail-data-row\">" +
                 "<td title=\"" + escapeHtml(p.code) + "\">" + escapeHtml(p.code) + "</td>" +
                 "<td title=\"" + escapeHtml(p.name) + "\">" + escapeHtml(p.name) + "</td>" +
                 "<td>" + escapeHtml(p.itemGroup === NEED_MASTER ? "확인필요" : p.itemGroup) + "</td>" +
                 "<td>" + escapeHtml(item.unit) + "</td>" +
                 monthlyCells + "</tr>";
        }).join("");
        detailRow = "<tr class=\"cst-detail-row\"><td colspan=\"" + totalCols + "\" class=\"cst-detail-cell\">" +
                    "<div class=\"cst-detail-inner\">" +
                    "<table class=\"cst-detail-table\"><thead>" +
                    "<tr class=\"cst-detail-head\"><th>완제품 코드</th><th>완제품명</th><th>품목군</th><th>단위</th>" + detailMonthHeads + "</tr>" +
                    "<tr class=\"cst-detail-head\"><th></th><th></th><th></th><th></th>" + detailSubHeads + "</tr>" +
                    "</thead><tbody>" + detailBodyRows + "</tbody></table>" +
                    "</div></td></tr>";
      }

      return mainRow + detailRow;
    }).join("");
  }

  return "<div class=\"cst-h-scroll\"><table class=\"cst-table\" style=\"min-width:" + minW + "px;\">" +
         "<colgroup>" + colgroup + "</colgroup>" +
         "<thead><tr>" + leftHeaders + monthHead + "</tr><tr>" + metricHead + "</tr></thead>" +
         "<tbody>" + bodyRows + "</tbody></table></div>";
}

// ── 화면 렌더 ─────────────────────────────────────────────────────────────────
function renderConstraint() {
  var hasData   = state.mappedData.plan_monthly.length > 0;
  var bomStatus = state.bomStatus || BOM_STATUS.IDLE;
  var months    = getRtfMonths();

  return "<div class=\"cst-screen\">" +
    "<div class=\"cst-toolbar\">" +
    "<button type=\"button\" class=\"adj-candidate-btn\" disabled title=\"조정입력 연계 기능은 후속 단계에서 구현 예정입니다.\">조정안에 담기</button>" +
    (!hasData ? "<span class=\"cst-toolbar-warn\">데이터 연결 필요 — 데이터점검 화면에서 RAW 파일을 먼저 선택하십시오.</span>" : "") +
    "</div>" +
    "<section class=\"cst-card cst-top\">" +
    "<h2 class=\"cst-title\">공급제한 원인 분석</h2>" +
    "<div class=\"cst-meta\">기준월: " + escapeHtml(months[0]) + " | 대상기간: " + escapeHtml(months.map(monthLabel).join(" ~ ")) + "</div>" +
    "<div class=\"cst-notice\">현재 계획 기준 BOM 전개 결과입니다. 공급계획 조정 및 조정 후 영향은 조정입력/조정영향 화면에서 검토합니다.</div>" +
    "</section>" +
    (bomStatus === BOM_STATUS.DONE && state.bomResult ? renderConstraintSummaryCard(state.bomResult) : "") +
    renderConstraintTableSection(state.bomResult, bomStatus, months) +
    "</div>";
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindConstraint() {
  // BOM 전개 버튼
  var bomBtn = document.querySelector("#bomExpandBtn");
  if (bomBtn) bomBtn.addEventListener("click", function() {
    if (state.bomStatus === BOM_STATUS.RUNNING) return;
    var myId  = ++_bomAnimId;
    var steps = ["데이터 확인 중","소요량 산출 중","가용수량 비교 중","공용자재 확인 중"];
    var stepIdx = 0;
    state.bomStatus       = BOM_STATUS.RUNNING;
    state.bomProgressStep = "BOM 전개 중";
    state.expandedConstraintRows = new Set();
    render("constraint");

    var advance = function() {
      if (myId !== _bomAnimId) return;
      if (stepIdx < steps.length) {
        state.bomProgressStep = steps[stepIdx++];
        render("constraint");
        setTimeout(advance, 160);
      } else {
        var res = computeBomExpansion();
        state.bomResult       = res;
        state.bomStatus       = res.status;
        state.bomProgressStep = "";
        state.constraintFilter = "all";
        state.constraintSearch = "";
        render("constraint");
      }
    };
    setTimeout(advance, 100);
  });

  // 필터 버튼
  document.querySelectorAll("[data-cst-filter]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      state.constraintFilter = btn.dataset.cstFilter;
      render("constraint");
    });
  });

  // 검색
  var searchInput = document.querySelector("#cstSearch");
  if (searchInput) {
    searchInput.addEventListener("input", function(e) {
      state.constraintSearch = e.target.value;
      render("constraint");
    });
  }

  // 영향품목 펼침
  document.querySelectorAll(".cst-expand-btn").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var key = btn.dataset.compKey;
      if (!state.expandedConstraintRows) state.expandedConstraintRows = new Set();
      if (state.expandedConstraintRows.has(key)) state.expandedConstraintRows.delete(key);
      else state.expandedConstraintRows.add(key);
      render("constraint");
    });
  });
}
