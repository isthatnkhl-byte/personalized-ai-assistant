const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { createBionicRuntime } = require('./bionic');

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  try {
    fs.appendFileSync(path.join(__dirname, 'fatal_error.log'), `[${new Date().toISOString()}] Uncaught: ${err.stack || err}\n`);
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  try {
    fs.appendFileSync(path.join(__dirname, 'fatal_error.log'), `[${new Date().toISOString()}] Rejection: ${reason.stack || reason}\n`);
  } catch {}
});

// Hardware acceleration flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let mainWindow = null;
let llamaProcess = null;

// Initialize Bionic Sovereign Agent Runtime
const bionic = createBionicRuntime({
  storageRoot: path.join(__dirname, 'bionic_data'),
  builtinSkillsDir: path.join(__dirname, 'bionic', 'builtin_skills'),
  workspaceRoot: path.resolve(__dirname, '..'),
  clipboard: clipboard
});

function logLifecycle(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'app_lifecycle.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

let isStartingLlama = false;
let logStream = null;

function getLogStream() {
  if (!logStream) {
    try {
      logStream = fs.createWriteStream(path.join(__dirname, 'llama_server.log'), { flags: 'a' });
    } catch {}
  }
  return logStream;
}

function startLlamaServer() {
  const llmDir = path.join(__dirname, 'llm');
  const llamaExe = path.join(llmDir, 'llama-server.exe');
  const modelFile = path.join(llmDir, 'qwen2.5-coder-3b-instruct-q4_k_m.gguf');

  if (!fs.existsSync(llamaExe) || !fs.existsSync(modelFile)) {
    console.warn('[LlamaServer] Local binary or model not found in llm/, skipping auto-spawn');
    return;
  }

  if (llamaProcess || isStartingLlama) return;

  // Check if llama-server is already running on 18910
  const probeReq = http.get('http://127.0.0.1:18910/health', (res) => {
    res.resume();
    if (res.statusCode === 200 || res.statusCode === 503) {
      console.log('[LlamaServer] Ready on http://127.0.0.1:18910');
      logLifecycle('llama-server already running on 18910');
      return;
    }
  });

  probeReq.on('error', () => {
    if (llamaProcess || isStartingLlama) return;
    isStartingLlama = true;
    console.log('[LlamaServer] Spawning local inference server...');
    try {
      llamaProcess = spawn(llamaExe, [
        '-m', modelFile,
        '--port', '18910',
        '--host', '127.0.0.1',
        '-c', '8192',
        '-t', '8',
        '--flash-attn', 'auto'
      ], {
        cwd: llmDir,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      llamaProcess.stderr.on('data', (d) => {
        const msg = d.toString();
        logLifecycle('llama-stderr: ' + msg.trim().slice(0, 120));
        if (msg.includes('listening on')) {
          console.log('[LlamaServer] Ready on http://127.0.0.1:18910');
          logLifecycle('llama-server ready on 18910');
          isStartingLlama = false;
        }
      });

      llamaProcess.on('error', (err) => {
        console.error('[LlamaServer Spawn Error]', err);
        logLifecycle('llama spawn error: ' + err.message);
        isStartingLlama = false;
      });

      llamaProcess.on('exit', (code, signal) => {
        console.log('[LlamaServer Exited]', code, signal);
        logLifecycle(`llama exited with code=${code}, signal=${signal}`);
        llamaProcess = null;
        isStartingLlama = false;
        if (!app.isQuitting) {
          setTimeout(() => startLlamaServer(), 2000);
        }
      });
    } catch (err) {
      console.error('[LlamaServer Error]', err);
      isStartingLlama = false;
    }
  });

  probeReq.setTimeout(1000, () => probeReq.destroy(new Error('timeout')));
}

function createMainWindow() {
  console.log('[createMainWindow] Initializing window...');
  try {
    mainWindow = new BrowserWindow({
      title: 'Bionic Agent',
      width: 1200,
      height: 840,
      minWidth: 880,
      minHeight: 600,
      show: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: false,
      frame: false,
      transparent: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: false
      }
    });

    const htmlPath = path.join(__dirname, 'ui', 'index.html');
    console.log('[createMainWindow] Loading file:', htmlPath);
    mainWindow.loadFile(htmlPath);

    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[createMainWindow] HTML loaded successfully');
      logLifecycle('HTML loaded successfully');
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      logLifecycle(`Renderer [lvl ${level}]: ${message} (at ${line})`);
    });

    mainWindow.webContents.on('did-fail-load', (e, errCode, errDesc) => {
      console.error('[createMainWindow] Failed to load HTML:', errCode, errDesc);
      logLifecycle(`Failed to load HTML: ${errCode} - ${errDesc}`);
    });

    mainWindow.on('close', (e) => {
      console.log('[createMainWindow] Window close event fired');
      logLifecycle('mainWindow close event fired! Stack:\n' + (new Error().stack));
    });

    mainWindow.on('closed', () => {
      console.log('[createMainWindow] Window closed');
      logLifecycle('mainWindow closed event fired');
      mainWindow = null;
    });
  } catch (err) {
    console.error('[createMainWindow Exception]', err);
    logLifecycle('createMainWindow exception: ' + err.message);
  }
}

