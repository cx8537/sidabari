#!/usr/bin/env node
// Sidabari 훅 스크립트 — 일방향 이벤트 append.
// 호출 예: node append-event.js Stop
// stdin: Claude Code가 보낸 hook payload JSON
// 동작: <baseDir>/events.jsonl 에 한 줄 append, exit 0 (어떤 경우에도 Claude 흐름 차단 X).
//
// CLAUDE.md §1.3 — 자동 차단 X. 이 스크립트는 신호만 흘리고 항상 0으로 종료한다.
// __dirname = scripts/, 부모가 sidabari-hooks/ 베이스.

const fs = require('fs');
const path = require('path');

const eventName = process.argv[2] || 'unknown';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(stdin || '{}');
    if (typeof payload !== 'object' || payload === null) {
      payload = { _wrapped: payload };
    }
  } catch (e) {
    payload = { _parse_error: String(e), _raw: stdin.slice(0, 1024) };
  }
  payload._sidabari = {
    hook_event_name_arg: eventName,
    panel_id: process.env.SIDABARI_PANEL_ID || null,
    received_at_ms: Date.now(),
  };
  const baseDir = path.dirname(__dirname);
  const eventsPath = path.join(baseDir, 'events.jsonl');
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(payload) + '\n');
  } catch (e) {
    process.stderr.write(`[sidabari-hook] append 실패: ${e}\n`);
  }
  process.exit(0);
});
