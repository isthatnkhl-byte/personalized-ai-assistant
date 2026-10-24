const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowAPI', {
  // Push-to-Talk Overlay IPC
  onHotkeyStart: (cb) => ipcRenderer.on('hotkey-start', () => cb()),
  onHotkeyStop: (cb) => ipcRenderer.on('hotkey-stop', () => cb()),
  onHotkeyIdle: (cb) => ipcRenderer.on('hotkey-idle', () => cb()),
  onTextPasted: (cb) => ipcRenderer.on('text-pasted', (e, text) => cb(text)),
  onAgentAction: (cb) => ipcRenderer.on('agent-action', (e, action) => cb(action)),
  onAgUiEvent: (cb) => ipcRenderer.on('ag-ui-event', (e, event) => cb(event)),
  transcribeAndPaste: (wavBuffer) => ipcRenderer.invoke('transcribe-and-paste', wavBuffer),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
  setWindowSize: (w, h) => ipcRenderer.send('set-window-size', w, h),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  closeApp: () => ipcRenderer.invoke('close-app'),

  // Hub Window Controls & History
  openHub: () => ipcRenderer.send('hub-show'),
  minimizeWindow: () => ipcRenderer.send('hub-minimize'),
  maximizeWindow: () => ipcRenderer.send('hub-maximize'),
  closeWindow: () => ipcRenderer.send('hub-close'),
  onNewDictation: (cb) => ipcRenderer.on('new-dictation', (e, entry) => cb(entry)),

  // Bionic Model Text Interface & Multi-Step Agentic IPC
  executePrompt: (text) => ipcRenderer.invoke('bionic-execute', text),
  getContextMetrics: () => ipcRenderer.invoke('get-context-metrics'),
  getVfsArtifacts: () => ipcRenderer.invoke('get-vfs-artifacts'),
  getVfsMemory: () => ipcRenderer.invoke('get-vfs-memory'),
  saveVfsFile: (filePath, content) => ipcRenderer.invoke('save-vfs-file', { path: filePath, content }),
  uploadSkill: (name, content) => ipcRenderer.invoke('upload-skill', { name, content }),
  listSkillsAndMcps: () => ipcRenderer.invoke('list-skills-and-mcps'),

  // Interactive Code Diffs & Workspace In-Place File Editing IPC
  openInVSCode: (options) => ipcRenderer.invoke('open-in-vscode', options || {}),
  openDiffInVSCode: (originalPath, modifiedPath) => ipcRenderer.invoke('open-diff-vscode', { originalPath, modifiedPath }),
  openWorkspaceInVSCode: (folderPath) => ipcRenderer.invoke('open-workspace-vscode', { folderPath }),
  applyWorkspaceDiff: (filePath, newContent) => ipcRenderer.invoke('apply-workspace-diff', { filePath, newContent }),
  revertWorkspaceDiff: (filePath, backupPath) => ipcRenderer.invoke('revert-workspace-diff', { filePath, backupPath }),
  runTerminalCommand: (command, cwd) => ipcRenderer.invoke('run-terminal-command', { command, cwd }),
  runSelfHeal: (filePath, newContent, command) => ipcRenderer.invoke('run-self-heal', { filePath, newContent, command }),
  getWorkspaceFile: (filePath) => ipcRenderer.invoke('get-workspace-file', filePath),
  listWorkspaceFiles: (subDir) => ipcRenderer.invoke('list-workspace-files', subDir),
  computeDiff: (originalContent, newContent, filePath) => ipcRenderer.invoke('compute-diff', { originalContent, newContent, filePath }),

  // Recent Conversations & Session Management
  listConversations: () => ipcRenderer.invoke('list-conversations'),
  getConversation: (sessionId) => ipcRenderer.invoke('get-conversation', sessionId),
  deleteConversation: (sessionId) => ipcRenderer.invoke('delete-conversation', sessionId),
  newConversation: () => ipcRenderer.invoke('new-conversation'),
  getCurrentSessionId: () => ipcRenderer.invoke('get-current-session-id'),

  clearChat: () => ipcRenderer.invoke('clear-chat'),
  onBionicStream: (cb) => ipcRenderer.on('bionic-stream', (e, data) => cb(data)),
});
