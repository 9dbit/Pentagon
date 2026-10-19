# Pentagon report UI | visual QA and release checkpoint

**Branch:** feature/pentagon-defence-rank-report-ui-20261019  
**Base:** migration/railway-independence  
**Status:** Draft, UI-only review. No production deployment, database change, API migration, provider-node work, or DNS change.

## What changed

**Google Rank**
- Replaced the dense 7-column table and nested merged cells with an editorial report organized by keyword, project, and tracked domain.
- Added real-data summary counts (tracked groups/domains, ranked domains, recorded flagged results), keyword/domain search and flagged-only filter.
- Maintained scan, edit, delete, new keyword and navigation handlers; editing now uses a compact inline form, not a table row.
- Rank/page values are visibly identified as saved snapshots, not live Google results.

**Defence Center**
- Reduced nested borders, filled cards, and shaded keyword headings. Section hierarchy is: summary, findings, keyword investigations, trusted vs. unfamiliar results.
- Collapsed the long keyword form behind a disclosure control by default and kept scan notifications visible outside that disclosure.
- Kept trusted-domain moves, entity/backlink classifications, per-node rank evidence and domain intel/report actions.
- Standardized all actions, including delete and investigation, to pill-shaped controls, with a single orange primary action.
- Fixed two visually confirmed CSS collisions: the dashboard's "NORMAL" label replacing "Trusted domains", and a flex-column mobile basis creating a 370px blank area.
- Reset scroll on navigation so the fixed mobile header doesn't cover the destination page title.

## QA performed

QA ran on the actual built Vite React UI on the authorized Windows QA PC. All API requests were intercepted by Chrome using **synthetic .example test records**; this is not live API or database validation.

| Viewport | Google Rank | Defence Center | Horizontal overflow | Header/action overlap |
| --- | --- | --- | --- | --- |
| Desktop 1440 x 900 | PASS | PASS | 0 | 0 |
| Tablet 768 x 1024 | PASS | PASS | 0 | 0 |
| iPhone-like 390 x 844 | PASS | PASS | 0 | 0 |
| Compact 320 x 740 | PASS | PASS | 0 | 0 |

Additional browser interactions checked keyword filtering, flagged-only toggle, the add form, inline edit and cancel, Defence Center navigation, collapsed/expanded form, pill button radius, and isolated per-node table scroll. The browser reported no runtime errors or external API requests.

- Local structural report contract tests: **19 PASS**.
- Vite compiled successfully: **1,974 modules** transformed, with build artifacts emitted.
- Existing repository package-lock metadata lacks optional platform artifacts required by npm ci; for isolated local QA only, a no-save/no-lock npm install was used. This did not change the repository lockfile. A separate GitHub Actions build check was also created; do not interpret queued CI as a passing result.

## Screenshots

| Page | Desktop | Mobile 390px | Small mobile 320px |
| --- | --- | --- | --- |
| Google Rank | [Desktop](ui-review-20261019/google-rank-desktop.png) | [Mobile](ui-review-20261019/google-rank-phone390.png) | [320px](ui-review-20261019/google-rank-phone320.png) |
| Defence Center | [Desktop](ui-review-20261019/defence-center-desktop.png) | [Mobile](ui-review-20261019/defence-center-phone390.png) | [320px](ui-review-20261019/defence-center-phone320.png) |

**Reviewer next step:** accept/edit the report layout, then request a separate authenticated staging UAT against actual application data before considering production. The existing marketing PR #27 and migration PR #26 are unrelated and remain unchanged.
