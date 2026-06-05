#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { exec } = require("child_process");

const PORT = process.argv[2] && !isNaN(process.argv[2]) ? parseInt(process.argv[2]) : 3939;
const claudeDir = path.join(os.homedir(), ".claude");
const exportDir = path.join(process.cwd(), "exported-sessions");

// --- Session Discovery ---

function findAllSessions() {
  const sessions = [];
  const projectsDir = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsDir)) return sessions;

  for (const project of fs.readdirSync(projectsDir)) {
    const projPath = path.join(projectsDir, project);
    if (!fs.statSync(projPath).isDirectory()) continue;

    for (const file of fs.readdirSync(projPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(projPath, file);
      if (!fs.statSync(filePath).isFile()) continue;
      const stat = fs.statSync(filePath);
      sessions.push({
        id: file.replace(".jsonl", ""),
        path: filePath,
        modified: stat.mtime,
        project,
      });
    }

    const sessionsDir = path.join(projPath, "sessions");
    if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
      for (const sid of fs.readdirSync(sessionsDir)) {
        const transcript = path.join(sessionsDir, sid, "transcript.jsonl");
        if (fs.existsSync(transcript)) {
          const stat = fs.statSync(transcript);
          sessions.push({ id: sid, path: transcript, modified: stat.mtime, project });
        }
      }
    }
  }

  const seen = new Set();
  const unique = [];
  for (const s of sessions) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      unique.push(s);
    }
  }
  return unique.sort((a, b) => b.modified - a.modified);
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") return block;
      if (block.type === "text" && block.text) return block.text;
    }
  }
  return "";
}

function parseSession(sessionPath) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const messages = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryType = entry.type;
    const msg = entry.message;

    if (entryType === "user" && msg) {
      const content = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
      if (content) messages.push({ role: "user", content });
    } else if (entryType === "assistant" && msg) {
      const contentArr = msg.content;
      if (!Array.isArray(contentArr)) continue;

      // Extract thinking blocks
      for (const block of contentArr) {
        if (block.type === "thinking" && block.thinking) {
          messages.push({ role: "thinking", content: block.thinking });
        }
      }

      // Extract text + tool_use blocks as the response
      const responseParts = [];
      for (const block of contentArr) {
        if (block.type === "text" && block.text) {
          responseParts.push(block.text);
        } else if (block.type === "tool_use") {
          const input = JSON.stringify(block.input, null, 2);
          const trimmed = input.length > 800 ? input.slice(0, 800) + "\n..." : input;
          responseParts.push("```tool: " + block.name + "\n" + trimmed + "\n```");
        } else if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text || "").join("\n")
                : "";
          if (text) {
            const trimmed = text.length > 500 ? text.slice(0, 500) + "..." : text;
            responseParts.push("[Tool result]: " + trimmed);
          }
        }
      }
      if (responseParts.length) {
        messages.push({ role: "assistant", content: responseParts.join("\n\n") });
      }
    }
  }

  return messages;
}

function extractTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block.type === "text" && block.text) parts.push(block.text);
    }
    return parts.join("\n\n");
  }
  return "";
}

