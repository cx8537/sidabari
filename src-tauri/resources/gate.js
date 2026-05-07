#!/usr/bin/env node
// Sidabari 훅 스크립트 — 양방향 게이트 (PreToolUse 차단 결정용).
// 호출 예: node gate.js PreToolUse
// stdin: Claude Code가 보낸 hook payload JSON
// 동작:
//   1. uuid 생성 → req-<id>.json.tmp 작성 → req-<id>.json으로 rename (atomic).
//   2. resp-<id>.json 폴링 (POLL_MS 간격, TIMEOUT_MS 초과 시 deny).
//   3. 응답 읽고 stdout으로 PreToolUse hookSpecificOutput JSON 출력 + 정리.
//
// CLAUDE.md §1.3:
//   - 응답이 안 오면 deny (보수적). 단, stdin/req 자체가 망가진 경우엔 사용자 작업 흐름 우선해 allow 폴백.
//   - 폴링 도중 reqfile이 사라지면 (사용자가 외부에서 정리 등) deny로 종료.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLL_MS = 100;
const TIMEOUT_MS = 30000;

const eventName = process.argv[2] || 'PreToolUse';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(stdin || '{}');
  } catch (e) {
    emit('allow', `Sidabari gate: stdin 파싱 실패 (${e})`);
    return;
  }

  const id = crypto.randomUUID();
  const baseDir = path.dirname(__dirname);
  const reqPath = path.join(baseDir, `req-${id}.json`);
  const reqTmpPath = reqPath + '.tmp';
  const respPath = path.join(baseDir, `resp-${id}.json`);

  const enriched = {
    request_id: id,
    panel_id: process.env.SIDABARI_PANEL_ID || null,
    hook_event_name_arg: eventName,
    sent_at_ms: Date.now(),
    payload,
  };

  try {
    fs.writeFileSync(reqTmpPath, JSON.stringify(enriched));
    fs.renameSync(reqTmpPath, reqPath);
  } catch (e) {
    emit('allow', `Sidabari gate: req 작성 실패 (${e})`);
    return;
  }

  const startMs = Date.now();

  function poll() {
    let resp = null;
    try {
      const text = fs.readFileSync(respPath, 'utf8');
      resp = JSON.parse(text);
    } catch (e) {
      if (Date.now() - startMs > TIMEOUT_MS) {
        cleanup(reqPath, respPath);
        emit('deny', 'Sidabari gate: 30초 timeout (응답 없음)');
        return;
      }
      setTimeout(poll, POLL_MS);
      return;
    }
    cleanup(reqPath, respPath);
    const decision = resp.permissionDecision || resp.decision || 'allow';
    const reason = resp.permissionDecisionReason || resp.reason || '';
    emit(decision, reason);
  }
  poll();
});

function emit(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: decision,
      permissionDecisionReason: reason || '',
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function cleanup(reqPath, respPath) {
  try { fs.unlinkSync(reqPath); } catch {}
  try { fs.unlinkSync(respPath); } catch {}
}
