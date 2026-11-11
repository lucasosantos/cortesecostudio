// Inicia o Electron sem ELECTRON_RUN_AS_NODE (definida por alguns terminais, como o do VS Code).
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
