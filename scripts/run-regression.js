import fs from 'fs';
import path from 'path';

const defaultDir = path.join(process.cwd(), 'data', 'regression');
const inputPath = process.argv[2] || defaultDir;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectTraceFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  const files = [];
  for (const entry of fs.readdirSync(targetPath)) {
    const full = path.join(targetPath, entry);
    if (fs.statSync(full).isFile() && full.endsWith('.json') && entry !== 'gate.json') files.push(full);
  }
  return files.sort();
}

function normalizeTraces(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.traces && Array.isArray(payload.traces)) return payload.traces;
  if (payload?.id && Array.isArray(payload.steps)) return [payload];
  return [];
}

function modelActionSignature(step) {
  if (!Array.isArray(step?.actions)) return '[]';
  return JSON.stringify(step.actions.map((a) => ({
    type: a.type,
    selector: a.selector || '',
    tabUrl: a.tabUrl || '',
    url: a.url || ''
  })));
}

function evaluateTrace(trace) {
  const findings = [];
  const finalReason = trace?.final?.reason || 'unknown';
  const mission = String(trace?.mission || '');
  const isPlaybackMission = /(play|start|listen)/i.test(mission) && /(song|track|music|album|artist)/i.test(mission);

  if (finalReason === 'repeat_loop_breaker') {
    findings.push('repeat_loop_breaker triggered');
  }

  let lastSig = '';
  let repeatCount = 0;
  let playbackVerified = false;
  let highRetryFailures = 0;

  for (const step of trace?.steps || []) {
    if (step?.type === 'model') {
      const sig = modelActionSignature(step);
      if (sig !== '[]' && sig === lastSig) repeatCount += 1;
      else repeatCount = 0;
      lastSig = sig;
      if (repeatCount >= 2) findings.push('repeated identical model action signatures');
    }

    if (step?.type === 'verify' && step?.check?.startsWith('playback') && step?.passed === true) {
      playbackVerified = true;
    }

    if (step?.type === 'actions') {
      for (const r of step.results || []) {
        if (r?.success === false && (r?.attempts || 0) >= 3) highRetryFailures += 1;
      }
    }
  }

  if (highRetryFailures >= 3) findings.push(`multiple high-retry failures (${highRetryFailures})`);

  if (isPlaybackMission) {
    const completed = finalReason === 'model_complete' || finalReason === 'playback_verified';
    if (completed && !playbackVerified && finalReason !== 'playback_verified') {
      findings.push('playback mission completed without playback verification');
    }
  }

  return {
    id: trace?.id || 'unknown',
    mission,
    finalReason,
    findings
  };
}

function main() {
  const files = collectTraceFiles(inputPath);
  if (files.length === 0) {
    console.error(`No regression JSON files found at: ${inputPath}`);
    process.exit(1);
  }

  const reports = [];
  for (const file of files) {
    const payload = readJson(file);
    const traces = normalizeTraces(payload);
    if (traces.length === 0) {
      reports.push({ file, id: 'n/a', mission: '', finalReason: 'invalid', findings: ['no traces found in file'] });
      continue;
    }
    for (const trace of traces) {
      reports.push({ file, ...evaluateTrace(trace) });
    }
  }

  let failing = 0;
  for (const r of reports) {
    const status = r.findings.length ? 'FAIL' : 'PASS';
    if (status === 'FAIL') failing += 1;
    console.log(`[${status}] ${path.basename(r.file)} | ${r.id} | ${r.finalReason} | ${r.mission}`);
    for (const finding of r.findings) {
      console.log(`  - ${finding}`);
    }
  }

  console.log(`\nEvaluated ${reports.length} trace(s). Failures: ${failing}`);
  process.exit(failing > 0 ? 2 : 0);
}

main();