function getSessionName(messages, id) {
  for (const msg of messages.slice(0, 3)) {
    if (msg.role === "user" && msg.content) {
      const clean = msg.content
        .replace(/[<>:"/\\|?*\n\r\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)
        .trim();
      if (clean) return clean;
    }
  }
  return id.slice(0, 8);
}

// --- Build/Cache Sessions ---

function buildSessionIndex() {
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const sessions = findAllSessions();
  const index = [];

  for (const s of sessions) {
    const cachedPath = path.join(exportDir, `${s.id}.json`);
    let needsParse = true;

    if (fs.existsSync(cachedPath)) {
      const cachedStat = fs.statSync(cachedPath);
      if (cachedStat.mtime >= s.modified) {
        needsParse = false;
      }
    }

    let messages;
    if (needsParse) {
      messages = parseSession(s.path);
      fs.writeFileSync(cachedPath, JSON.stringify(messages, null, 2), "utf-8");
    } else {
      messages = JSON.parse(fs.readFileSync(cachedPath, "utf-8"));
    }

    const name = getSessionName(messages, s.id);
    index.push({
      id: s.id,
      name,
      modified: s.modified.toISOString(),
      project: s.project,
      messageCount: messages.length,
    });
  }

  fs.writeFileSync(path.join(exportDir, "sessions.json"), JSON.stringify(index, null, 2), "utf-8");
  return index;
}

// --- Client JS (separate to avoid template literal escaping issues) ---

const CLIENT_JS = [
  'var sessions = [];',
  'var currentId = null;',
  '',
  'async function init() {',
  '  var res = await fetch("/api/sessions");',
  '  sessions = await res.json();',
  '  renderList(sessions);',
  '  document.getElementById("count").textContent = sessions.length + " sessions";',
  '}',
  '',
  'function renderList(list) {',
  '  var el = document.getElementById("list");',
  '  el.innerHTML = list.map(function(s) {',
  '    var date = new Date(s.modified).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });',
  '    var snippetHtml = s.snippets && s.snippets.length',
  '      ? \'<div class="snippet">[\'+ s.snippets[0].role + \'] \' + escHtml(s.snippets[0].snippet) + \'</div>\'',
  '      : \'\';',
  '    return \'<div class="session-item\' + (s.id === currentId ? \' active\' : \'\') + \'" data-id="\' + s.id + \'">\' +',
  '      \'<div class="name">\' + escHtml(s.name) + \'</div>\' +',
  '      snippetHtml +',
  '      \'<div class="meta">\' + date + \' &middot; \' + s.messageCount + \' msgs &middot; \' + s.project + \'</div>\' +',
  '    \'</div>\';',
  '  }).join("");',
  '  el.querySelectorAll(".session-item").forEach(function(item) {',
  '    item.addEventListener("click", function() { loadSession(item.dataset.id); });',
  '  });',
  '}',
  '',
  'async function loadSession(id) {',
  '  currentId = id;',
  '  var res = await fetch("/api/session/" + id);',
  '  var messages = await res.json();',
  '  var session = sessions.find(function(s) { return s.id === id; });',
  '  document.getElementById("empty").style.display = "none";',
  '  document.getElementById("header").style.display = "";',
  '  document.getElementById("messages").style.display = "";',
  '  document.getElementById("title").textContent = session.name;',
  '  document.getElementById("info").textContent = new Date(session.modified).toLocaleString() + " | " + session.project + " | " + messages.length + " messages";',
  '  var el = document.getElementById("messages");',
  '  el.innerHTML = messages.map(function(m) {',
  '    return \'<div class="message \' + m.role + \'">\' +',
  '      \'<div class="role">\' + m.role + \'</div>\' +',
  '      \'<div class="body">\' + renderBody(m.content) + \'</div>\' +',
  '    \'</div>\';',
  '  }).join("");',
  '  el.scrollTop = 0;',
  '  document.querySelectorAll(".session-item").forEach(function(i) {',
  '    i.classList.toggle("active", i.dataset.id === id);',
  '  });',
  '}',
  '',
  'var searchTimeout = null;',
  'document.getElementById("search").addEventListener("input", function(e) {',
  '  var term = e.target.value.trim();',
  '  if (searchTimeout) clearTimeout(searchTimeout);',
  '  if (!term) {',
  '    renderList(sessions);',
  '    document.getElementById("count").textContent = sessions.length + " sessions";',
  '    return;',
  '  }',
  '  var nameMatches = sessions.filter(function(s) {',
  '    return s.name.toLowerCase().indexOf(term.toLowerCase()) !== -1 || s.project.toLowerCase().indexOf(term.toLowerCase()) !== -1;',
  '  });',
  '  renderList(nameMatches);',
  '  document.getElementById("count").textContent = "Searching content...";',
  '  searchTimeout = setTimeout(async function() {',
  '    var res = await fetch("/api/search?q=" + encodeURIComponent(term));',
  '    var results = await res.json();',
  '    renderList(results);',
  '    document.getElementById("count").textContent = results.length + " of " + sessions.length + " sessions (content search)";',
  '  }, 300);',
  '});',
  '',
  'function escHtml(s) {',
  '  if (!s) return "";',
  '  return s.replace(/&/g,"\\x26amp;").replace(/</g,"\\x26lt;").replace(/>/g,"\\x26gt;");',
  '}',
  '',
  'function renderBody(text) {',
  '  if (!text) return "";',
  '  var BT = String.fromCharCode(96);',
  '  var fence = BT + BT + BT;',
  '  var parts = [];',
  '  var remaining = text;',
  '  while (true) {',
  '    var start = remaining.indexOf(fence);',
  '    if (start === -1) { parts.push({type:"text", val: remaining}); break; }',
  '    if (start > 0) parts.push({type:"text", val: remaining.slice(0, start)});',
  '    remaining = remaining.slice(start + 3);',
  '    var end = remaining.indexOf(fence);',
  '    if (end === -1) { parts.push({type:"text", val: fence + remaining}); break; }',
  '    var block = remaining.slice(0, end);',
  '    remaining = remaining.slice(end + 3);',
  '    var nlIdx = block.indexOf("\\n");',
  '    var lang = nlIdx > -1 ? block.slice(0, nlIdx).trim() : "";',
  '    var code = nlIdx > -1 ? block.slice(nlIdx + 1) : block;',
  '    parts.push({type:"code", lang: lang || "text", val: code});',
  '  }',
  '  return parts.map(function(p) {',
  '    if (p.type === "code") {',
  '      return \'<div class="code-block"><span class="lang-label">\' + escHtml(p.lang) + \'</span>\' + highlightCode(p.val, p.lang) + \'</div>\';',
  '    }',
  '    var escaped = escHtml(p.val);',
  '    var inlineRe = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");',
  '    return escaped.replace(inlineRe, \'<span class="inline-code">$1</span>\');',
  '  }).join("");',
  '}',
  '',
  'function highlightCode(code, lang) {',
  '  var escaped = escHtml(code);',
  '  if (lang === "json" || lang === "jsonc") return highlightJson(escaped);',
  '  if (["js","javascript","ts","typescript","csharp","cs"].indexOf(lang) !== -1) return highlightJs(escaped);',
  '  if (["bash","sh","shell","powershell","ps1","cmd","tool"].indexOf(lang) !== -1) return highlightBash(escaped);',
  '  return highlightGeneric(escaped);',
  '}',
  '',
  'function highlightJson(code) {',
  '  return code',
  '    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)\\s*:/g, \'<span class="syn-key">$1</span>:\')',
  '    .replace(/:\\s*(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, \': <span class="syn-str">$1</span>\')',
  '    .replace(/:\\s*(-?\\d+\\.?\\d*)/g, \': <span class="syn-num">$1</span>\')',
  '    .replace(/:\\s*(true|false)/g, \': <span class="syn-bool">$1</span>\')',
  '    .replace(/:\\s*(null)/g, \': <span class="syn-null">$1</span>\')',
  '    .replace(/([{}\\[\\]])/g, \'<span class="syn-punct">$1</span>\');',
  '}',
  '',
  'function highlightJs(code) {',
  '  return code',
  '    .replace(/(\\/\\/.*)/gm, \'<span class="syn-comment">$1</span>\')',
  '    .replace(/\\b(const|let|var|function|return|if|else|for|while|class|new|this|import|export|from|async|await|typeof|instanceof|throw|try|catch|switch|case|break|default|yield|of|in|using|namespace|public|private|protected|static|void|int|string|bool|float|double|override|virtual|abstract)\\b/g, \'<span class="syn-kw">$1</span>\')',
  '    .replace(/\\b(true|false|null|undefined|NaN|Infinity)\\b/g, \'<span class="syn-bool">$1</span>\')',
  '    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, \'<span class="syn-str">$1</span>\')',
  '    .replace(/\\b(\\d+\\.?\\d*)\\b/g, \'<span class="syn-num">$1</span>\')',
  '    .replace(/\\b([A-Z]\\w+)\\b/g, \'<span class="syn-type">$1</span>\')',
  '    .replace(/(\\w+)\\s*\\(/g, \'<span class="syn-fn">$1</span>(\');',
  '}',
  '',
  'function highlightBash(code) {',
  '  return code',
  '    .replace(/(#.*)/gm, \'<span class="syn-comment">$1</span>\')',
  '    .replace(/\\b(if|then|else|fi|for|do|done|while|case|esac|function|return|exit|echo|export|source|cd|ls|rm|cp|mv|mkdir|git|node|npm|npx)\\b/g, \'<span class="syn-kw">$1</span>\')',
  '    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, \'<span class="syn-str">$1</span>\')',
  '    .replace(/(\\$\\w+|\\$\\{[^}]+\\})/g, \'<span class="syn-param">$1</span>\');',
  '}',
  '',
  'function highlightGeneric(code) {',
  '  return code',
  '    .replace(/(\\/\\/.*|#.*)/gm, \'<span class="syn-comment">$1</span>\')',
  '    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, \'<span class="syn-str">$1</span>\')',
  '    .replace(/\\b(\\d+\\.?\\d*)\\b/g, \'<span class="syn-num">$1</span>\')',
  '    .replace(/\\b(true|false|null|none|nil)\\b/gi, \'<span class="syn-bool">$1</span>\');',
  '}',
  '',
  'init();',
].join("\n");

// --- HTML ---

const HTML_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace; background: #0d1117; color: #c9d1d9; display: flex; height: 100vh; overflow: hidden; font-size: 13px; }

.sidebar { width: 340px; min-width: 340px; background: #161b22; border-right: 1px solid #30363d; display: flex; flex-direction: column; }
.sidebar-header { padding: 16px; border-bottom: 1px solid #30363d; }
.sidebar-header h1 { font-size: 13px; color: #58a6ff; margin-bottom: 10px; }
.search-box { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 12px; font-family: inherit; outline: none; }
.search-box:focus { border-color: #58a6ff; }
.session-list { flex: 1; overflow-y: auto; padding: 8px; }
.session-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; border: 1px solid transparent; }
.session-item:hover { background: #1c2128; border-color: #30363d; }
.session-item.active { background: #1c2128; border-color: #58a6ff; }
.session-item .name { font-size: 12px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-item .snippet { font-size: 11px; color: #a5d6ff; margin-top: 4px; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-item .meta { font-size: 11px; color: #7d8590; margin-top: 3px; }
.session-count { padding: 8px 16px; font-size: 11px; color: #7d8590; border-bottom: 1px solid #30363d; }

.content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.content-header { padding: 16px 24px; border-bottom: 1px solid #30363d; background: #161b22; }
.content-header h2 { font-size: 13px; color: #e6edf3; }
.content-header .info { font-size: 11px; color: #7d8590; margin-top: 4px; }
.messages { flex: 1; overflow-y: auto; padding: 24px; }
.message { margin-bottom: 24px; padding: 16px; border-radius: 8px; }
.message.user { background: #1c2128; border-left: 3px solid #58a6ff; }
.message.assistant { background: #161b22; border-left: 3px solid #3fb950; }
.message .role { font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
.message.user .role { color: #58a6ff; }
.message.assistant .role { color: #3fb950; }
.message.thinking { background: #13161b; border-left: 3px solid #30363d; opacity: 0.5; }
.message.thinking .role { color: #484f58; }
.message.thinking .body { font-size: 12px; color: #7d8590; }
.message .body { font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; }

.code-block { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; margin: 8px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.code-block .lang-label { font-size: 10px; color: #7d8590; text-transform: uppercase; margin-bottom: 6px; display: block; }
.inline-code { background: #0d1117; padding: 2px 6px; border-radius: 3px; font-size: 12px; border: 1px solid #30363d; }

.syn-key { color: #ff7b72; }
.syn-str { color: #a5d6ff; }
.syn-num { color: #79c0ff; }
.syn-bool { color: #ff7b72; }
.syn-null { color: #ff7b72; }
.syn-punct { color: #7d8590; }
.syn-kw { color: #ff7b72; }
.syn-fn { color: #d2a8ff; }
.syn-comment { color: #7d8590; font-style: italic; }
.syn-type { color: #79c0ff; }
.syn-param { color: #ffa657; }

.empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: #7d8590; font-size: 13px; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #484f58; }
`;

const HTML_BODY = `
<div class="sidebar">
  <div class="sidebar-header">
    <h1>Claude Code Sessions</h1>
    <input class="search-box" type="text" placeholder="Search sessions and content..." id="search">
  </div>
  <div class="session-count" id="count"></div>
  <div class="session-list" id="list"></div>
</div>
<div class="content">
  <div class="empty-state" id="empty">Select a session to view</div>
  <div class="content-header" id="header" style="display:none">
    <h2 id="title"></h2>
    <div class="info" id="info"></div>
  </div>
  <div class="messages" id="messages" style="display:none"></div>
</div>
`;

function buildHTML() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Claude Code Sessions</title><style>' + HTML_CSS + '</style></head><body>' + HTML_BODY + '<script>' + CLIENT_JS + '</script></body></html>';
}

// --- HTTP Server ---

function startServer(index) {
  const html = buildHTML();

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    if (req.url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(index));
      return;
    }

    if (req.url.startsWith("/api/search?q=")) {
      const query = decodeURIComponent(req.url.replace("/api/search?q=", "")).toLowerCase();
      const results = [];

      for (const s of index) {
        const filePath = path.join(exportDir, `${s.id}.json`);
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, "utf-8");
        if (!raw.toLowerCase().includes(query)) continue;

        const messages = JSON.parse(raw);
        const snippets = [];
        for (const msg of messages) {
          if (snippets.length >= 3) break;
          if (!msg.content.toLowerCase().includes(query)) continue;
          const idx = msg.content.toLowerCase().indexOf(query);
          const start = Math.max(0, idx - 50);
          const end = Math.min(msg.content.length, idx + query.length + 50);
          let snippet = msg.content.slice(start, end).replace(/\n/g, " ").replace(/\s+/g, " ");
          if (start > 0) snippet = "..." + snippet;
          if (end < msg.content.length) snippet = snippet + "...";
          snippets.push({ role: msg.role, snippet });
        }
        results.push({ ...s, snippets });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
      return;
    }

    if (req.url.startsWith("/api/session/")) {
      const id = req.url.replace("/api/session/", "");
      const filePath = path.join(exportDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(fs.readFileSync(filePath, "utf-8"));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Claude Code Session Browser`);
    console.log(`  ${index.length} sessions indexed`);
    console.log(`\n  Running at: ${url}`);
    console.log(`  Press Ctrl+C to stop\n`);

    const cmd = process.platform === "win32" ? `start ${url}`
      : process.platform === "darwin" ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd);
  });
}

// --- Main ---

console.log("Scanning sessions...");
const index = buildSessionIndex();
console.log(`Found ${index.length} sessions. Starting server...`);
startServer(index);
