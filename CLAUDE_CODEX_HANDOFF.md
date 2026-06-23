# Claude / Codex Handoff

## Goal

Keep RTF development fast and lightweight by editing only the files that are actually loaded by `index.html`.

## Active Runtime Files

- RTF screen logic: `js/screens/rtf.js`
- RTF styling: `css/rtf.css`
- App entry/render wiring: `js/main.js`
- Shared state/constants: `js/core.js`
- Data parsing/mapping: `js/data.js`
- Utility helpers: `js/utils.js`

## Do Not Edit For RTF Work

- `js/fileFallback.js`

This file is not loaded by the current `index.html`. Do not duplicate RTF logic there. If old logic exists there, treat it as legacy/reference only.

## RTF Work Rules

1. Ask the user before development starts when the direction is ambiguous.
2. Offer multiple-choice options and mark the recommended option.
3. Prefer minimal changes in `js/screens/rtf.js` and `css/rtf.css`.
4. Do not create duplicate RTF renderers or fallback copies.
5. Keep default RTF view lightweight:
   - Collapsed: `판매계획`, `RTF`, `Shortage`
   - Expanded: add `매출`, `매출차질예상`, `기말재고`, `재고일수`
6. Keep header/body month columns driven by the same visible month column array.
7. Avoid cell background colors for RTF/Shortage status. Use text color or small outline badges only.
8. Preserve current group behavior:
   - 기본: grouped rows closed/lightweight
   - 확대: item group rows can reveal item detail rows

## Current RTF Sections

- `01. 사업부별`
- `02. 플랜트별`
- `03. 유형별`

## Plant Code Definitions

RTF 화면에서는 계산/RAW 매칭 키는 플랜트 코드를 유지하고, 화면 표시명은 아래 정의를 사용한다.

- `1210` = `향남`
- `1220` = `나보타`
- `1230` = `오송`
- `1240` = `횡성`

새 플랜트 코드가 나오면 임의 명칭을 만들지 말고 사용자에게 정의를 확인한다.

## Git / Versioning

- Remote: `https://github.com/beliefjoo-dot/rtf-dash.git`
- Main branch currently used locally: `master`
- Version commits should include the date, e.g. `2026-06-23 v0.7.x - ...`
- Before committing, verify `git status --short` and avoid committing unrelated/generated changes.

## Verification Checklist

- Run `node --check js/screens/rtf.js`
- Confirm `index.html` still loads `js/screens/rtf.js`
- Open the app with a hard refresh if browser output looks stale
- Check collapsed and expanded RTF table alignment
