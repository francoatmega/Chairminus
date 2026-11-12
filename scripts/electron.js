'use strict';
// Starts Electron with the given arguments, on any OS. ELECTRON_RUN_AS_NODE (set by some editors and tools)
// would make Electron behave as plain Node, so it is removed first.
const { spawn } = require('child_process');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