// Single instance management
const gotTheLock = app.requestSingleInstanceLock();
logLifecycle('requestSingleInstanceLock: ' + gotTheLock);

app.on('second-instance', () => {
  logLifecycle('second-instance event fired');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
});

app.whenReady().then(() => {
  logLifecycle('app.whenReady fired');
  startLlamaServer();
  createMainWindow();

  app.on('activate', () => {
    logLifecycle('app activate event fired');
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  logLifecycle('app before-quit event fired');
  app.isQuitting = true;
  if (llamaProcess) {
    try { llamaProcess.kill(); } catch {}
  }
});

app.on('window-all-closed', () => {
  logLifecycle('app window-all-closed event fired');
  if (llamaProcess) {
    try { llamaProcess.kill(); } catch {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================================
// IPC Handlers: Window Controls
// ============================================================================

ipcMain.on('hub-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on('hub-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.on('hub-close', () => {
  logLifecycle('IPC hub-close received');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle('close-app', () => {
  logLifecycle('IPC close-app received');
  app.quit();
});

ipcMain.on('open-external', (event, url) => {
  if (url && typeof url === 'string') {
    shell.openExternal(url).catch(err => console.error('[Open External Error]', err));
  }
});

// Prompt Execution with Streaming
ipcMain.handle('bionic-execute', async (event, payload) => {
  try {
    const text = typeof payload === 'string' ? payload : (payload.prompt || '');
    const options = typeof payload === 'object' ? payload : {};
    const result = await bionic.harness.executeMultiStep(text, options, (evt, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bionic-stream', { evt, data });
      }
    });
    return result;
  } catch (err) {
    console.error('[Bionic Execute Error]', err);
    return { error: err.message, stepsExecuted: [] };
  }
});

// Context & Token Metrics
ipcMain.handle('get-context-metrics', async () => {
  try {
    return bionic.harness.getContextMetrics();
  } catch (err) {
    return { estimatedTokens: 0, maxTokens: 2048, percentUsed: 0 };
  }
});

// Virtual File System & Memory
ipcMain.handle('get-vfs-artifacts', async () => {
  try {
    const list = bionic.vfs.readDir('/artifacts');
    return list.map(item => {
      try {
        const content = bionic.vfs.readJson(item.virtualPath);
        return { name: item.name, path: item.virtualPath, ...content };
      } catch {
        return { name: item.name, path: item.virtualPath };
      }
    });
  } catch {
    return [];
  }
});

ipcMain.handle('get-vfs-memory', async () => {
  try {
    let memoryMd = '';
    let tasteMd = '';
    let profileMd = '';
    try { memoryMd = bionic.vfs.readFile('/memory.md') || ''; } catch {}
    try { tasteMd = bionic.vfs.readFile('/taste.md') || ''; } catch {}
    try { profileMd = bionic.vfs.readFile('/profile.md') || ''; } catch {}

    return {
      memoryMd,
      tasteMd,
      profileMd,
      profile: bionic.memory.getProfile(),
      contacts: bionic.memory.getContacts()
    };
  } catch {
    return { memoryMd: '', tasteMd: '', profileMd: '', profile: {}, contacts: [] };
  }
});

ipcMain.handle('save-vfs-file', async (event, { path: vPath, content }) => {
  try {
    if (!vPath || typeof content !== 'string') return { success: false, error: 'Invalid parameters' };
    bionic.vfs.writeFile(vPath, content);
    if (vPath === '/taste.md' && bionic.memory) {
      bionic.memory.updateTasteMd(content);
    } else if (vPath === '/profile.md' && bionic.memory) {
      bionic.memory.updateProfileMd(content);
    }
    return { success: true, path: vPath, size: content.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Recent Conversations
ipcMain.handle('list-conversations', async () => {
  try {
    if (!bionic.memory) return [];
    return bionic.memory.listSessions();
  } catch (e) {
    return [];
  }
});

ipcMain.handle('get-conversation', async (event, sessionId) => {
  try {
    if (!bionic.memory) return null;
    const session = bionic.memory.getSession(sessionId);
    if (session && sessionId) {
      bionic.memory.sessionId = sessionId;
    }
    return session;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('delete-conversation', async (event, sessionId) => {
  try {
    if (!bionic.memory) return false;
    return bionic.memory.deleteSession(sessionId);
  } catch (e) {
    return false;
  }
});

ipcMain.handle('new-conversation', async () => {
  try {
    if (!bionic.memory) return { success: false, sessionId: `session_${Date.now()}` };
    const newId = bionic.memory.startNewSession();
    return { success: true, sessionId: newId };
  } catch (e) {
    return { success: false, sessionId: `session_${Date.now()}` };
  }
});

ipcMain.handle('get-current-session-id', async () => {
  try {
    return bionic.memory ? bionic.memory.sessionId : null;
  } catch (e) {
    return null;
  }
});

// Skills & MCPs
ipcMain.handle('upload-skill', async (event, { name, content }) => {
  try {
    if (!bionic.skills) return { success: false, error: 'Skills engine not initialized' };
    return bionic.skills.uploadSkill(name, content);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-skills-and-mcps', async () => {
  try {
    if (!bionic.skills) return { skills: [], mcpServers: [] };
    return bionic.skills.listAll();
  } catch (e) {
    return { skills: [], mcpServers: [], error: e.message };
  }
});

// Interactive Code Diffs & VS Code Live Editing
ipcMain.handle('open-in-vscode', async (event, { filePath, line, column }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return await bionic.diffEngine.openInVSCode(filePath, line, column);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-diff-vscode', async (event, { originalPath, modifiedPath }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return await bionic.diffEngine.openDiffInVSCode(originalPath, modifiedPath);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-workspace-vscode', async (event, { folderPath }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return await bionic.diffEngine.openWorkspaceInVSCode(folderPath);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('apply-workspace-diff', async (event, { filePath, newContent }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return bionic.diffEngine.applyDiff(filePath, newContent);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('revert-workspace-diff', async (event, { filePath, backupPath }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return bionic.diffEngine.revertBackup(filePath, backupPath);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('run-terminal-command', async (event, { command, cwd }) => {
  try {
    if (!bionic.diffEngine) return { success: false, error: 'Diff engine not initialized' };
    return await bionic.diffEngine.runWorkspaceVerification(command, cwd);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('run-self-heal', async (event, { filePath, newContent, command }) => {
  try {
    if (!bionic.harness) return { success: false, error: 'Harness not initialized' };
    return await bionic.harness.executeSelfHealingLoop(filePath, newContent, command);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-workspace-file', async (event, filePath) => {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) return { success: false, error: 'File not found' };
    const content = fs.readFileSync(resolved, 'utf-8');
    return {
      success: true,
      filePath: resolved,
      content,
      size: content.length,
      language: bionic.diffEngine ? bionic.diffEngine.inferLanguage(resolved) : 'text'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-workspace-files', async (event, subDir = '') => {
  try {
    const targetDir = path.join(process.cwd(), subDir);
    if (!fs.existsSync(targetDir)) return [];
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    return entries
      .filter(e => !['node_modules', '.git', '.bionic_backups', 'dist', 'build'].includes(e.name))
      .slice(0, 100)
      .map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: path.join(subDir, e.name).replace(/\\/g, '/')
      }));
  } catch {
    return [];
  }
});

ipcMain.handle('compute-diff', async (event, { originalContent, newContent, filePath }) => {
  try {
    if (!bionic.diffEngine) return null;
    return bionic.diffEngine.computeDiff(originalContent, newContent, filePath || 'code');
  } catch {
    return null;
  }
});

ipcMain.handle('clear-chat', async () => {
  return true;
});
