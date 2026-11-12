'use strict';
// Local port forward over SSH: 127.0.0.1:<auto port> -> dstHost:dstPort through the server.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * @returns {Promise<{localPort:number, close:()=>void}>}
 */
function openTunnel({ host, port, user, password, keyPath, passphrase, dstHost, dstPort }) {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    let settled = false;
    const fail = (message, cause) => {
      if (settled) return;
      settled = true;
      ssh.end();
      const e = new Error(message + (cause && cause.message ? `: ${cause.message}` : ''));
      e.code = cause && cause.code;
      e.needsPassphrase = !!(cause && /passphrase|encrypted/i.test(cause.message || ''));
      reject(e);
    };

    const config = {
      host, port: Number(port) || 22, username: user || os.userInfo().username,
      readyTimeout: 20000, keepaliveInterval: 15000,
    };
    try {
      if (keyPath) {
        config.privateKey = fs.readFileSync(expandHome(keyPath));
        if (passphrase) config.passphrase = passphrase;
      } else if (password) {
        config.password = password;
        config.tryKeyboard = true;
      } else if (process.env.SSH_AUTH_SOCK) {
        config.agent = process.env.SSH_AUTH_SOCK;
      } else if (process.platform === 'win32') {
        // The OpenSSH agent that ships with Windows listens on this named pipe.
        config.agent = '\\\\.\\pipe\\openssh-ssh-agent';
      }
    } catch (e) {
      return fail('Cannot read the private key', e);
    }

    ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => password || '')));
    ssh.on('error', (e) => fail("Can't connect to the SSH server", e));
    ssh.on('ready', () => {
      const server = net.createServer((socket) => {
        ssh.forwardOut('127.0.0.1', socket.localPort || 0, dstHost, Number(dstPort), (err, stream) => {
          if (err) { socket.destroy(); return; }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      server.on('error', (e) => fail('Creating the tunnel failed', e));
      // Port 0 lets the system pick a free port, so a busy port is never an issue.
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        resolve({
          localPort: server.address().port,
          close: () => { server.close(); ssh.end(); },
        });
      });
    });
    try { ssh.connect(config); } catch (e) { fail("Can't connect to the SSH server", e); }
  });
}

module.exports = { openTunnel, expandHome };
