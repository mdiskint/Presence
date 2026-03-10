import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const gatePath = path.join(process.cwd(), 'data', 'regression', 'gate.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith('.json') && name !== 'gate.json')
    .map((name) => path.join(dirPath, name));
}

function normalizeTraces(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.traces && Array.isArray(payload.traces)) return payload.traces;
  if (payload?.id && Array.isArray(payload.steps)) return [payload];
  return [];
}

function main() {
  if (!fs.existsSync(gatePath)) {
    console.error(`Missing gate config: ${gatePath}`);
    process.exit(1);
  }

  const gate = readJson(gatePath);
  const traceDir = path.join(process.cwd(), gate.traceDir || 'data/regression');
  const files = collectJsonFiles(traceDir);
  if (files.length === 0) {
    console.error(`No regression traces found in: ${traceDir}`);
    process.exit(1);
  }

  const traces = [];
  for (const file of files) {
    const payload = readJson(file);
    const normalized = normalizeTraces(payload);
    for (const trace of normalized) traces.push({ file, trace });
  }

  const availableIds = new Set(traces.map((t) => t.trace?.id).filter(Boolean));
  const requiredIds = gate.requiredTraceIds || [];
  const missingRequired = requiredIds.filter((id) => !availableIds.has(id));
  if (missingRequired.length > 0) {
    console.error(`Missing required regression traces: ${missingRequired.join(', ')}`);
    process.exit(2);
  }

  const forbidden = new Set(gate.forbiddenFinalReasons || []);
  const forbiddenHits = traces
    .filter(({ trace }) => forbidden.has(trace?.final?.reason))
    .map(({ trace }) => `${trace.id}:${trace.final.reason}`);
  if (forbiddenHits.length > 0) {
    console.error(`Forbidden final reasons detected: ${forbiddenHits.join(', ')}`);
    process.exit(3);
  }

  const run = spawnSync(process.execPath, [path.join('scripts', 'run-regression.js'), traceDir], {
    cwd: process.cwd(),
    stdio: 'inherit'
  });

  process.exit(run.status ?? 1);
}

main();
