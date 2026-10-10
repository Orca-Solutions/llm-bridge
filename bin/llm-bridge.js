#!/usr/bin/env node
// Entry point. Node 22.18+ runs the TypeScript sources directly (type
// stripping), so there is no build step. node:sqlite still prints an
// ExperimentalWarning; it is filtered here and nowhere else.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0] && args[0].type;
  const name = warning && warning.name;
  if (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') return;
  return emit.call(process, warning, ...args);
};
const { main } = await import('../src/cli/index.ts');
await main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`llm-bridge: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
