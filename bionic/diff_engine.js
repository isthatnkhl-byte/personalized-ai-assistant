/**
 * Bionic-GPT Interactive Code Diff & In-Place Editing Engine
 * Implements Myers / LCS line-level diffing, unified & side-by-side formatting,
 * workspace file patching with auto-backups, and autonomous self-healing test loops.
 * Based on Cursor / Antigravity diff artifact architecture.
 */

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

class BionicDiffEngine {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.backupDir = options.backupDir || path.join(this.workspaceRoot, '.bionic_backups');
    this.ensureBackupDir();
  }

  ensureBackupDir() {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }
    } catch {}
  }

  /**
   * Fast line-level Longest Common Subsequence (LCS) Diff Algorithm
   * Computes unified lines and side-by-side aligned pairs
   */
  computeDiff(originalText, newText, filePath = 'file') {
    const oldLines = (originalText || '').split(/\r?\n/);
    const newLines = (newText || '').split(/\r?\n/);

    const n = oldLines.length;
    const m = newLines.length;

    // LCS dynamic programming table (optimized for typical code diff sizes)
    // If files are very large (> 4000 lines), use bounded slice
    const maxLines = 4000;
    const a = oldLines.slice(0, maxLines);
    const b = newLines.slice(0, maxLines);

    const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));

    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        if (a[i] === b[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    // Backtrack to build diff ops
    let i = a.length;
    let j = b.length;
    const rawOps = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        rawOps.push({ type: 'eq', text: a[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        rawOps.push({ type: 'add', text: b[j - 1] });
        j--;
      } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
        rawOps.push({ type: 'del', text: a[i - 1] });
        i--;
      }
    }

    rawOps.reverse();

    // Assign line numbers and compute statistics
    let oldNum = 1;
    let newNum = 1;
    let additions = 0;
    let deletions = 0;

    const lines = [];
    const sideBySide = [];

    for (let k = 0; k < rawOps.length; k++) {
      const op = rawOps[k];
      if (op.type === 'eq') {
        lines.push({
          type: 'eq',
          text: op.text,
          oldNum: oldNum++,
          newNum: newNum++
        });
        sideBySide.push({
          left: { num: oldNum - 1, text: op.text, type: 'eq' },
          right: { num: newNum - 1, text: op.text, type: 'eq' }
        });
      } else if (op.type === 'del') {
        deletions++;
        lines.push({
          type: 'del',
          text: op.text,
          oldNum: oldNum++,
          newNum: null
        });
        // Check if next op is add for aligned replacement
        if (k + 1 < rawOps.length && rawOps[k + 1].type === 'add') {
          const nextAdd = rawOps[++k];
          additions++;
          lines.push({
            type: 'add',
            text: nextAdd.text,
            oldNum: null,
            newNum: newNum++
          });
          sideBySide.push({
            left: { num: oldNum - 1, text: op.text, type: 'del' },
            right: { num: newNum - 1, text: nextAdd.text, type: 'add' }
          });
        } else {
          sideBySide.push({
            left: { num: oldNum - 1, text: op.text, type: 'del' },
            right: { num: null, text: '', type: 'empty' }
          });
        }
      } else if (op.type === 'add') {
        additions++;
        lines.push({
          type: 'add',
          text: op.text,
          oldNum: null,
          newNum: newNum++
        });
        sideBySide.push({
          left: { num: null, text: '', type: 'empty' },
          right: { num: newNum - 1, text: op.text, type: 'add' }
        });
      }
    }

    // Generate standard unified diff string
    let unified = `--- a/${filePath}\n+++ b/${filePath}\n`;
    unified += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
    for (const l of lines) {
      if (l.type === 'add') unified += `+${l.text}\n`;
      else if (l.type === 'del') unified += `-${l.text}\n`;
      else unified += ` ${l.text}\n`;
    }

    return {
      filePath,
      additions,
      deletions,
      totalChanges: additions + deletions,
      lines,
      sideBySide,
      unified,
      originalLineCount: oldLines.length,
      newLineCount: newLines.length
    };
  }

  /**
   * Automatically detect and extract code diffs from LLM text responses
   */
  parseDiffFromModelOutput(modelText, defaultFilePath = null, userPrompt = '') {
    if (!modelText || typeof modelText !== 'string') return null;

    // Pattern 1: Explicit file annotation e.g. ```typescript file="src/auth.ts" or // File: src/app.js
    const fileAnnotationRegex = /(?:```([a-zA-Z0-9_-]+)\s+(?:file|path)=["']?([^"'\n\r>]+)["']?|(?:\/\/|#)\s*(?:File|Path):\s*([^\r\n]+)\r?\n```([a-zA-Z0-9_-]+)?)/i;
    const match = modelText.match(fileAnnotationRegex);

    let detectedPath = defaultFilePath;
    let detectedLang = 'text';

    if (match) {
      if (match[2]) {
        detectedPath = match[2].trim();
        detectedLang = match[1] || 'text';
      } else if (match[3]) {
        detectedPath = match[3].trim();
        detectedLang = match[4] || 'text';
      }
    }

    // Pattern 2: Search for code blocks with filename mentioned right above it
    if (!detectedPath) {
      const headerMatch = modelText.match(/(?:###?\s*(?:File|Modify|Update|Patch|Script):\s*`?([^`\r\n]+)`?|([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):\s*)\r?\n```([a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/i);
      if (headerMatch) {
        detectedPath = (headerMatch[1] || headerMatch[2] || '').trim();
        detectedLang = headerMatch[3] || 'text';
      }
    }

    // Extract code block content & language
    const codeBlockMatch = modelText.match(/```([a-zA-Z0-9_-]+)?[^\n]*\r?\n([\s\S]*?)```/);
    if (!codeBlockMatch && !detectedPath) {
      return null;
    }

    const langInCodeBlock = (codeBlockMatch && codeBlockMatch[1]) ? codeBlockMatch[1].toLowerCase() : null;
    const newCode = codeBlockMatch ? codeBlockMatch[2].trim() : modelText.trim();
    if (!newCode || newCode.length < 5) return null;

    // Pattern 3: Fallback inference from user prompt or code block language
    if (!detectedPath) {
      const promptText = userPrompt || '';
      // Check if prompt explicitly mentions a filename (e.g. hello.py, main.js, app.py, index.html)
      const promptFileMatch = promptText.match(/\b([a-zA-Z0-9_-]+\.(py|js|ts|jsx|tsx|html|css|json|cpp|c|rs|go|sh|ps1|md))\b/i);
      if (promptFileMatch) {
        detectedPath = promptFileMatch[1];
        detectedLang = this.inferLanguage(detectedPath);
      } else {
        const lang = (langInCodeBlock || detectedLang || '').toLowerCase();
        if (lang === 'python' || lang === 'py' || /python/i.test(promptText)) {
          detectedPath = /hello/i.test(promptText) ? 'hello.py' : 'main.py';
          detectedLang = 'python';
        } else if (lang === 'javascript' || lang === 'js' || /javascript|node/i.test(promptText)) {
          detectedPath = /hello/i.test(promptText) ? 'hello.js' : 'index.js';
          detectedLang = 'javascript';
        } else if (lang === 'typescript' || lang === 'ts') {
          detectedPath = 'index.ts';
          detectedLang = 'typescript';
        } else if (lang === 'html') {
          detectedPath = 'index.html';
          detectedLang = 'html';
        } else if (lang === 'css') {
          detectedPath = 'style.css';
          detectedLang = 'css';
        } else if (lang === 'rust' || lang === 'rs') {
          detectedPath = 'main.rs';
          detectedLang = 'rust';
        } else if (lang === 'go') {
          detectedPath = 'main.go';
          detectedLang = 'go';
        } else if (lang === 'cpp' || lang === 'c') {
          detectedPath = 'main.cpp';
          detectedLang = 'cpp';
        }
      }
    }

    // Resolve relative path
    let resolvedTarget = null;
    let originalCode = '';

    if (detectedPath) {
      // Clean up quotes or backticks
      detectedPath = detectedPath.replace(/^["'`]|["'`]$/g, '').trim();
      const candidate = path.isAbsolute(detectedPath)
        ? detectedPath
        : path.join(this.workspaceRoot, detectedPath);

      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolvedTarget = candidate;
        try {
          originalCode = fs.readFileSync(candidate, 'utf-8');
        } catch {}
      } else {
        resolvedTarget = candidate;
      }
    }

    // Compute diff
    const diff = this.computeDiff(originalCode, newCode, detectedPath || 'modified_file');

    return {
      hasDiff: true,
      filePath: detectedPath || 'active_workspace_file',
      resolvedPath: resolvedTarget,
      language: detectedLang || this.inferLanguage(detectedPath || ''),
      originalContent: originalCode,
      newContent: newCode,
      diff
    };
  }

  inferLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.json': 'json',
      '.html': 'html',
      '.css': 'css',
      '.rs': 'rust',
      '.py': 'python',
      '.go': 'go',
      '.md': 'markdown',
      '.toml': 'toml',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.sh': 'bash',
      '.ps1': 'powershell'
    };
    return map[ext] || 'text';
  }

  /**
   * Apply code diff directly to workspace disk with auto-backup
   */
  applyDiff(targetPath, newContent, createBackup = true) {
    if (!targetPath || typeof newContent !== 'string') {
      return { success: false, error: 'Target path and new content are required' };
    }

    const resolved = path.isAbsolute(targetPath)
      ? path.normalize(targetPath)
      : path.normalize(path.join(this.workspaceRoot, targetPath));

    // Security check: Must reside within workspace root or user home
    const userHome = process.env.USERPROFILE || 'C:\\Users\\Krishna Maheshwari';
    const normResolved = resolved.toLowerCase();
    const normHome = userHome.toLowerCase();
    const normWs = this.workspaceRoot.toLowerCase();

    if (!normResolved.startsWith(normHome) && !normResolved.startsWith(normWs)) {
      return { success: false, error: 'Filesystem boundary error: cannot write outside workspace or user directory.' };
    }

    let backupPath = null;
    let oldContent = '';

    try {
      // Ensure target directory exists
      const targetDir = path.dirname(resolved);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Create timestamped snapshot backup if existing file
      if (fs.existsSync(resolved)) {
        oldContent = fs.readFileSync(resolved, 'utf-8');
        if (createBackup) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const baseName = path.basename(resolved);
          backupPath = path.join(this.backupDir, `${baseName}.${timestamp}.bak`);
          fs.writeFileSync(backupPath, oldContent, 'utf-8');
        }
      }

      // Write patched content
      fs.writeFileSync(resolved, newContent, 'utf-8');

      // Compute applied diff stats
      const diff = this.computeDiff(oldContent, newContent, path.basename(resolved));

      return {
        success: true,
        filePath: resolved,
        relativePath: path.relative(this.workspaceRoot, resolved),
        backupPath,
        additions: diff.additions,
        deletions: diff.deletions,
        totalLines: diff.newLineCount,
        appliedAt: new Date().toISOString()
      };
    } catch (err) {
      return { success: false, error: err.message, filePath: resolved };
    }
  }

  /**
   * Revert file back to previously saved backup
   */
  revertBackup(targetPath, backupPath) {
    try {
      if (!fs.existsSync(backupPath)) {
        return { success: false, error: 'Backup file not found.' };
      }
      const backupContent = fs.readFileSync(backupPath, 'utf-8');
      fs.writeFileSync(targetPath, backupContent, 'utf-8');
      return { success: true, targetPath, restoredFrom: backupPath, timestamp: new Date().toISOString() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Resolve VS Code executable location across common Windows & system paths
   */
  findVSCodeCommand() {
    const candidateExes = [
      'C:\\Users\\Krishna Maheshwari\\Downloads\\Microsoft VS Code\\Code.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code', 'Code.exe')
    ];

    for (const p of candidateExes) {
      if (fs.existsSync(p)) return p;
    }

    return 'code';
  }

  /**
   * Open file in VS Code directly (with optional line/column jump)
   */
  openInVSCode(targetPath, line = null, column = null) {
    const codeCmd = this.findVSCodeCommand();
    let fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(this.workspaceRoot, targetPath);

    return new Promise((resolve) => {
      const args = [];
      if (line) {
        args.push('-g', `${fullPath}:${line}${column ? ':' + column : ''}`);
      } else {
        args.push(fullPath);
      }

      try {
        if (codeCmd.toLowerCase().endsWith('.exe')) {
          const child = spawn(codeCmd, args, {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
          resolve({ success: true, targetPath: fullPath, exe: codeCmd });
        } else {
          const child = spawn(codeCmd, args, {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore',
            shell: true
          });
          child.unref();
          resolve({ success: true, targetPath: fullPath, exe: codeCmd });
        }
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  /**
   * Open native VS Code side-by-side diff comparing original/backup vs modified file
   */
  openDiffInVSCode(originalPath, modifiedPath) {
    const codeCmd = this.findVSCodeCommand();
    const orig = path.isAbsolute(originalPath) ? originalPath : path.join(this.workspaceRoot, originalPath);
    const mod = path.isAbsolute(modifiedPath) ? modifiedPath : path.join(this.workspaceRoot, modifiedPath);

    return new Promise((resolve) => {
      try {
        const args = ['--diff', orig, mod];
        if (codeCmd.toLowerCase().endsWith('.exe')) {
          const child = spawn(codeCmd, args, {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
          resolve({ success: true, originalPath: orig, modifiedPath: mod });
        } else {
          const child = spawn(codeCmd, args, {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore',
            shell: true
          });
          child.unref();
          resolve({ success: true, originalPath: orig, modifiedPath: mod });
        }
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  /**
   * Open active workspace directory in VS Code
   */
  openWorkspaceInVSCode(folder = null) {
    const codeCmd = this.findVSCodeCommand();
    const target = folder || this.workspaceRoot;

    return new Promise((resolve) => {
      try {
        if (codeCmd.toLowerCase().endsWith('.exe')) {
          const child = spawn(codeCmd, [target], {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
          resolve({ success: true, folder: target });
        } else {
          const child = spawn(codeCmd, [target], {
            cwd: this.workspaceRoot,
            detached: true,
            stdio: 'ignore',
            shell: true
          });
          child.unref();
          resolve({ success: true, folder: target });
        }
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  /**
   * Autonomous Workspace Self-Healing Execution:
   * Discovers test / check commands (npm test, cargo check, pytest) and executes them
   */
  async runWorkspaceVerification(command = null, cwd = null) {
    const targetCwd = cwd || this.workspaceRoot;

    // Auto-detect command if not provided
    let cmd = command;
    if (!cmd) {
      if (fs.existsSync(path.join(targetCwd, 'package.json'))) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(targetCwd, 'package.json'), 'utf-8'));
          if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
            cmd = 'npm test';
          } else if (pkg.scripts && pkg.scripts.typecheck) {
            cmd = 'npm run typecheck';
          } else {
            cmd = 'git status -s';
          }
        } catch {
          cmd = 'git status -s';
        }
      } else if (fs.existsSync(path.join(targetCwd, 'Cargo.toml'))) {
        cmd = 'cargo check';
      } else if (fs.existsSync(path.join(targetCwd, 'pytest.ini')) || fs.existsSync(path.join(targetCwd, 'tests'))) {
        cmd = 'pytest';
      } else {
        cmd = 'git status -s';
      }
    }

    const startTime = Date.now();

    return new Promise((resolve) => {
      exec(cmd, { cwd: targetCwd, timeout: 25000 }, (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const passed = !error || error.code === 0;

        resolve({
          command: cmd,
          cwd: targetCwd,
          passed,
          exitCode: error ? (error.code || 1) : 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
          durationMs,
          timestamp: new Date().toISOString()
        });
      });
    });
  }
}

module.exports = BionicDiffEngine;
