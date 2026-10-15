#!/usr/bin/env node
// Started by the Codex SDK in place of `codex`; see src/liaison/codex-guard.ts.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0] && args[0].type;
  if (type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) return;
  return emit.call(process, warning, ...args);
};
const { runGuard } = await import('../src/liaison/codex-guard.ts');
runGuard(process.argv.slice(2), process.env);
