// schedule-runner.js — Scan schedule-*.md files, match cron, build commands
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { shq } = require('./claude-cmd');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Whitelists for schedule frontmatter CLI values. Schedule files are
// markdown in `<project>/.claude/commands/`; anything (including a compromised
// session) with write access to the project can author one, so we validate
// strictly rather than trusting the markdown.
const PERMISSION_MODES = new Set(['plan', 'acceptEdits', 'default', 'bypassPermissions']);
const ALLOWED_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit',
  'BashOutput', 'KillShell', 'SlashCommand',
]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
const BUDGET_RE = /^\d{1,6}(\.\d{1,4})?$/;

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  let currentKey = null;
  const nested = {};

  for (const line of match[1].split('\n')) {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }
  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** Check if a 5-field cron expression matches the current time. */
function cronMatches(cronExpr, now) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  return (
    cronFieldMatches(minute, now.getMinutes()) &&
    cronFieldMatches(hour, now.getHours()) &&
    cronFieldMatches(dom, now.getDate()) &&
    cronFieldMatches(month, now.getMonth() + 1) &&
    cronFieldMatches(dow, now.getDay())
  );
}

/** Scan all projects for schedule-*.md files and return parsed schedule objects. */
function scanSchedules(log) {
  const schedules = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return schedules;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder.name);
      let projectPath = null;
      try {
        const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
        for (const jf of jsonlFiles) {
          const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
          for (const line of head.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(line);
              if (entry.cwd) { projectPath = entry.cwd; break; }
            } catch {}
          }
          if (projectPath) break;
        }
      } catch {}
      if (!projectPath) continue;

      const commandsDir = path.join(projectPath, '.claude', 'commands');
      try {
        if (!fs.existsSync(commandsDir)) continue;
        const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('schedule-') && f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            if (!meta.cron || !body) continue;
            if (meta.enabled === 'false') continue;
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              name: meta.name || file, cron: meta.cron,
              slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
              cli: meta.cli || {}, prompt: body,
            });
          } catch (err) {
            if (log) log.warn(`[schedule] Failed to parse ${file}:`, err.message);
          }
        }
      } catch {}
    }
  } catch (err) {
    if (log) log.error('[schedule] Error scanning schedules:', err);
  }
  return schedules;
}

/** Create a pre-seeded JSONL session file with user message and slug for grouping. */
function createScheduleSession(schedule) {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const msgId = crypto.randomUUID();
  const lines = [
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, timestamp, message: { role: 'user', content: 'Scheduled Task: ' + schedule.prompt } }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  return { sessionId, jsonlPath };
}

/**
 * Build a claude CLI command string for a scheduled task.
 * Every value from the schedule's frontmatter is validated or shell-quoted
 * before hitting the command line. Returns { ok: false, error } if any field
 * fails validation — the caller must not dispatch the run in that case.
 */
function buildScheduleCommand(sessionId, schedule) {
  if (!UUID_RE.test(sessionId || '')) {
    return { ok: false, error: 'invalid sessionId' };
  }
  const cli = schedule.cli || {};

  let cmd = `claude --resume ${shq(sessionId)} -p ${shq('Run the scheduled task')}`;

  const permissionMode = cli['permission-mode'] || 'acceptEdits';
  if (!PERMISSION_MODES.has(permissionMode)) {
    return { ok: false, error: `invalid permission-mode: ${permissionMode}` };
  }
  cmd += ` --permission-mode ${shq(permissionMode)}`;

  if (cli.model) {
    if (!MODEL_RE.test(cli.model)) return { ok: false, error: `invalid model: ${cli.model}` };
    cmd += ` --model ${shq(cli.model)}`;
  }

  if (cli['max-budget-usd']) {
    const b = String(cli['max-budget-usd']);
    if (!BUDGET_RE.test(b)) return { ok: false, error: `invalid max-budget-usd: ${b}` };
    cmd += ` --max-budget-usd ${b}`;
  }

  const rawTools = cli['allowed-tools'] || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch';
  const tools = String(rawTools).split(',').map(t => t.trim()).filter(Boolean);
  for (const t of tools) {
    if (!ALLOWED_TOOL_NAMES.has(t)) return { ok: false, error: `invalid tool: ${t}` };
  }
  cmd += ` --allowedTools ${shq(tools.join(','))}`;

  if (cli['append-system-prompt']) {
    // Full shell-escape of the whole value rather than a quote-only replace.
    cmd += ` --append-system-prompt ${shq(cli['append-system-prompt'])}`;
  }

  if (cli['add-dirs']) {
    for (const dir of String(cli['add-dirs']).split(',').map(d => d.trim()).filter(Boolean)) {
      // Require absolute paths so a schedule can't reach outside its project
      // via a relative traversal.
      if (!path.isAbsolute(dir)) {
        return { ok: false, error: `add-dir must be absolute: ${dir}` };
      }
      cmd += ` --add-dir ${shq(path.resolve(dir))}`;
    }
  }

  return { ok: true, cmd };
}

/**
 * Start the cron loop. Checks every 60 seconds.
 * @param {object} log - Logger
 * @param {function} runCommand - Function to spawn a shell command: runCommand(cmd, cwd, name)
 * @returns {function} stop - Call to stop the scheduler
 */
function startScheduler(log, runCommand) {
  let running = true;
  const runningTasks = new Set();

  function tick() {
    if (!running) return;
    const now = new Date();
    const schedules = scanSchedules(log);

    for (const schedule of schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      const taskKey = `${schedule.folder}:${schedule.slug}`;
      if (runningTasks.has(taskKey)) {
        log.info(`[schedule] Skipping ${schedule.name} — still running from previous trigger`);
        continue;
      }

      log.info(`[schedule] Triggering: ${schedule.name} (${schedule.cron})`);
      try {
        const { sessionId } = createScheduleSession(schedule);
        const built = buildScheduleCommand(sessionId, schedule);
        if (!built.ok) {
          log.error(`[schedule] Refusing to run ${schedule.name}: ${built.error}`);
          continue;
        }

        runningTasks.add(taskKey);
        runCommand(built.cmd, schedule.projectPath, schedule.name, () => {
          runningTasks.delete(taskKey);
        });
      } catch (err) {
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      }
    }
  }

  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, 60 * 1000);
    initialTimer._interval = interval;
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  };
}

module.exports = { parseFrontmatter, cronMatches, scanSchedules, startScheduler, createScheduleSession, buildScheduleCommand };
