#!/usr/bin/env node
/**
 * WeClaw Agent Relay
 *
 * Captures the daemon's CLI agent invocation to understand the protocol.
 * Logs all input to a file, then forwards messages to our app's HTTP endpoint.
 *
 * Usage: Configure ~/.weclaw/config.json to use this script as the agent command.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(require('os').homedir(), '.weclaw', 'agent-relay.log');
const APP_PORT = 19800; // Our app's message relay port

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

async function main() {
  // Log invocation context
  log('=== Agent Relay Invoked ===');
  log(`PID: ${process.pid}`);
  log(`CWD: ${process.cwd()}`);
  log(`Args: ${JSON.stringify(process.argv.slice(2))}`);
  log(`Env conversation: ${process.env.WECLAW_CONVERSATION || 'not set'}`);
  log(`Env session: ${process.env.WECLAW_SESSION || 'not set'}`);
  log(`Env message: ${process.env.WECLAW_MESSAGE || 'not set'}`);
  log(`All env keys: ${Object.keys(process.env).filter(k => k.startsWith('WECLAW') || k.startsWith('ILINK') || k.startsWith('CLAUDE')).join(', ')}`);

  // Read all stdin (daemon may pass message this way)
  let stdinData = '';
  if (!process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      stdinData = Buffer.concat(chunks).toString('utf-8');
      log(`Stdin length: ${stdinData.length}`);
      log(`Stdin content: ${stdinData.substring(0, 500)}`);
    } catch (err) {
      log(`Stdin error: ${err.message}`);
    }
  } else {
    log('Stdin is a TTY — no piped input');
  }

  // Forward to our app's HTTP endpoint if message available
  const message = process.env.WECLAW_MESSAGE || stdinData.trim();
  if (message) {
    try {
      const result = await postToApp('/wx-relay', {
        from: process.env.WECLAW_CONVERSATION || 'unknown',
        content: message,
        timestamp: Date.now(),
      });
      log(`App response: ${result}`);
      process.stdout.write(result);
    } catch (err) {
      log(`App forward error: ${err.message}`);
      process.stdout.write('处理消息时出错，请稍后重试。');
    }
  } else {
    log('No message found — responding with default');
    process.stdout.write('你好！我是 DevFlow 远程控制助手。');
  }
}

function postToApp(apiPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: '127.0.0.1',
      port: APP_PORT,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve(response));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.stdout.write('内部错误。');
  process.exit(1);
});
