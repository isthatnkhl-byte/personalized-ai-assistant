/**
 * AG-UI Protocol Bridge (ag-ui.com standard)
 * Decoupled event streaming between Bionic Agent Harness and UI clients
 */

const EventEmitter = require('events');

class AGUIProtocolBridge extends EventEmitter {
  constructor(ipcWindow) {
    super();
    this.ipcWindow = ipcWindow;
  }

  setWindow(win) {
    this.ipcWindow = win;
  }

  emitEvent(eventName, payload) {
    const event = {
      event: eventName,
      timestamp: Date.now(),
      ...payload
    };

    // Emit on local node EventEmitter
    this.emit(eventName, event);
    this.emit('*', event);

    // Forward to Electron IPC if window is active
    if (this.ipcWindow && !this.ipcWindow.isDestroyed()) {
      try {
        this.ipcWindow.webContents.send('ag-ui-event', event);
      } catch {}
    }
  }

  runStarted(runId, prompt) {
    this.emitEvent('RUN_STARTED', { runId, prompt });
  }

  toolCallStart(runId, callId, tool, args) {
    this.emitEvent('TOOL_CALL_START', { runId, callId, tool, args });
  }

  stateDelta(runId, patch) {
    this.emitEvent('STATE_DELTA', { runId, patch });
  }

  toolCallResult(runId, callId, tool, result) {
    this.emitEvent('TOOL_CALL_RESULT', { runId, callId, tool, result });
  }

  textMessageContent(runId, delta, fullText) {
    this.emitEvent('TEXT_MESSAGE_CONTENT', { runId, delta, fullText });
  }

  runFinished(runId, summary, durationMs) {
    this.emitEvent('RUN_FINISHED', { runId, summary, durationMs, success: true });
  }

  runError(runId, error, durationMs) {
    this.emitEvent('RUN_FINISHED', { runId, error: error.message || error, durationMs, success: false });
  }
}

module.exports = AGUIProtocolBridge;
