import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));

function envFileValues(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) {
      values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return values;
}

const fileValues = envFileValues(join(serverDir, '.env'));

function setting(name, fallback) {
  return process.env[name] ?? fileValues[name] ?? fallback;
}

function positiveIntSetting(name, fallback) {
  const value = Number(setting(name, fallback));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const sharedSecret = setting('SHARED_SECRET', '');
if (!sharedSecret) {
  console.error('SHARED_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const host = setting('HOST', '127.0.0.1');
const port = positiveIntSetting('PORT', 8787);
const claudeBin = setting('CLAUDE_BIN', 'claude');
const claudeTimeoutMs = positiveIntSetting('CLAUDE_TIMEOUT_MS', 80000);
const maxConcurrent = positiveIntSetting('MAX_CONCURRENT', 2);

const workDir = join(tmpdir(), 'claude-pebble-proxy');
mkdirSync(workDir, { recursive: true });

const models = [
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
  { id: 'claude-fable-5', display_name: 'Claude Fable 5' }
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
  'Access-Control-Max-Age': '86400'
};

function digest(value) {
  return createHash('sha256').update(value).digest();
}

const secretDigest = digest(sharedSecret);

function presentedSecret(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return req.headers['x-api-key'] || (bearer && bearer[1]) || '';
}

function authorized(req) {
  return timingSafeEqual(digest(presentedSecret(req)), secretDigest);
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function textFrom(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return null;
}

function promptFrom(messages) {
  const turns = [];
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      return null;
    }
    const text = textFrom(message.content);
    if (text === null) {
      return null;
    }
    turns.push({ role: message.role, text });
  }
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return null;
  }
  if (turns.length === 1) {
    return turns[0].text;
  }
  const transcript = turns
    .map((turn) => (turn.role === 'user' ? 'User: ' : 'Assistant: ') + turn.text)
    .join('\n\n');
  return 'Continue this conversation. Write only your next reply, without a role label.\n\n' + transcript;
}

function replyByteLimit(maxTokens) {
  const tokens = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 256;
  return Math.min(tokens * 4, 3500);
}

function truncatedToBytes(text, byteLimit) {
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) {
    return text;
  }
  let sliced = text.slice(0, byteLimit);
  while (Buffer.byteLength(sliced, 'utf8') > byteLimit) {
    sliced = sliced.slice(0, -1);
  }
  return sliced.replace(/[\uD800-\uDBFF]$/, '');
}

function runClaude({ prompt, model, system }, callback) {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--disable-slash-commands'
  ];
  if (model) {
    args.push('--model', model);
  }
  if (system) {
    args.push('--system-prompt', system);
  }
  const child = execFile(
    claudeBin,
    args,
    { cwd: workDir, timeout: claudeTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
    callback
  );
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}

let inFlight = 0;

function handleMessages(res, body) {
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    sendError(res, 400, 'invalid_request_error', 'Body is not valid JSON.');
    return;
  }
  if (!request || !Array.isArray(request.messages)) {
    sendError(res, 400, 'invalid_request_error', 'messages must be an array.');
    return;
  }
  const prompt = promptFrom(request.messages);
  if (prompt === null) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'messages must hold user and assistant text content and end with a user message.'
    );
    return;
  }
  const model = typeof request.model === 'string' ? request.model : '';
  if (model && !/^[A-Za-z0-9._:-]{1,64}$/.test(model)) {
    sendError(res, 400, 'invalid_request_error', 'Unusable model name.');
    return;
  }
  const system = typeof request.system === 'string' ? request.system : '';

  if (inFlight >= maxConcurrent) {
    sendError(res, 429, 'rate_limit_error', 'Too many concurrent requests.');
    return;
  }

  inFlight += 1;
  let clientGone = false;
  const child = runClaude({ prompt, model, system }, (error, stdout, stderr) => {
    inFlight -= 1;
    if (clientGone) {
      return;
    }
    if (error && !stdout) {
      const detail = error.killed ? 'The claude CLI timed out.' : 'The claude CLI failed to run.';
      console.error(detail + ' ' + String(stderr || error.message).slice(0, 500));
      sendError(res, 502, 'api_error', detail);
      return;
    }
    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      console.error('Unexpected CLI output: ' + String(stdout).slice(0, 500));
      sendError(res, 502, 'api_error', 'The claude CLI returned unexpected output.');
      return;
    }
    if (result.is_error || typeof result.result !== 'string') {
      console.error('CLI error result: ' + JSON.stringify(result).slice(0, 500));
      sendError(
        res,
        502,
        'api_error',
        typeof result.result === 'string' ? result.result : 'The claude CLI reported an error.'
      );
      return;
    }
    const text = truncatedToBytes(result.result, replyByteLimit(request.max_tokens));
    const usage = result.usage || {};
    sendJson(res, 200, {
      id: 'msg_proxy_' + randomUUID().replace(/-/g, ''),
      type: 'message',
      role: 'assistant',
      model: model || 'claude',
      content: [{ type: 'text', text }],
      stop_reason: text === result.result ? 'end_turn' : 'max_tokens',
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0
      }
    });
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      child.kill('SIGKILL');
    }
  });
}

const server = createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      new Date().toISOString() +
        ' ' +
        req.method +
        ' ' +
        req.url.split('?')[0] +
        ' ' +
        res.statusCode +
        ' ' +
        (Date.now() - started) +
        'ms'
    );
  });

  const path = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/healthz') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!authorized(req)) {
    sendError(res, 401, 'authentication_error', 'Wrong or missing shared secret.');
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/v1/models') {
    sendJson(res, 200, { data: models });
    return;
  }
  if (req.method !== 'POST' || path !== '/v1/messages') {
    sendError(res, 404, 'not_found_error', 'Not found.');
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) {
      sendError(res, 413, 'invalid_request_error', 'Request body too large.');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!res.writableEnded) {
      handleMessages(res, Buffer.concat(chunks).toString('utf8'));
    }
  });
});

server.listen(port, host, () => {
  console.log('claude-pebble-proxy listening on ' + host + ':' + port);
});
