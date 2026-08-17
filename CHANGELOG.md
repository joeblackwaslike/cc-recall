# Changelog

## [0.4.1](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.4.0...cc-recall-v0.4.1) (2026-08-17)


### Bug Fixes

* **release:** restore biome-compliant formatting in package.json ([#78](https://github.com/joeblackwaslike/cc-recall/issues/78)) ([e25def6](https://github.com/joeblackwaslike/cc-recall/commit/e25def6a8d821475c92e8deedab119f998726e2a))

## [0.4.0](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.3.0...cc-recall-v0.4.0) (2026-08-16)


### Features

* **doctor:** deployment self-verification (4th/5th doctor check + SessionStart hook) ([#77](https://github.com/joeblackwaslike/cc-recall/issues/77)) ([6bd667c](https://github.com/joeblackwaslike/cc-recall/commit/6bd667c24150a1a2ce6a1e3ef6dc2ea9b4d94a24))
* **indexer:** add --setting-sources/--no-session-persistence to runClaudeHeadless ([#75](https://github.com/joeblackwaslike/cc-recall/issues/75)) ([4443715](https://github.com/joeblackwaslike/cc-recall/commit/44437151881bef949fc8f3c0a8f50bf1aa6783e6))

## [0.3.0](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.2.2...cc-recall-v0.3.0) (2026-08-14)


### Features

* **doctor:** detect an uninstalled/not-running cc-recall-watchdog ([#70](https://github.com/joeblackwaslike/cc-recall/issues/70)) ([bcd3a30](https://github.com/joeblackwaslike/cc-recall/commit/bcd3a30af37ff0b5bd3d3279a418239452ef51c3))
* **engine:** dual-signal indexer self-recognition, loud mismatch incident ([#72](https://github.com/joeblackwaslike/cc-recall/issues/72)) ([d7353e4](https://github.com/joeblackwaslike/cc-recall/commit/d7353e42a3e3005fa3064e686c7a6571c1248e10))

## [0.2.2](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.2.1...cc-recall-v0.2.2) (2026-08-14)


### Bug Fixes

* **indexer:** stop indexer's own headless sessions re-entering enrichment ([#68](https://github.com/joeblackwaslike/cc-recall/issues/68)) ([e15f9c4](https://github.com/joeblackwaslike/cc-recall/commit/e15f9c43e1df06333a66c89d8f538b7b67759391))

## [0.2.1](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.2.0...cc-recall-v0.2.1) (2026-08-11)


### Bug Fixes

* **release:** bump plugin.json, sync it via release-please, fix broken publish/docs jobs ([#66](https://github.com/joeblackwaslike/cc-recall/issues/66)) ([cdb12bd](https://github.com/joeblackwaslike/cc-recall/commit/cdb12bd2f5af4eba3cc9b4711631457d5de21f48))

## [0.2.0](https://github.com/joeblackwaslike/cc-recall/compare/cc-recall-v0.1.0...cc-recall-v0.2.0) (2026-08-11)


### Features

* add adoption measurement (Phase 7) ([1b2fcb0](https://github.com/joeblackwaslike/cc-recall/commit/1b2fcb02284cdc072cfcea330027609918d56ee2))
* cc-recall Phase 1 — full implementation ([#14](https://github.com/joeblackwaslike/cc-recall/issues/14)) ([ea00994](https://github.com/joeblackwaslike/cc-recall/commit/ea00994e24227f05536d74795cec24d18b71dcf1))
* **phase3:** enrichment spawn-rate ceiling + independent watchdog ([#61](https://github.com/joeblackwaslike/cc-recall/issues/61)) ([fafa165](https://github.com/joeblackwaslike/cc-recall/commit/fafa165e84a9792d2d22af2ea84e1bc5658212c7))
* **surfaces:** add claude-mem upsert surface (§S3) ([#25](https://github.com/joeblackwaslike/cc-recall/issues/25)) ([d08576e](https://github.com/joeblackwaslike/cc-recall/commit/d08576e5d73a54a7ccbb9a48c7bed2841ea1b2f7))


### Bug Fixes

* add SessionStart hook to build dist/ in plugin cache ([ea9b719](https://github.com/joeblackwaslike/cc-recall/commit/ea9b719b59d4a0006f7f7f4cbc303d3e2b326b13))
* bound LLM spend, surface degradation and build failures, add retention ([#58](https://github.com/joeblackwaslike/cc-recall/issues/58)) ([aca1b34](https://github.com/joeblackwaslike/cc-recall/commit/aca1b3453d74381d572c401f9c27598a6f85b28f))
* **hooks:** rebuild plugin cache on source change (Incident B root cause) ([#57](https://github.com/joeblackwaslike/cc-recall/issues/57)) ([d0c9914](https://github.com/joeblackwaslike/cc-recall/commit/d0c99140c6adb04f3ee8e6d7a01031af694daa12))
* **indexer:** stop enrichment inheriting the interactive model and indexing itself ([#54](https://github.com/joeblackwaslike/cc-recall/issues/54)) ([c0713ca](https://github.com/joeblackwaslike/cc-recall/commit/c0713ca12e37cd53fd50fe542b5f872faa30351f))
* **migrate:** filter rewriteTargets to .jsonl files only ([#24](https://github.com/joeblackwaslike/cc-recall/issues/24)) ([1bc6ec1](https://github.com/joeblackwaslike/cc-recall/commit/1bc6ec1fb99b0b782158ae0c0f89cc998f4bb367))
* **transcript-writer:** skip writes to transcripts that might still be live ([#60](https://github.com/joeblackwaslike/cc-recall/issues/60)) ([7c8c483](https://github.com/joeblackwaslike/cc-recall/commit/7c8c4836e05a8d7cc21a61e2fad15ee9a9fcf253))
* **transcript-writer:** stop two silent data-loss paths; guard the CLI entrypoint ([#55](https://github.com/joeblackwaslike/cc-recall/issues/55)) ([f0190fd](https://github.com/joeblackwaslike/cc-recall/commit/f0190fd40f636557983d6abd5a119f8d083f1999))
