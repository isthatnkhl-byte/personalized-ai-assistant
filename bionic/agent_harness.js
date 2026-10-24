/**
 * Bionic-GPT Agent Harness & Durable Workflow Orchestrator
 * Integrates VFS, Skills Engine, Memory Store, RAG, Sandbox Gateway & AG-UI Protocol
 * Multi-Step Reasoning, Chain-of-Thought Planning & Tool Execution
 * Based on crates/agent-harness
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

class BionicAgentHarness {
  constructor(options = {}) {
    this.vfs = options.vfs;
    this.skills = options.skills;
    this.memory = options.memory;
    this.rag = options.rag;
    this.vectorMemory = options.vectorMemory;
    this.graphMemory = options.graphMemory;
    this.gateway = options.gateway;
    this.diffEngine = options.diffEngine || null;
    this.agui = options.agui;
    this.clipboard = options.clipboard;

    if (!this.gateway) {
      try {
        const BionicSandboxGateway = require('./sandbox_gateway');
        this.gateway = new BionicSandboxGateway(this.vfs);
      } catch {}
    }
  }

  // Get live context metrics & token inspector details
  getContextMetrics() {
    const profile = this.memory ? this.memory.getProfile() : {};
    const contacts = this.memory ? this.memory.getContacts() : [];
    let memoryLines = 0;
    let memorySnippet = '';
    try {
      const mem = this.vfs.readFile('/memory.md');
      const lines = mem.split('\n').filter(l => l.trim());
      memoryLines = lines.length;
      memorySnippet = lines.slice(0, 8).join('\n');
    } catch {}

    const skills = this.skills ? this.skills.listSkills() : [];
    let clipText = '';
    try {
      clipText = this.clipboard ? this.clipboard.readText() : '';
    } catch {}

    const ragChunks = this.rag && this.rag.chunkIndex ? this.rag.chunkIndex.length : 0;
    const vectorDocs = this.vectorMemory && this.vectorMemory.documents ? this.vectorMemory.documents.length : 0;
    const graphNodes = this.graphMemory && this.graphMemory.nodes ? this.graphMemory.nodes.size : 0;
    const graphEdges = this.graphMemory && this.graphMemory.edges ? this.graphMemory.edges.length : 0;

    // Estimate context tokens (approx 3.8 chars per token)
    const promptSample = JSON.stringify(profile) + JSON.stringify(contacts) + (this.skills ? this.skills.getPromptContext() : '');
    const maxTokens = 4096;
    const estimatedTokens = Math.min(maxTokens, Math.round(promptSample.length / 3.8) + 180);
    const percentUsed = Math.min(100, Math.round((estimatedTokens / maxTokens) * 100));

    return {
      profile,
      contacts,
      contactsCount: contacts.length,
      memoryLines,
      memorySnippet,
      skills,
      skillsCount: skills.length,
      ragChunks,
      vectorDocs,
      graphNodes,
      graphEdges,
      clipboardSnippet: clipText ? (clipText.slice(0, 100) + (clipText.length > 100 ? '...' : '')) : '(Clipboard is empty)',
      estimatedTokens,
      maxTokens,
      percentUsed
    };
  }

  // Check if prompt is a conversational question, greeting, or knowledge query
  isConversationalQuery(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return true;

    // Direct greetings or short conversational triggers
    if (/^(hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening)|yo|sup|howdy)\b/i.test(trimmed)) {
      return true;
    }

    // Direct questions seeking explanations, definitions, bios, concepts
    if (/^(who|what|where|when|why|how|which|whose|whom|is|are|was|were|can you explain|explain|tell me about|tell me a|describe|define)\b/i.test(trimmed)) {
      if (/(?:my\s+clipboard)/i.test(trimmed)) return false;
      return true;
    }

    // Creative or chat prompts
    if (/^(write a poem|tell a joke|tell me a joke|sing a song|who are you|what can you do|what are you)\b/i.test(trimmed)) {
      return true;
    }

    // Casual chat & gratitude
    if (/^(thanks|thank you|cool|great|awesome)\b/i.test(trimmed)) {
      return true;
    }

    return false;
  }

  // Clean query extractor for GitHub repository searches
  cleanGitHubQuery(text) {
    let q = (text || '')
      .replace(/^(?:can\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|check|get|show)\s+(?:me\s+)?/i, '')
      .replace(/^(?:github|gh)\s+(?:for\s+)?/i, '')
      .replace(/^(?:the\s+)?(?:github\s+)?(?:repo|repository)\s+(?:for|of)\s+/i, '')
      .replace(/^(?:for|the|a|an|me)\s+/i, '')
      .replace(/\s+(?:on|in)\s+github$/i, '')
      .replace(/\s+(?:official\s+)?(?:github\s+)?repo(?:sitory)?$/i, '')
      .replace(/[?.,!]$/, '')
      .trim();
    return q;
  }

  // Fast pattern matcher (<0.5ms) for single tool intents
  fastMatch(text) {
    const trimmed = (text || '').trim();

    // 0a. TinyFish search: "tinyfish search query newly released AI projects", "search with tinyfish for..."
    const tfSearchMatch = trimmed.match(/^(?:tinyfish\s+(?:search(?:\s+query)?|query)|(?:search|query)\s+(?:with\s+)?tinyfish(?:\s+for)?)\s+(.*)$/i);
    if (tfSearchMatch && tfSearchMatch[1]) {
      const q = tfSearchMatch[1].replace(/^["']|["']$/g, '').trim();
      return {
        tool: 'web_research.tinyfish_search',
        action: 'TINYFISH_SEARCH',
        args: { query: q }
      };
    }

    // 0b. TinyFish fetch / URL scraping: "tinyfish fetch content get https://docs.tinyfish.ai", "fetch content from https://...", "scrape https://..."
    const tfFetchMatch = trimmed.match(/^(?:tinyfish\s+fetch(?:\s+content)?(?:\s+get)?|fetch(?:\s+content)?(?:\s+from)?|scrape)\s+(https?:\/\/[^\s"']+)/i);
    if (tfFetchMatch && tfFetchMatch[1]) {
      return {
        tool: 'web_research.tinyfish_fetch',
        action: 'TINYFISH_FETCH',
        args: { url: tfFetchMatch[1].trim() }
      };
    }

    // 0c. Read File or Skill: "read file /memory.md", "read skill tinyfish_web_agent", "read skill web_research"
    const readSkillMatch = trimmed.match(/^(?:please\s+)?read\s+skill\s+([a-zA-Z0-9_-]+)/i);
    if (readSkillMatch && readSkillMatch[1]) {
      return {
        tool: 'skill_runtime.read_skill',
        action: 'READ_SKILL',
        args: { skill: readSkillMatch[1].trim() }
      };
    }

    const readFileMatch = trimmed.match(/^(?:please\s+)?read\s+file\s+([a-zA-Z0-9_./-]+)/i);
    if (readFileMatch && readFileMatch[1]) {
      return {
        tool: 'vfs.read_file',
        action: 'READ_FILE',
        args: { path: readFileMatch[1].trim() }
      };
    }

    // 1. GitHub live repo search & data retrieval
    // "search github for bionic gpt repo", "search for bionic gpt repo", "find bionic gpt on github"
    const ghMatch = trimmed.match(/^(?:please\s+)?(?:search|find|look\s+up|check)\s+(?:github|gh)\s+(?:for\s+)?(.*)$/i) ||
                    trimmed.match(/^(?:please\s+)?(?:search|find|look\s+up)\s+(?:for\s+)?(.*?)\s+(?:on|in)\s+github$/i) ||
                    trimmed.match(/^(?:please\s+)?(?:search|find)\s+(?:for\s+)?(.*?)\s+(?:github\s+)?repo(?:sitory)?$/i);
    if (ghMatch && ghMatch[1] && ghMatch[1].trim()) {
      let q = this.cleanGitHubQuery(ghMatch[1]) || ghMatch[1].trim();
      return {
        tool: 'web_research.search_github',
        action: 'GITHUB_SEARCH',
        args: { query: q }
      };
    }

    // 2. Platform-specific live UI search:
    // "search youtube for lofi beats", "search spotify for anuv jain", "search amazon for headphones"
    const platformSearchMatch = trimmed.match(/^(?:please\s+)?(?:search|find|look\s+up)\s+(?:on\s+)?(youtube|yt|spotify|amazon|reddit|twitter|x|google)\s+(?:for\s+)?(.*)$/i) ||
                                trimmed.match(/^(?:please\s+)?(?:search|find|look\s+up)\s+(?:for\s+)?(.*?)\s+(?:on|in)\s+(youtube|yt|spotify|amazon|reddit|twitter|x|google)$/i);
    if (platformSearchMatch) {
      const platform = (platformSearchMatch[1] || platformSearchMatch[3] || '').toLowerCase();
      const query = (platformSearchMatch[2] || platformSearchMatch[1] || '').trim().replace(/^for\s+/i, '');
      return {
        tool: 'web_research.platform_search',
        action: 'PLATFORM_SEARCH',
        args: { platform, query }
      };
    }

    // 3. Music play: "play anuv jain song on spotify", "play husn", "play starboy"
    const musicMatch = trimmed.match(/^(?:please\s+)?play\s+(.*?)(?:\s+on\s+spotify|\s+in\s+spotify)?$/i);
    if (musicMatch && musicMatch[1] && musicMatch[1].trim()) {
      let q = musicMatch[1].trim();
      q = q.replace(/\s+song$/i, '').trim();
      return {
        tool: 'system_control.play_music',
        action: 'PLAY_MUSIC',
        args: { query: q, app: 'spotify' }
      };
    }

    // 4. Web search: "search what is the population of Tokyo", "google Next.js 15 docs"
    const searchMatch = trimmed.match(/^(?:please\s+)?(?:search(?:\s+for)?|google|look\s+up)\s+(.*)$/i);
    if (searchMatch && searchMatch[1] && searchMatch[1].trim()) {
      return {
        tool: 'web_research.search_web',
        action: 'WEB_SEARCH',
        args: { query: searchMatch[1].trim() }
      };
    }

    // 4b. VS Code direct open: "open in vs code", "open hello.py in vs code", "open project in vs code", "launch vscode"
    const vsCodeFileMatch = trimmed.match(/^(?:please\s+)?open\s+(?:file\s+)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)\s+(?:in|with)\s+(?:vs\s*code|vscode)$/i) ||
                            trimmed.match(/^(?:please\s+)?(?:vs\s*code|vscode)\s+([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)$/i);
    if (vsCodeFileMatch && vsCodeFileMatch[1]) {
      return {
        tool: 'code_editor.open_vscode',
        action: 'OPEN_VSCODE',
        args: { filePath: vsCodeFileMatch[1].trim() }
      };
    }

    if (/^(?:please\s+)?(?:open|launch)\s+(?:workspace|project|folder|code|editor)?\s*(?:in\s+)?(?:vs\s*code|vscode)$/i.test(trimmed)) {
      return {
        tool: 'code_editor.open_vscode',
        action: 'OPEN_VSCODE',
        args: {}
      };
    }

    // 5. Open URL, Desktop App, or Web App: "open pinterest on my laptop", "launch vscode", "open calculator"
    if (/^(?:can\s+you\s+)?(?:please\s+)?(?:open|launch|start|run|go\s+to|navigate\s+to|visit|view|browse|take\s+me\s+to)\b/i.test(trimmed)) {
      const openAnalysis = this.gateway ? this.gateway.analyzeOpenTarget(trimmed) : null;
      if (openAnalysis && openAnalysis.target) {
        const target = openAnalysis.target;
        const targetLower = target.toLowerCase();

        // Check if direct URL or dot domain
        if (targetLower.startsWith('http://') || targetLower.startsWith('https://') || (targetLower.includes('.') && !targetLower.includes(' '))) {
          const u = targetLower.startsWith('http') ? targetLower : `https://${targetLower}`;
          return {
            tool: 'web_research.open_url',
            action: 'OPEN_URL',
            args: { url: u, label: target }
          };
        }

        // If user did NOT explicitly ask for website, check local desktop apps
        if (!openAnalysis.isExplicitWebsite && this.gateway && this.gateway.isDesktopApp(targetLower)) {
          const entry = this.gateway.desktopApps[targetLower];
          return {
            tool: 'system_control.launch_app',
            action: 'OPEN_APP',
            args: { app: targetLower, label: entry ? entry.name : target }
          };
        }

        // Check known web apps
        if (this.gateway && this.gateway.webApps && this.gateway.webApps[targetLower]) {
          return {
            tool: 'web_research.open_url',
            action: 'OPEN_URL',
            args: { url: this.gateway.webApps[targetLower].url, label: this.gateway.webApps[targetLower].label }
          };
        }

        // Autonomous domain discovery via TinyFish and web opening
        return {
          tool: 'system_control.launch_app',
          action: 'RESOLVE_AND_OPEN',
          args: {
            target: target,
            app: target,
            isExplicitWebsite: openAnalysis.isExplicitWebsite,
            isExplicitApp: openAnalysis.isExplicitApp,
            rawPrompt: trimmed
          }
        };
      }
    }

    // 4. Clipboard: "read my clipboard", "what's on my clipboard"
    if (/^(?:please\s+)?(?:read|what is on|what's on|check|summarize)\s+(?:my\s+)?clipboard/i.test(trimmed)) {
      return {
        tool: 'office_tools.read_clipboard',
        action: 'READ_CLIPBOARD',
        args: {}
      };
    }

    // 5. Email: "write an email to Sarah asking for the project update and open compose", "draft email to alex@example.com", etc.
    const emailMatch = trimmed.match(/^(?:please\s+)?(?:write|draft|send|compose)\s+(?:an?\s+)?(?:email|mail)\s+(?:to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[a-zA-Z0-9\s]+?))(?:\s+(?:asking\s+for|about|regarding|saying|for)\s+(.*))?$/i);
    if (emailMatch && emailMatch[1]) {
      let recipient = emailMatch[1].trim();
      let topic = (emailMatch[2] || '').trim();
      topic = topic.replace(/\s+(?:and\s+)?open\s+(?:compose|email|gmail)?$/i, '').trim();
      return {
        tool: 'office_tools.compose_email',
        action: 'COMPOSE_EMAIL',
        args: {
          recipient,
          topic: topic || 'Project Update'
        }
      };
    }

    const genericEmailMatch = trimmed.match(/^(?:please\s+)?(?:write|draft|send|compose)\s+(?:an?\s+)?(?:email|mail)(?:\s+(?:about|regarding|for|saying)\s+(.*))?$/i);
    if (genericEmailMatch) {
      let topic = (genericEmailMatch[1] || '').trim();
      topic = topic.replace(/\s+(?:and\s+)?open\s+(?:compose|email|gmail)?$/i, '').trim();
      return {
        tool: 'office_tools.compose_email',
        action: 'COMPOSE_EMAIL',
        args: {
          recipient: 'Recipient',
          topic: topic || 'New Message'
        }
      };
    }

    return null;
  }

  // Decompose composite multi-step voice/text commands
  decomposeCompositePrompt(text) {
    const trimmed = (text || '').trim();
    // Split on sequential phrases: "and then", "then", or "and" followed by action verb
    const regex = /\s+(?:and\s+then|then|and\s+also)\s+|\s+and\s+(?=(?:play|open|launch|start|search|google|write|draft|read|check|look)\b)/i;
    const parts = trimmed.split(regex);
    if (parts.length > 1) {
      const steps = [];
      let lastPlatform = null;

      for (let i = 0; i < parts.length; i++) {
        const cleanP = parts[i].trim();

        // Check if this part specifies opening a platform or app
        const openCheck = cleanP.match(/^(?:open|launch|go to)\s+([a-zA-Z0-9._-]+)\b/i);
        if (openCheck) {
          lastPlatform = openCheck[1].toLowerCase();
        }

        // If previous part opened a platform and this part is searching, search ON that platform!
        if (lastPlatform && i > 0 && /^(?:search(?:\s+for)?|look\s+up|find)\s+(.*)$/i.test(cleanP)) {
          const sMatch = cleanP.match(/^(?:search(?:\s+for)?|look\s+up|find)\s+(.*)$/i);
          const q = sMatch[1].trim().replace(/\s+repo(?:sitory)?$/i, '');
          if (lastPlatform === 'github' || lastPlatform === 'gh') {
            steps.push({
              tool: 'web_research.search_github',
              action: 'GITHUB_SEARCH',
              args: { query: q }
            });
            continue;
          } else if (lastPlatform === 'youtube' || lastPlatform === 'spotify' || lastPlatform === 'amazon' || lastPlatform === 'reddit' || lastPlatform === 'twitter' || lastPlatform === 'google') {
            steps.push({
              tool: 'web_research.platform_search',
              action: 'PLATFORM_SEARCH',
              args: { platform: lastPlatform, query: q }
            });
            continue;
          } else {
            steps.push({
              tool: 'web_research.search_web',
              action: 'WEB_SEARCH',
              args: { query: `${q} site:${lastPlatform}.com` }
            });
            continue;
          }
        }

        const matched = this.fastMatch(cleanP);
        if (matched) {
          steps.push(matched);
        }
      }
      if (steps.length > 1) {
        return steps;
      }
    }
    return null;
  }

  // Probe local llama-server health, auto-spawning if offline, and wait until model is loaded
  async ensureLlamaReady(maxWaitMs = 15000) {
    const checkOnce = () => new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:18910/health', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => {
        try { req.destroy(); } catch {}
        resolve(false);
      });
    });

    let ready = await checkOnce();
    if (ready) return true;

    // Auto-spawn local llama-server if not running
    try {
      const { spawn } = require('child_process');
      const llmDir = path.join(__dirname, '..', 'llm');
      const llamaExe = path.join(llmDir, 'llama-server.exe');
      const modelFile = path.join(llmDir, 'qwen2.5-coder-3b-instruct-q4_k_m.gguf');
      if (fs.existsSync(llamaExe) && fs.existsSync(modelFile)) {
        console.log('[AgentHarness] Auto-spawning local llama-server...');
        const proc = spawn(llamaExe, [
          '-m', modelFile,
          '--port', '18910',
          '--host', '127.0.0.1',
          '-c', '8192',
          '-t', '8',
          '--flash-attn', 'auto'
        ], {
          cwd: llmDir,
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();
      }
    } catch (e) {
      console.warn('[AgentHarness] Could not auto-spawn llama-server:', e.message);
    }

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await checkOnce()) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // Fallback answer when LLM is initializing or loading
  fallbackLocalAnswer(userPrompt, webContext = null) {
    if (webContext) {
      return `### Verified Grounded Context\n\n${webContext}\n\n*Note: Verified ground-truth sources retrieved successfully.*`;
    }
    return `I analyzed your prompt: "${userPrompt}". The local LLM engine is currently initializing; please retry in a few moments.`;
  }

  // Direct conversational & coding synthesis with Qwen 2.5 Coder 3B (with Token-by-Token Live Streaming)
  async chatWithLLM(userPrompt, webContext = null, history = [], eventCallback = null, extraContext = {}) {
    if (typeof webContext === 'function') {
      eventCallback = webContext;
      webContext = null;
      history = [];
    } else if (typeof history === 'function') {
      eventCallback = history;
      history = [];
    } else if (typeof extraContext === 'function') {
      eventCallback = extraContext;
      extraContext = {};
    }

    // Ensure local llama-server is ready before connecting
    await this.ensureLlamaReady(6000);

    const memoryCtx = this.memory ? this.memory.getSystemPromptContext() : '';
    const profile = this.memory ? this.memory.getProfile() : {};
    const userName = profile.name || 'User';

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const todayDateOnly = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;

    let systemPrompt = `You are Bionic-GPT, an elite autonomous personal AI assistant and engineering copilot for ${userName}.
You possess deep technical knowledge, software architecture mastery, and general intelligence.

Current Date & Time: ${todayStr} (${todayDateOnly})
${memoryCtx}`;

    if (extraContext && extraContext.graphContext) {
      systemPrompt += `\n\n${extraContext.graphContext}`;
    }

    if (extraContext && extraContext.vectorContext) {
      systemPrompt += `\n\n## EPISODIC & SEMANTIC MEMORY VAULT:\n${extraContext.vectorContext}`;
    }

    if (extraContext && extraContext.ragContext) {
      systemPrompt += `\n\n${extraContext.ragContext}`;
    }

    if (webContext) {
      systemPrompt += `\n\nLIVE GROUND-TRUTH WEB SEARCH CONTEXT:\n${webContext}\n\nInstructions for using Web Context:
- Incorporate these fresh verified facts, dates, features, and source details directly into your answer.
- Where appropriate, cite the source domains or URLs.`;
    }

    systemPrompt += `\n\nGuidelines:
- Provide comprehensive, natural, and helpful responses in clean Markdown.
- When the user asks you to write, create, edit, or run code or scripts:
  * You are directly connected to VS Code and the local workspace filesystem.
  * ALWAYS specify the filename on your code block using: \`\`\`<language> file="<filename>" (e.g. \`\`\`python file="hello.py")
  * Write complete, production-grade, immediately runnable code.
  * The system will automatically write your code to disk in the workspace and open it live in VS Code!
- Maintain full context of ongoing conversations. If the user refers to previous prompts, topics, code snippets, or entities ("it", "they", "the previous code", "the function"), answer with direct continuity from the previous turns.
- For casual greetings or chat, be friendly, concise, and ready to assist.
- Do NOT output JSON unless explicitly asked. Respond in natural language.`;

    // Construct multi-turn messages array
    const messages = [{ role: 'system', content: systemPrompt }];

    if (Array.isArray(history) && history.length > 0) {
      const recentHistory = history.slice(-10);
      for (const m of recentHistory) {
        if (m && m.content) {
          messages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
          });
        }
      }
    }

    messages.push({ role: 'user', content: userPrompt });

    const payload = JSON.stringify({
      messages,
      temperature: 0.3,
      max_tokens: 1024,
      stream: true
    });

    return new Promise((resolve) => {
      const startTime = Date.now();
      let fullContent = '';
      let tokenCount = 0;
      let tokPerSec = 0;
      let isDone = false;

      // Inactivity timeout: model can take as much time as needed.
      // Timer resets on every incoming streaming token chunk, only timing out after 5 minutes of total silence.
      let inactivityTimer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          console.warn('[BionicLLM] chatWithLLM inactivity timeout (5m).');
          resolve(fullContent.trim() || 'Response generation timed out.');
        }
      }, 300000);

      const resetInactivity = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (!isDone) {
            isDone = true;
            console.warn('[BionicLLM] chatWithLLM inactivity timeout (5m).');
            resolve(fullContent.trim() || 'Response generation timed out.');
          }
        }, 300000);
      };

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 18910,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            console.error(`[BionicLLM] chatWithLLM server returned HTTP ${res.statusCode}`);
            let errBody = '';
            res.on('data', c => errBody += c.toString());
            res.on('end', () => {
              console.error('[BionicLLM] chatWithLLM error details:', errBody);
              if (!isDone) {
                isDone = true;
                clearTimeout(inactivityTimer);
                resolve(this.fallbackLocalAnswer(userPrompt, webContext));
              }
            });
            return;
          }

          let buffer = '';

          res.on('data', (chunk) => {
            resetInactivity();
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                if (!isDone) {
                  isDone = true;
                  clearTimeout(inactivityTimer);
                  return resolve(fullContent.trim());
                }
                return;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  fullContent += delta;
                  tokenCount++;
                  const elapsedSec = (Date.now() - startTime) / 1000;
                  tokPerSec = elapsedSec > 0 ? (tokenCount / elapsedSec).toFixed(1) : 0;
                  if (eventCallback) {
                    eventCallback('TEXT_MESSAGE_CHUNK', {
                      delta,
                      fullText: fullContent,
                      tokenCount,
                      tokPerSec,
                      elapsedMs: Date.now() - startTime
                    });
                  }
                }
                if (parsed.timings?.predicted_per_second) {
                  tokPerSec = parsed.timings.predicted_per_second.toFixed(1);
                }
              } catch {}
            }
          });

          res.on('end', () => {
            if (!isDone) {
              isDone = true;
              clearTimeout(inactivityTimer);
              resolve(fullContent.trim());
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[BionicLLM] chatWithLLM request error:', err);
        if (!isDone) {
          isDone = true;
          clearTimeout(inactivityTimer);
          if (fullContent.trim().length > 0) {
            resolve(fullContent.trim());
          } else {
            resolve(`Local LLM synthesis failed to connect: ${err.message || 'Connection error'}.`);
          }
        }
      });

      req.write(payload);
      req.end();
    });
  }

  // Stream Pure Text Thinking Process from Qwen 2.5 Coder 3B (Antigravity-style)
  async streamThinkingTokens(userPrompt, webContext = null, history = [], eventCallback = null, extraContext = {}) {
    if (typeof history === 'function') {
      eventCallback = history;
      history = [];
    } else if (typeof extraContext === 'function') {
      eventCallback = extraContext;
      extraContext = {};
    }

    // Ensure local llama-server is ready before connecting
    await this.ensureLlamaReady(6000);

    let historySummary = '';
    if (Array.isArray(history) && history.length > 0) {
      const lastTurns = history.slice(-2);
      historySummary = `\nRecent Chat Context:\n` + lastTurns.map(t => `${t.role}: ${(t.content || '').slice(0, 100)}`).join('\n');
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const todayDateOnly = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;

    const payload = JSON.stringify({
      messages: [
        {
          role: 'system',
          content: `You are an expert cognitive reasoning engine. Analyze the user request, recent conversation context, and live context.
Current Date: ${todayStr} (${todayDateOnly})
Output your concise internal thinking process as 2-3 short bullet points.
Focus on:
1. Core user intent & multi-turn conversational context
2. Ground-truth facts & retrieved memory (always anchored to Current Date: ${todayDateOnly})
3. Plan for the tailored answer
Keep thoughts clear, direct, and under 80 words.`
        },
        {
          role: 'user',
          content: `Prompt: ${userPrompt}${historySummary}\n\nLive Context:\n${webContext || (extraContext && extraContext.ragContext) || '(Utilizing local memory and sovereign intelligence)'}`
        }
      ],
      temperature: 0.2,
      max_tokens: 150,
      stream: true
    });

    return new Promise((resolve) => {
      let thinkingText = '';
      let isDone = false;

      let inactivityTimer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          resolve(thinkingText.trim() || 'Analyzed prompt context and formulated execution plan.');
        }
      }, 120000);

      const resetInactivity = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (!isDone) {
            isDone = true;
            resolve(thinkingText.trim() || 'Analyzed prompt context and formulated execution plan.');
          }
        }, 120000);
      };

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 18910,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            console.error(`[BionicLLM] streamThinkingTokens returned HTTP ${res.statusCode}`);
            res.resume();
            if (!isDone) {
              isDone = true;
              clearTimeout(inactivityTimer);
              resolve('Formulated cognitive reasoning plan.');
            }
            return;
          }

          let buffer = '';
          res.on('data', (chunk) => {
            resetInactivity();
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                if (!isDone) {
                  isDone = true;
                  clearTimeout(inactivityTimer);
                  return resolve(thinkingText.trim());
                }
                return;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  thinkingText += delta;
                  if (eventCallback) {
                    eventCallback('THINKING_CHUNK', { delta, fullThinking: thinkingText });
                  }
                }
              } catch {}
            }
          });
          res.on('end', () => {
            if (!isDone) {
              isDone = true;
              clearTimeout(inactivityTimer);
              resolve(thinkingText.trim() || 'Formulated execution plan.');
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[BionicLLM] streamThinkingTokens error:', err);
        if (!isDone) {
          isDone = true;
          clearTimeout(inactivityTimer);
          resolve(thinkingText.trim() || 'Proceeding with execution plan.');
        }
      });

      req.write(payload);
      req.end();
    });
  }

  // Balanced-brace JSON extractor (handles nested objects safely)
  extractFirstJsonObject(str) {
    if (!str) return null;
    const startIdx = str.indexOf('{');
    if (startIdx === -1) return null;
    let depth = 0;
    for (let i = startIdx; i < str.length; i++) {
      if (str[i] === '{') depth++;
      else if (str[i] === '}') {
        depth--;
        if (depth === 0) {
          return str.substring(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  // Robust parser for Autonomous ReAct output (<thought>, <tool_call>, <final_answer>)
  parseAgentOutput(text) {
    const result = {
      thought: '',
      toolCall: null,
      finalAnswer: null
    };

    if (!text) return result;

    // 1. Extract <thought>...</thought> if present
    const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
    if (thoughtMatch) {
      result.thought = thoughtMatch[1].trim();
    } else {
      const thoughtRe = /(?:^|\n)Thought:\s*([\s\S]*?)(?=(?:\nAction:|\n<tool_call>|\n<final_answer>|$))/i;
      const m = text.match(thoughtRe);
      if (m) result.thought = m[1].trim();
    }

    // 2. Extract tool call from <tool_call> tags OR balanced JSON object
    let toolJsonStr = null;
    const toolCallMatch = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    if (toolCallMatch) {
      toolJsonStr = this.extractFirstJsonObject(toolCallMatch[1]) || toolCallMatch[1].replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    } else {
      toolJsonStr = this.extractFirstJsonObject(text);
    }

    if (toolJsonStr) {
      try {
        const parsed = JSON.parse(toolJsonStr);
        if (parsed && (parsed.function || parsed.tool || parsed.name || parsed.action)) {
          let rawTool = parsed.function || parsed.tool || parsed.name || (parsed.action ? `web_research.${parsed.action.toLowerCase()}` : 'web_research.tinyfish_search');
          if (rawTool === 'tinyfish_search' || rawTool === 'search_web' || rawTool === 'search') rawTool = 'web_research.tinyfish_search';
          if (rawTool === 'tinyfish_fetch' || rawTool === 'fetch') rawTool = 'web_research.tinyfish_fetch';
          if (rawTool === 'search_github' || rawTool === 'github') rawTool = 'web_research.search_github';
          if (rawTool === 'read_file') rawTool = 'vfs.read_file';
          if (rawTool === 'search_memory') rawTool = 'memory.search';

          const rawAction = parsed.action || (rawTool.includes('.') ? rawTool.split('.').pop().toUpperCase() : rawTool.toUpperCase());
          result.toolCall = {
            tool: rawTool,
            action: rawAction,
            args: parsed.args || parsed.arguments || parsed.parameters || (parsed.query ? { query: parsed.query } : (parsed.url ? { url: parsed.url } : {}))
          };
        }
      } catch (e) {
        console.warn('[parseAgentOutput] Failed to parse tool JSON:', e.message);
      }
    }

    // 2b. Check Action / Action Input if no tool_call tag
    if (!result.toolCall) {
      const actionMatch = text.match(/(?:^|\n)Action:\s*([a-zA-Z0-9_.-]+)/i);
      const inputMatch = text.match(/(?:^|\n)Action\s+Input:\s*([\s\S]*?)(?=(?:\nObservation:|\nThought:|$))/i);
      if (actionMatch) {
        let args = {};
        if (inputMatch) {
          try {
            const raw = inputMatch[1].trim();
            args = raw.startsWith('{') ? JSON.parse(raw) : { query: raw };
          } catch {
            args = { query: inputMatch[1].trim() };
          }
        }
        let rawTool = actionMatch[1].trim();
        if (rawTool === 'tinyfish_search' || rawTool === 'search') rawTool = 'web_research.tinyfish_search';
        if (rawTool === 'tinyfish_fetch' || rawTool === 'fetch') rawTool = 'web_research.tinyfish_fetch';
        if (rawTool === 'search_github' || rawTool === 'github') rawTool = 'web_research.search_github';
        result.toolCall = {
          tool: rawTool.includes('.') ? rawTool : `web_research.${rawTool.toLowerCase()}`,
          action: rawTool.includes('.') ? rawTool.split('.').pop().toUpperCase() : rawTool.toUpperCase(),
          args
        };
      }
    }

    // 3. Extract <final_answer> ONLY if no tool call was made!
    if (!result.toolCall) {
      const finalMatch = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
      if (finalMatch) {
        result.finalAnswer = finalMatch[1].trim();
      } else {
        let cleaned = text;
        if (thoughtMatch) {
          cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
        }
        cleaned = cleaned.replace(/^Thought:[\s\S]*?(?=\n\n|$)/i, '').trim();
        result.finalAnswer = cleaned || '';
      }
    }

    return result;
  }

  // Format rich observations from tool execution back into model prompt context
  formatObservation(action, result) {
    if (!result) return 'No result returned from tool.';

    if (action === 'TINYFISH_SEARCH' || action === 'WEB_SEARCH') {
      if (result.items && result.items.length > 0) {
        return `Live Web Grounding Sources (${result.items.length} verified):\n` +
          result.items.slice(0, 4).map((it, i) => `[Source ${i + 1}] Title: ${it.title}\nURL: ${it.url}\nDate: ${it.date || 'Recent'}\nSnippet: ${it.snippet || ''}`).join('\n\n');
      }
      return 'Search executed, but no matching live web sources found.';
    }

    if (action === 'TINYFISH_FETCH') {
      if (result.text) {
        return `Extracted Web Content (${result.url}):\n${result.text.slice(0, 2500)}`;
      }
      return `Failed to extract web content from ${result.url}.`;
    }

    if (action === 'GITHUB_SEARCH') {
      if (result.items && result.items.length > 0) {
        return `GitHub Repositories (${result.total_count || result.items.length} total):\n` +
          result.items.slice(0, 4).map((r, i) => `[Repo ${i + 1}] ${r.name} (⭐ ${(r.stars || 0).toLocaleString()} stars)\nDescription: ${r.description || 'None'}\nLanguage: ${r.language || 'Code'}\nURL: ${r.url}`).join('\n\n');
      }
      return 'No GitHub repositories found matching query.';
    }

    if (action === 'READ_FILE') {
      if (result.content) {
        return `Content of ${result.path}:\n${result.content.slice(0, 2000)}`;
      }
      return `File ${result.path} is empty or could not be read.`;
    }

    if (action === 'VECTOR_SEARCH' || action === 'GRAPH_TRAVERSAL') {
      return `Memory context: ${JSON.stringify(result).slice(0, 1500)}`;
    }

    return JSON.stringify(result).slice(0, 1000);
  }

  // Stream raw completions from local llama-server
  queryLLMStream({ messages, temperature = 0.2, maxTokens = 1200, onChunk = null }) {
    return new Promise((resolve) => {
      let fullContent = '';
      let isDone = false;

      const payload = JSON.stringify({
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true
      });

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 18910,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            console.error(`[queryLLMStream] Server returned HTTP ${res.statusCode}`);
            let errBody = '';
            res.on('data', c => errBody += c.toString());
            res.on('end', () => {
              if (!isDone) {
                isDone = true;
                resolve(fullContent || 'Inference server error.');
              }
            });
            return;
          }

          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                if (!isDone) {
                  isDone = true;
                  return resolve(fullContent.trim());
                }
                return;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  fullContent += delta;
                  if (onChunk) onChunk(delta, fullContent);

                  // If a complete, balanced tool call was emitted, stop the step immediately so the tool can execute!
                  const hasToolTag = fullContent.includes('</tool_call>');
                  const completeJson = this.extractFirstJsonObject(fullContent);
                  const hasToolKey = completeJson && (completeJson.includes('"name"') || completeJson.includes('"function"') || completeJson.includes('"tool"') || completeJson.includes('"action"'));
                  if (hasToolTag || hasToolKey) {
                    if (!isDone) {
                      isDone = true;
                      try { req.destroy(); } catch {}
                      return resolve(fullContent.trim());
                    }
                  }
                }
              } catch {}
            }
          });

          res.on('end', () => {
            if (!isDone) {
              isDone = true;
              resolve(fullContent.trim());
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[queryLLMStream] HTTP error:', err.message);
        if (!isDone) {
          isDone = true;
          resolve(fullContent.trim() || 'Failed to connect to local LLM.');
        }
      });

      req.setTimeout(180000, () => {
        if (!isDone) {
          isDone = true;
          try { req.destroy(); } catch {}
          resolve(fullContent.trim() || 'LLM step timed out.');
        }
      });

      req.write(payload);
      req.end();
    });
  }

  // Autonomous Cognitive ReAct Loop (LLM drives all tool decisions, multi-step queries & thinking cards)
  async runAutonomousCognitiveLoop(userPrompt, history = [], options = {}, notify = () => {}, extraContext = {}) {
    await this.ensureLlamaReady(12000);
    const startTime = Date.now();
    const maxSteps = options.maxSteps || 5;
    const scratchpad = []; // Array of { step, thought, toolCall, observation }
    let finalAnswer = '';
    let totalThinking = '';
    const userName = (this.memory && this.memory.getProfile()?.name) || 'User';
    const memoryCtx = this.memory ? this.memory.getSystemPromptContext() : '';
    const tasteSnippet = extraContext.tasteContent ? extraContext.tasteContent.slice(0, 1000) : '';
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const todayDateOnly = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;

    const systemPrompt = `You are Bionic-GPT, an elite autonomous personal AI assistant and engineering copilot for ${userName}.
You possess general intelligence, software architecture mastery, and sovereign autonomous reasoning capabilities.

Current Date & Time: ${todayStr} (System Clock Date: ${todayDateOnly})
${memoryCtx}
${tasteSnippet ? `## USER CODING TASTE & PREFERENCES:\n${tasteSnippet}` : ''}
${extraContext.vectorContext ? `## EPISODIC & SEMANTIC MEMORY VAULT:\n${extraContext.vectorContext}` : ''}
${extraContext.graphContext ? `## KNOWLEDGE GRAPH CONTEXT:\n${extraContext.graphContext}` : ''}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "tinyfish_search", "description": "Real-time live web search for current events, news, sports scores, player stats, documentation, and live data.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Clean, targeted search query with current date or target entity"}}, "required": ["query"]}}}
{"type": "function", "function": {"name": "tinyfish_fetch", "description": "Extracts full text and content from a specific web URL or article discovered during search.", "parameters": {"type": "object", "properties": {"url": {"type": "string", "description": "The URL to fetch"}}, "required": ["url"]}}}
{"type": "function", "function": {"name": "search_github", "description": "Queries GitHub REST API for official repositories, star counts, descriptions, and code links.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "The repository name or search term"}}, "required": ["query"]}}}
{"type": "function", "function": {"name": "read_file", "description": "Reads local files from workspace or memory.", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "Path to file"}}, "required": ["path"]}}}
{"type": "function", "function": {"name": "search_memory", "description": "Semantic search across vector DB and episodic memory.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Search query for past memory"}}, "required": ["query"]}}}
</tools>

For each function call, return your cognitive reasoning in <thought>...</thought> followed by a json object within <tool_call></tool_call> XML tags:
<thought>
Reasoning explaining what information is needed, how the current date (${todayDateOnly}) is incorporated, how pronouns or entities are resolved, and why this tool and query were chosen.
</thought>
<tool_call>
{"name": "<function-name>", "arguments": <args-json-object>}
</tool_call>

When you have enough context to answer comprehensively and accurately, output your final reasoning in <thought>...</thought> followed by:
<final_answer>
Your complete, smart, personalized markdown answer.
</final_answer>

CRITICAL DIRECTIVES:
- REAL-TIME LIVE GROUNDING: You have live real-time internet access via \`tinyfish_search\`. You MUST NEVER say "as an AI I don't have real-time access" or "I cannot browse the internet". If the user asks for scores, matches, dates, news, current facts, releases, or documentation, you MUST call \`tinyfish_search\`!
- MANDATORY CURRENT DATE ANCHORING FOR FACTS:
  * BEFORE SEARCHING ANY FACT, NEWS, MATCH, SCORE, STAT, OR EVENT, you MUST ALWAYS check and use the CURRENT DATE (${todayDateOnly}) or the exact date explicitly requested by the user.
  * NEVER use relative temporal words like "today", "yesterday", "tomorrow", "tonight", "recent", or "latest" alone in search queries! Web search engines cannot interpret relative temporal words and will return outdated historical articles.
  * ALWAYS resolve and insert the explicit CURRENT DATE (${todayDateOnly}) in your search query arguments (e.g. "<topic> ${todayDateOnly}" or "<entity> score ${todayDateOnly}").
- FACT SEARCH & SPORTS/EVENTS DISAMBIGUATION:
  * When the user asks for scores, matches, or "how much he/they scored", search for the primary headline fixture/match for the CURRENT DATE (${todayDateOnly}) first.
  * If a past domestic player or entity is mentioned in earlier conversation turns but has no match recorded for the queried date, do NOT assume they played or invent a score. Check and report the actual marquee match and scores of the day.
  * Verified live search ground truth ALWAYS supersedes past episodic memory. Never use outdated months or years from past conversations when answering a query for the current date.
- QUERY DIVERSIFICATION: In Step 2+, NEVER repeat an identical search query. If a search yielded dated or insufficient results, broaden or reformulate the query with different keywords.
- You can make multiple tool calls across iterations until you have sufficient verified facts.
- If the user asks for code, use \`\`\`<language> file="<filename>" format.`;

    let step = 1;
    while (step <= maxSteps) {
      const messages = [{ role: 'system', content: systemPrompt }];

      // Include conversation history
      if (Array.isArray(history) && history.length > 0) {
        for (const m of history.slice(-6)) {
          if (m && m.content) {
            messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
          }
        }
      }

      // Add user prompt
      messages.push({ role: 'user', content: userPrompt });

      // Add scratchpad of previous steps in this run as Assistant <tool_call> and User <tool_response>
      if (scratchpad.length > 0) {
        for (const s of scratchpad) {
          if (s.toolCall) {
            messages.push({
              role: 'assistant',
              content: `<thought>\n${s.thought}\n</thought>\n<tool_call>\n${JSON.stringify(s.toolCall)}\n</tool_call>`
            });
            messages.push({
              role: 'user',
              content: `<tool_response>\n${s.observation}\n</tool_response>\n\nBased on these verified observations, continue reasoning. If you need more information, output another <tool_call>. If you have enough context, synthesize your response in <final_answer>.`
            });
          }
        }
      }

      notify('THINKING_START', { stepIndex: step, title: `Step ${step}: Cognitive Reasoning` });

      let rawStepText = '';
      let isFinalAnswerStreaming = false;

      rawStepText = await this.queryLLMStream({
        messages,
        temperature: 0.2,
        maxTokens: 1200,
        onChunk: (delta) => {
          rawStepText += delta;
          if (rawStepText.includes('<final_answer>')) {
            if (!isFinalAnswerStreaming) {
              isFinalAnswerStreaming = true;
              notify('THINKING_FINISH', { durationMs: Date.now() - startTime });
            }
            const afterTag = rawStepText.split('<final_answer>')[1] || '';
            const cleanFinalDelta = afterTag.replace(/<\/final_answer>[\s\S]*$/i, '');
            notify('TEXT_MESSAGE_CHUNK', { delta, fullText: cleanFinalDelta });
          } else if (rawStepText.includes('<tool_call>')) {
            // Once <tool_call> appears, reasoning is done for this step
          } else {
            const cleanDelta = delta.replace(/<\/?thought>/gi, '');
            if (cleanDelta) {
              notify('THINKING_CHUNK', { delta: cleanDelta });
            }
          }
        }
      });

      console.log(`[AutonomousLoop Step ${step} Output]:`, rawStepText);

      const parsed = this.parseAgentOutput(rawStepText);
      const stepThought = parsed.thought || (parsed.toolCall ? `Analyzing intent and querying ${parsed.toolCall.action || parsed.toolCall.tool}...` : 'Synthesizing response.');
      totalThinking += (totalThinking ? '\n\n' : '') + `[Step ${step}]\n${stepThought}`;

      if (parsed.toolCall) {
        notify('THINKING_FINISH', { durationMs: Date.now() - startTime });
        notify('REASONING_STEP', {
          stepIndex: step,
          thought: stepThought,
          title: `Step ${step}: Cognitive Reasoning & Query Formulation`
        });

        const callId = `call_${Date.now()}_${step}`;
        const normalizedTool = parsed.toolCall.tool;
        const normalizedAction = parsed.toolCall.action;
        const normalizedArgs = parsed.toolCall.args;

        notify('TOOL_CALL_START', {
          callId,
          tool: normalizedTool,
          action: normalizedAction,
          args: normalizedArgs,
          stepIndex: step,
          totalSteps: maxSteps
        });

        const { result, artifactPath } = await this.executeSingleTool(
          normalizedTool,
          normalizedAction,
          normalizedArgs,
          `run_${Date.now()}`,
          callId
        );

        notify('TOOL_CALL_RESULT', {
          callId,
          tool: normalizedTool,
          action: normalizedAction,
          result,
          stepIndex: step,
          totalSteps: maxSteps,
          artifactPath
        });

        const observation = this.formatObservation(normalizedAction, result);

        scratchpad.push({
          step,
          thought: stepThought,
          toolCall: parsed.toolCall,
          observation
        });

        step++;
        continue;
      }

      finalAnswer = parsed.finalAnswer;
      break;
    }

    if ((!finalAnswer || finalAnswer.length < 15) && scratchpad.length > 0) {
      finalAnswer = await this.chatWithLLM(
        userPrompt,
        scratchpad.map(s => `[Step ${s.step}]: ${s.observation}`).join('\n\n'),
        history,
        (evt, data) => notify(evt, data),
        extraContext
      );
    }

    const cleanedFinalAnswer = (finalAnswer || 'Completed processing your request.')
      .replace(/<final_answer>[\s\S]*?$/i, (m) => m.replace(/<final_answer>/i, ''))
      .replace(/<\/final_answer>/gi, '')
      .replace(/<final_answer>/gi, '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .trim();

    return {
      finalAnswer: cleanedFinalAnswer,
      totalThinking,
      scratchpad
    };
  }

  // Qwen 2.5 Coder 3B multi-step reasoning & tool planner
  async planWithLLM(userPrompt) {
    const memoryCtx = this.memory ? this.memory.getSystemPromptContext() : '';
    const skillsCtx = this.skills ? this.skills.getPromptContext() : '';

    const systemPrompt = `You are Bionic-GPT, an elite autonomous reasoning agent and engineering copilot capable of executing multi-step workflows.
${memoryCtx}
${skillsCtx}

Available tools:
- system_control.play_music { query }
- system_control.launch_app { app }
- web_research.search_github { query }
- web_research.platform_search { platform, query }
- web_research.search_web { query }
- web_research.open_url { url, label }
- office_tools.read_clipboard {}
- office_tools.compose_email { recipient, topic }
- code_sandbox.execute_js { code }

INSTRUCTIONS:
1. If the request requires tools or actions, output the steps in 'steps'.
2. If the request is a general question, chat, explanation, code question, or conversational message, return steps: [] and provide a comprehensive answer in 'response'.
3. Always provide a brief chain-of-thought in 'thought'.

Output JSON format:
{
  "thought": "Reasoning...",
  "steps": [],
  "response": "Detailed answer..."
}`;

    const payload = JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 500
    });

    return new Promise((resolve) => {
      // 120-second safety timeout for local LLM multi-step reasoning
      const timer = setTimeout(() => {
        resolve(null);
      }, 120000);

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 18910,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          }
        },
        (res) => {
          let data = '';
          res.on('data', c => (data += c));
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const json = JSON.parse(data);
              let raw = json.choices[0].message.content.trim();
              raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

              const firstBrace = raw.indexOf('{');
              const lastBrace = raw.lastIndexOf('}');
              if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                const jsonStr = raw.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(jsonStr);
                if (parsed) return resolve(parsed);
              }
            } catch {}
            resolve(null);
          });
        }
      );

      req.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  }

  // Single tool execution core
  async executeSingleTool(toolName, actionName, args, runId, callId) {
    let result = null;
    let artifactPath = null;
    const action = actionName || (toolName ? toolName.split('.').pop().toUpperCase() : 'UNKNOWN');

    if (action === 'TINYFISH_SEARCH' || toolName === 'web_research.tinyfish_search') {
      let searchQuery = (args.query || args.q || '').trim();
      // Replace relative time words with explicit current date
      const now = new Date();
      const defaultDateStr = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
      if (/\btoday\b/i.test(searchQuery)) {
        searchQuery = searchQuery.replace(/\btoday\b/gi, defaultDateStr);
      }
      if (/\byesterday\b/i.test(searchQuery)) {
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yDateStr = `${yesterday.getDate()} ${yesterday.toLocaleString('en-US', { month: 'long' })} ${yesterday.getFullYear()}`;
        searchQuery = searchQuery.replace(/\byesterday\b/gi, yDateStr);
      }
      if (/\btomorrow\b/i.test(searchQuery)) {
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tDateStr = `${tomorrow.getDate()} ${tomorrow.toLocaleString('en-US', { month: 'long' })} ${tomorrow.getFullYear()}`;
        searchQuery = searchQuery.replace(/\btomorrow\b/gi, tDateStr);
      }
      if (/\btonight\b/i.test(searchQuery)) {
        searchQuery = searchQuery.replace(/\btonight\b/gi, `${defaultDateStr} evening`);
      }
      searchQuery = searchQuery.replace(/^(?:search for|find|look up|check|query)\s+/i, '').replace(/\s+/g, ' ').trim();
      result = await this.gateway.searchTinyFish(searchQuery);
      artifactPath = `/artifacts/tinyfish_search_${Date.now()}.json`;
      if (this.vfs) {
        this.vfs.writeJson(artifactPath, {
          type: 'tinyfish_search_results',
          query: searchQuery,
          items: result.items || [],
          retrievedAt: new Date().toISOString()
        });
      }
    } else if (action === 'TINYFISH_FETCH' || toolName === 'web_research.tinyfish_fetch') {
      result = await this.gateway.fetchTinyFish(args.url);
      artifactPath = `/artifacts/tinyfish_fetch_${Date.now()}.json`;
      if (this.vfs) {
        this.vfs.writeJson(artifactPath, {
          type: 'tinyfish_fetch_result',
          url: args.url,
          title: result.title,
          text: result.text,
          retrievedAt: new Date().toISOString()
        });
      }
    } else if (action === 'READ_SKILL' || toolName === 'skill_runtime.read_skill') {
      const skillName = args.skill || 'tinyfish_web_agent';
      const skillObj = this.skills ? this.skills.getSkill(skillName) : null;
      result = {
        success: true,
        skill: skillName,
        name: skillObj ? skillObj.name : skillName,
        description: skillObj ? skillObj.description : 'Web Agent with real-time search & scraping',
        operations: skillObj ? skillObj.operations.map(o => o.name) : ['tinyfish_search', 'tinyfish_fetch'],
        type: 'SKILL_LOADED'
      };
    } else if (action === 'READ_FILE' || toolName === 'vfs.read_file') {
      const filePath = args.path || args.file || '/memory.md';
      let content = '';
      try { content = this.vfs ? (this.vfs.readFile(filePath) || '') : ''; } catch {}
      result = {
        success: true,
        path: filePath,
        content: content.slice(0, 500),
        size: content.length,
        type: 'FILE_READ'
      };
    } else if (action === 'OPEN_URL' || toolName === 'web_research.open_url') {
      result = this.gateway.openUrl(args.url, args.label);
    } else if (action === 'GITHUB_SEARCH' || toolName === 'web_research.search_github') {
      result = await this.gateway.searchGitHub(args.query);

      // Persist durable artifact in VFS /artifacts/
      artifactPath = `/artifacts/github_${Date.now()}.json`;
      this.vfs.writeJson(artifactPath, {
        type: 'github_search_dataset',
        query: args.query,
        total_count: result.total_count,
        items: result.items,
        retrievedAt: new Date().toISOString()
      });
    } else if (action === 'WEB_PAGE_FETCHED' || toolName === 'web_research.fetch_web_data') {
      result = await this.gateway.fetchWebPage(args.url);

      artifactPath = `/artifacts/web_${Date.now()}.json`;
      this.vfs.writeJson(artifactPath, {
        type: 'web_scrape_dataset',
        url: args.url,
        title: result.title,
        text: result.text,
        retrievedAt: new Date().toISOString()
      });
    } else if (action === 'PLAY_MUSIC' || toolName === 'system_control.play_music') {
      result = this.gateway.playSpotify(args.query);
    } else if (action === 'OPEN_APP' || action === 'RESOLVE_AND_OPEN' || toolName === 'system_control.launch_app') {
      const targetParam = args.target || args.app;
      result = await this.gateway.launchApp(targetParam);
      if (result && result.type === 'URL_OPENED') {
        artifactPath = `/artifacts/domain_resolved_${Date.now()}.json`;
        if (this.vfs) {
          this.vfs.writeJson(artifactPath, {
            type: 'domain_resolution',
            target: targetParam,
            url: result.url,
            title: result.title,
            domain: result.domain,
            source: result.source,
            provider: result.provider,
            retrievedAt: new Date().toISOString()
          });
        }
      }
    } else if (action === 'WEB_SEARCH' || toolName === 'web_research.search_web') {
      result = await this.gateway.executeWebSearch(args.query);
      artifactPath = `/artifacts/web_search_${Date.now()}.json`;
      this.vfs.writeJson(artifactPath, {
        type: 'web_search_results',
        query: args.query,
        items: result.items || [],
        retrievedAt: new Date().toISOString()
      });
    } else if (action === 'PLATFORM_SEARCH' || toolName === 'web_research.platform_search') {
      result = this.gateway.openWebSearch(args.platform, args.query);
    } else if (action === 'READ_CLIPBOARD' || toolName === 'office_tools.read_clipboard') {
      let clipText = '';
      try { clipText = this.clipboard ? this.clipboard.readText() : ''; } catch {}
      result = { success: true, text: clipText, type: 'CLIPBOARD_READ' };
    } else if (action === 'COMPOSE_EMAIL' || toolName === 'office_tools.compose_email') {
      const draft = await this.composeEmail(args.recipient, args.topic);
      
      // Autonomous live UI action: Launch Gmail web composer directly in browser with all fields pre-filled!
      const composerResult = this.gateway.launchEmailComposer(
        draft.contact ? draft.contact.email : args.recipient,
        draft.subject,
        draft.body
      );

      result = {
        success: true,
        type: 'COMPOSE_EMAIL',
        ...draft,
        composerLaunched: true,
        gmailUrl: composerResult.gmailUrl
      };

      // Set clipboard as well for seamless pasting
      if (this.clipboard && draft.body) {
        try { this.clipboard.writeText(draft.body); } catch {}
      }

      // Persist durable artifact in VFS /artifacts/
      artifactPath = `/artifacts/email_${Date.now()}.json`;
      this.vfs.writeJson(artifactPath, {
        type: 'email_draft',
        recipient: draft.contact ? draft.contact.name : args.recipient,
        email: draft.contact ? draft.contact.email : null,
        subject: draft.subject,
        body: draft.body,
        mailto: draft.mailto,
        gmailUrl: composerResult.gmailUrl,
        createdAt: new Date().toISOString()
      });
    } else if (toolName === 'code_sandbox.execute_js') {
      result = this.gateway.executeSandboxedJs(args.code);
    } else if (toolName.startsWith('mcp.') || toolName.startsWith('rea.')) {
      // Dispatches to dynamic MCP tool runtime
      let srv = 'rea';
      let tName = toolName;
      if (toolName.startsWith('mcp.')) {
        const parts = toolName.slice(4).split('.');
        srv = parts[0];
        tName = parts.slice(1).join('.');
      } else if (toolName.startsWith('rea.')) {
        srv = 'rea';
        tName = toolName.slice(4);
      }
      if (this.skills && typeof this.skills.executeMcpTool === 'function') {
        result = await this.skills.executeMcpTool(srv, tName, args);
      } else {
        result = { success: true, server: srv, tool: tName, args };
      }
    } else if (toolName.startsWith('connector.') || action === 'CONNECTOR_EXEC') {
      // Dispatches to extensible Connectors subsystem
      const connName = toolName.startsWith('connector.') ? toolName.split('.')[1] : (args.connector || 'git');
      const connAction = args.action || 'status';
      if (this.gateway && typeof this.gateway.executeConnector === 'function') {
        result = await this.gateway.executeConnector(connName, connAction, args.params || args);
      } else {
        result = { success: true, connector: connName, action: connAction, args };
      }
    } else if (toolName === 'vfs.read_file' || action === 'READ_FILE') {
      const fPath = args.path || '/memory.md';
      let content = '';
      try { content = this.vfs ? (this.vfs.readFile(fPath) || '') : ''; } catch {}
      result = { success: true, path: fPath, content: content.slice(0, 4000), size: content.length };
    } else if (toolName === 'vfs.write_file' || action === 'WRITE_FILE') {
      const fPath = args.path;
      const content = args.content || '';
      let success = false;
      try {
        if (this.vfs && fPath) {
          this.vfs.writeFile(fPath, content);
          success = true;
        }
      } catch {}
      result = { success, path: fPath, size: content.length };
    } else if (toolName.startsWith('memory.')) {
      if (toolName === 'memory.read_taste') {
        result = { success: true, taste: this.memory.getTasteMd() };
      } else if (toolName === 'memory.read_profile') {
        result = { success: true, profile: this.memory.getProfileMd() };
      } else if (toolName === 'memory.update_taste') {
        const ok = this.memory.updateTasteMd(args.content);
        result = { success: ok, target: '/taste.md' };
      } else if (toolName === 'memory.update_profile') {
        const ok = this.memory.updateProfileMd(args.content);
        result = { success: ok, target: '/profile.md' };
      } else {
        result = { success: true, tool: toolName, args };
      }
    } else if (toolName.startsWith('code_editor.')) {
      if (toolName === 'code_editor.apply_diff') {
        if (this.diffEngine) {
          result = this.diffEngine.applyDiff(args.filePath, args.newContent);
          if (result.success && args.openInVSCode) {
            await this.diffEngine.openInVSCode(result.filePath);
          }
        } else {
          result = { success: false, error: 'Diff engine not initialized' };
        }
      } else if (toolName === 'code_editor.open_vscode') {
        if (this.diffEngine) {
          result = await this.diffEngine.openInVSCode(args.filePath || args.targetPath, args.line, args.column);
        } else {
          result = { success: false, error: 'Diff engine not initialized' };
        }
      } else if (toolName === 'code_editor.diff_vscode') {
        if (this.diffEngine) {
          result = await this.diffEngine.openDiffInVSCode(args.originalPath, args.modifiedPath);
        } else {
          result = { success: false, error: 'Diff engine not initialized' };
        }
      } else if (toolName === 'code_editor.revert_diff') {
        if (this.diffEngine) {
          result = this.diffEngine.revertBackup(args.filePath, args.backupPath);
        } else {
          result = { success: false, error: 'Diff engine not initialized' };
        }
      } else if (toolName === 'code_editor.run_checks') {
        if (this.diffEngine) {
          result = await this.diffEngine.runWorkspaceVerification(args.command, args.cwd);
        } else {
          result = { success: false, error: 'Diff engine not initialized' };
        }
      } else if (toolName === 'code_editor.self_heal') {
        result = await this.executeSelfHealingLoop(args.filePath, args.newContent, args.command);
      } else {
        result = { success: true, tool: toolName, args };
      }
    } else {
      result = { success: true, tool: toolName, args };
    }

    return { result, artifactPath };
  }

  // Compose email with personal profile and relationship context
  async composeEmail(recipientQuery, topic) {
    const contact = this.memory.resolveContact(recipientQuery);
    const profile = this.memory.getProfile();

    const systemPrompt = `You are an email assistant for ${profile.name}.
Write a friendly, professional email.
Format:
Subject: <Subject>

Hi ${contact ? contact.name : recipientQuery},

<Body text>

${profile.signature || profile.name}`;

    const userPrompt = `Draft an email to ${contact ? contact.name : recipientQuery} about: ${topic || 'Quick check-in'}`;

    const payload = JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 250
    });

    return new Promise((resolve) => {
      const fallback = () => {
        const sub = topic || 'Quick Update';
        const body = `Hi ${contact ? contact.name : recipientQuery},\n\n${topic || 'I wanted to share a quick update.'}\n\n${profile.signature || profile.name}`;
        const mailto = `mailto:${encodeURIComponent(contact ? contact.email : '')}?subject=${encodeURIComponent(sub)}&body=${encodeURIComponent(body)}`;
        return { contact, subject: sub, body, mailto };
      };

      // 60-second safety timeout for local LLM email drafting
      const timer = setTimeout(() => resolve(fallback()), 60000);

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 18910,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Connection': 'close'
          }
        },
        (res) => {
          let data = '';
          res.on('data', c => (data += c));
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const json = JSON.parse(data);
              let text = json.choices[0].message.content.trim();
              text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

              let subject = topic || 'Quick Update';
              let body = text;

              if (/^Subject:\s*/i.test(text)) {
                const lines = text.split('\n');
                subject = lines[0].replace(/^Subject:\s*/i, '').trim();
                body = lines.slice(1).join('\n').trim();
              }

              if (!body) {
                body = `Hi ${contact ? contact.name : recipientQuery},\n\n${topic || 'I wanted to follow up.'}\n\n${profile.signature || profile.name}`;
              }

              const mailto = `mailto:${encodeURIComponent(contact ? contact.email : '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
              return resolve({ contact, subject, body, mailto });
            } catch {}
            resolve(fallback());
          });
        }
      );

      req.on('error', () => {
        clearTimeout(timer);
        resolve(fallback());
      });

      req.write(payload);
      req.end();
    });
  }

  // Autonomous Workspace Code Self-Healing Loop
  async executeSelfHealingLoop(filePath, initialContent, checkCommand = null, maxIterations = 3) {
    if (!this.diffEngine) return { success: false, error: 'Diff engine not initialized' };

    const applyRes = this.diffEngine.applyDiff(filePath, initialContent);
    if (!applyRes.success) return applyRes;

    let currentContent = initialContent;
    let iteration = 1;
    const history = [];

    while (iteration <= maxIterations) {
      const checkRes = await this.diffEngine.runWorkspaceVerification(checkCommand);
      history.push({
        iteration,
        passed: checkRes.passed,
        command: checkRes.command,
        stdout: checkRes.stdout,
        stderr: checkRes.stderr
      });

      if (checkRes.passed) {
        return {
          success: true,
          selfHealed: iteration > 1,
          iterations: iteration,
          filePath,
          command: checkRes.command,
          message: iteration === 1 ? 'Changes applied and verified cleanly' : `Autonomous self-healing succeeded after ${iteration} iterations!`,
          history
        };
      }

      // Check failed! Formulate diagnostic prompt for LLM self-correction
      const errorMsg = checkRes.stderr || checkRes.stdout;
      const healPrompt = `The code change applied to "${filePath}" failed the test command "${checkRes.command}" with the following error:
\`\`\`
${errorMsg.slice(0, 1500)}
\`\`\`
Here is the current content of ${filePath}:
\`\`\`
${currentContent.slice(0, 3000)}
\`\`\`
Please analyze the error and provide the complete fixed version of the file inside a code block.`;

      const healedResponse = await this.chatWithLLM(healPrompt, null, []);
      const parsedFix = this.diffEngine.parseDiffFromModelOutput(healedResponse, filePath);

      if (parsedFix && parsedFix.newContent && parsedFix.newContent !== currentContent) {
        currentContent = parsedFix.newContent;
        this.diffEngine.applyDiff(filePath, currentContent);
        iteration++;
      } else {
        break;
      }
    }

    return {
      success: false,
      selfHealed: false,
      iterations: iteration,
      filePath,
      error: 'Self-healing reached maximum attempts or could not resolve compiler error',
      history
    };
  }

  // Multi-Step Workflow Execution Loop (Emits full AG-UI protocol events)
  async executeMultiStep(userPrompt, optionsOrCb = null, eventCallback = null) {
    let options = {};
    if (typeof optionsOrCb === 'function') {
      eventCallback = optionsOrCb;
      options = {};
    } else if (optionsOrCb && typeof optionsOrCb === 'object') {
      options = optionsOrCb;
      if (!eventCallback && typeof options.onProgress === 'function') {
        eventCallback = options.onProgress;
      }
    }

    const runId = `run_${Date.now()}`;
    const startTime = Date.now();
    const deepThinking = options.deepThinking !== false; // default true
    const webGrounding = options.webGrounding !== false; // default true
    const tinyFish = options.tinyFish !== false; // default true

    // Retrieve active conversation history from UI options, or fallback to today's recent session turns
    const history = Array.isArray(options.history) && options.history.length > 0
      ? options.history
      : (this.memory ? this.memory.getRecentChatHistory(6).map(t => [
          { role: 'user', content: t.user },
          { role: 'assistant', content: t.response }
        ]).flat().filter(m => m && m.content) : []);

    const notify = (evt, payload) => {
      if (this.agui) this.agui.emitEvent(evt, { runId, ...payload });
      if (eventCallback) eventCallback(evt, { runId, ...payload });
    };

    notify('RUN_STARTED', { prompt: userPrompt, options: { deepThinking, webGrounding, tinyFish } });

    // Step 1: Check composite multi-step prompt (e.g. "play starboy and open calculator")
    const compositeSteps = this.decomposeCompositePrompt(userPrompt);
    if (compositeSteps && compositeSteps.length > 1) {
      notify('THINKING_START', { runId, prompt: userPrompt });
      notify('THINKING_CHUNK', {
        delta: `1. Analyzing multi-step request: "${userPrompt}"\n2. Decomposed into ${compositeSteps.length} sequential operations.\n3. Executing pipeline live...\n`
      });
      notify('THINKING_FINISH', { durationMs: 35, fullThinking: `Composite pipeline of ${compositeSteps.length} operations.` });

      notify('REASONING_MESSAGE', { thought: `Detected composite workflow with ${compositeSteps.length} operations.` });
      const executed = [];

      for (let i = 0; i < compositeSteps.length; i++) {
        const step = compositeSteps[i];
        const callId = `call_${Date.now()}_${i}`;
        notify('TOOL_CALL_START', {
          callId,
          tool: step.tool,
          action: step.action,
          args: step.args,
          stepIndex: i + 1,
          totalSteps: compositeSteps.length
        });

        const { result, artifactPath } = await this.executeSingleTool(step.tool, step.action, step.args, runId, callId);
        notify('TOOL_CALL_RESULT', {
          callId,
          tool: step.tool,
          action: step.action,
          result,
          stepIndex: i + 1,
          totalSteps: compositeSteps.length,
          artifactPath
        });

        executed.push({ tool: step.tool, action: step.action, result, artifactPath });
      }

      const duration = Date.now() - startTime;
      let summary = `Completed multi-step workflow (${executed.length} steps).`;
      const ghStep = executed.find(s => s.action === 'GITHUB_SEARCH' || s.tool === 'web_research.search_github');
      if (ghStep && ghStep.result && ghStep.result.items && ghStep.result.items.length > 0) {
        const top = ghStep.result.items[0];
        summary = `Retrieved ${ghStep.result.total_count} repositories from GitHub. Top repository: **${top.name}** (⭐ ${top.stars.toLocaleString()} stars) — "${top.description}".`;
      }
      const emailStep = executed.find(s => s.action === 'COMPOSE_EMAIL' || s.tool === 'office_tools.compose_email');
      if (emailStep && emailStep.result) {
        summary = `Drafted email to **${emailStep.result.contact ? emailStep.result.contact.name : 'recipient'}** and opened live composer in browser.`;
      }
      notify('TEXT_MESSAGE_CONTENT', { text: summary });
      notify('RUN_FINISHED', { summary, durationMs: duration, success: true });
      if (this.memory) this.memory.recordTurn(userPrompt, executed, summary);

      return {
        runId,
        thought: `Multi-step execution of ${executed.length} tools`,
        stepsExecuted: executed,
        finalResponse: summary,
        durationMs: duration
      };
    }

    // Step 2: Check fast single match (<0.5ms) for direct system shortcuts only (e.g. app launch, music play)
    let fast = this.fastMatch(userPrompt);
    // Any research action (TinyFish, Web Search, GitHub Search, File Read) must execute through the full agentic workflow!
    if (fast && ['TINYFISH_SEARCH', 'TINYFISH_FETCH', 'WEB_SEARCH', 'GITHUB_SEARCH', 'READ_FILE', 'READ_SKILL'].includes(fast.action)) {
      fast = null;
    }

    if (fast) {
      notify('THINKING_START', { runId, prompt: userPrompt });
      if (fast.action === 'RESOLVE_AND_OPEN') {
        notify('THINKING_CHUNK', {
          delta: `1. Analyzing request: "${userPrompt}"\n2. Extracted clean target: "${fast.args.target}"\n3. Inspecting local desktop apps & Windows PATH...\n4. Querying TinyFish web agent to discover verified official domain for "${fast.args.target}"...\n`
        });
      } else if (fast.action === 'TINYFISH_SEARCH') {
        notify('THINKING_CHUNK', {
          delta: `1. Analyzing query: "${userPrompt}"\n2. Activating TinyFish Real-Time Web Agent...\n3. Querying live web sources for ground truth...\n`
        });
      } else if (fast.action === 'WEB_SEARCH') {
        notify('THINKING_CHUNK', {
          delta: `1. Analyzing query: "${userPrompt}"\n2. Activating verified Web Search engine...\n3. Querying live web sources for ground truth...\n`
        });
      } else {
        notify('THINKING_CHUNK', {
          delta: `1. Analyzing user intent: "${userPrompt}"\n2. Matched autonomous action: ${fast.action}\n3. Executing live on system...\n`
        });
      }

      const callId = `call_${Date.now()}_0`;
      notify('REASONING_MESSAGE', { thought: `Fast path matched: ${fast.action}` });
      notify('TOOL_CALL_START', { callId, tool: fast.tool, action: fast.action, args: fast.args, stepIndex: 1, totalSteps: 1 });

      const { result, artifactPath } = await this.executeSingleTool(fast.tool, fast.action, fast.args, runId, callId);
      notify('TOOL_CALL_RESULT', { callId, tool: fast.tool, action: fast.action, result, stepIndex: 1, totalSteps: 1, artifactPath });

      if (fast.action === 'RESOLVE_AND_OPEN' && result && result.url) {
        notify('THINKING_CHUNK', {
          delta: `5. Discovered verified URL: ${result.url} (${result.title || result.domain})\n6. Opened live webpage in browser.\n`
        });
      }
      const isResearchAction = ['TINYFISH_SEARCH', 'TINYFISH_FETCH', 'WEB_SEARCH', 'GITHUB_SEARCH', 'READ_FILE', 'READ_SKILL'].includes(fast.action);
      if (isResearchAction) {
        let preloadedContext = '';
        if (result && result.items && result.items.length > 0) {
          preloadedContext = result.items.slice(0, 4).map((it, idx) => `[Source ${idx + 1}] ${it.title} (${it.url}): ${(it.snippet || '').slice(0, 160)}`).join('\n\n');
        } else if (result && result.text) {
          preloadedContext = `[Extracted Web Content] (${result.url}): ${result.text.slice(0, 2500)}`;
        } else if (result && result.content) {
          preloadedContext = `[File Content] (${result.path}): ${result.content.slice(0, 2000)}`;
        }

        // Proceed directly to deep thinking & grounded answer synthesis
        let thinkingText = '';
        if (deepThinking) {
          notify('THINKING_START', { title: 'Cognitive Reasoning Plan' });
          notify('THINKING_CHUNK', {
            delta: `• Grounded verified sources from ${fast.action}. Formulating cognitive reasoning plan...\n`
          });
          thinkingText = await this.streamThinkingTokens(userPrompt, preloadedContext, history, (evt, data) => notify(evt, data));
          notify('THINKING_FINISH', { durationMs: Date.now() - startTime, fullThinking: thinkingText });
        } else {
          notify('THINKING_FINISH', { durationMs: Date.now() - startTime, fullThinking: `Executed ${fast.action}.` });
        }

        const finalAnswer = await this.chatWithLLM(userPrompt, preloadedContext, history, (evt, data) => notify(evt, data));
        notify('TEXT_MESSAGE_CONTENT', { text: finalAnswer });
        notify('RUN_FINISHED', { summary: `Completed ${fast.action} with AI synthesis`, durationMs: Date.now() - startTime, success: true });
        if (this.memory) this.memory.recordTurn(userPrompt, result, finalAnswer);

        // Check if code was generated
        if (this.diffEngine) {
          try {
            const parsedDiff = this.diffEngine.parseDiffFromModelOutput(finalAnswer, null, userPrompt);
            if (parsedDiff && parsedDiff.hasDiff && parsedDiff.newContent && parsedDiff.filePath) {
              const applyRes = this.diffEngine.applyDiff(parsedDiff.filePath, parsedDiff.newContent);
              this.diffEngine.openInVSCode(applyRes.filePath || parsedDiff.filePath);
              notify('DIFF_ARTIFACT_GENERATED', {
                artifactId: `diff_${Date.now()}`,
                filePath: parsedDiff.filePath,
                resolvedPath: parsedDiff.resolvedPath,
                language: parsedDiff.language,
                originalContent: parsedDiff.originalContent,
                newContent: parsedDiff.newContent,
                diff: parsedDiff.diff,
                stats: {
                  additions: parsedDiff.diff.additions,
                  deletions: parsedDiff.diff.deletions,
                  totalChanges: parsedDiff.diff.totalChanges
                },
                applied: applyRes.success
              });
            }
          } catch {}
        }

        return {
          runId,
          thought: `Grounded execution of ${fast.action}`,
          stepsExecuted: [{ tool: fast.tool, action: fast.action, result, artifactPath }],
          finalResponse: finalAnswer,
          durationMs: Date.now() - startTime
        };
      }

      notify('THINKING_FINISH', { durationMs: Date.now() - startTime, fullThinking: `Direct intent match: ${fast.action}` });

      const duration = Date.now() - startTime;
      let summary = `Executed ${fast.action}.`;
      if (fast.action === 'COMPOSE_EMAIL' && result) {
        summary = `Drafted email to **${result.contact ? result.contact.name : fast.args.recipient}** and opened live composer in browser.`;
      } else if (fast.action === 'PLAY_MUSIC' && result) {
        summary = `Playing **${result.query}** on Spotify.`;
      } else if (result && (result.type === 'URL_OPENED' || result.url)) {
        const title = result.title || fast.args.label || fast.args.target || fast.args.app || 'Webpage';
        const domain = result.domain || (result.url ? new URL(result.url).hostname : '');
        summary = `Resolved official domain for **${title}**: [${domain}](${result.url}). Opened in default browser.`;
      } else if (fast.action === 'OPEN_VSCODE' && result) {
        summary = `Opened **${result.targetPath || 'workspace'}** live in VS Code.`;
      } else if (result && result.type === 'APP_LAUNCHED') {
        summary = `Launched **${result.appName || fast.args.label || fast.args.app}** locally on your laptop.`;
      }
      notify('TEXT_MESSAGE_CONTENT', { text: summary });
      notify('RUN_FINISHED', { summary, durationMs: duration, success: true });
      if (this.memory) this.memory.recordTurn(userPrompt, result, null);

      return {
        runId,
        thought: `Instant execution of ${fast.action}`,
        stepsExecuted: [{ tool: fast.tool, action: fast.action, result, artifactPath }],
        finalResponse: summary,
        durationMs: duration
      };
    }

    // Step 3: Web & Memory Grounded Deep Thinking Loop (Antigravity-inspired)
    // Default: searches web for live ground-truth context, queries Vector DB & Graph-RAG, streams pure text thinking tokens, and tailors the final response

    // 3a. Traversal of Knowledge Graph Memory (Graph-RAG)
    let graphContext = '';
    if (this.graphMemory) {
      const graphResult = this.graphMemory.queryGraph(userPrompt);
      if (graphResult && graphResult.relationships && graphResult.relationships.length > 0) {
        graphContext = graphResult.formattedContext;
        const graphCallId = `call_graph_${Date.now()}`;
        notify('TOOL_CALL_START', {
          callId: graphCallId,
          tool: 'memory_engine.graph_traversal',
          action: 'GRAPH_TRAVERSAL',
          args: { query: userPrompt, entities: graphResult.matchedEntities.map(e => e.label) },
          stepIndex: 1,
          totalSteps: 5
        });
        notify('TOOL_CALL_RESULT', {
          callId: graphCallId,
          tool: 'memory_engine.graph_traversal',
          action: 'GRAPH_TRAVERSAL',
          result: {
            entities: graphResult.matchedEntities,
            relationships: graphResult.relationships,
            count: graphResult.relationships.length
          },
          stepIndex: 1,
          totalSteps: 5
        });
      }
    }

    // 3b. Vector DB Semantic & Episodic Memory Search
    let vectorContext = '';
    if (this.vectorMemory) {
      const vectorMatches = this.vectorMemory.search(userPrompt, 3, 0.20);
      if (vectorMatches && vectorMatches.length > 0) {
        vectorContext = vectorMatches.map(m => `[Semantic Memory (${m.similarityPercent}% match)]: ${m.text}`).join('\n\n');
        const vecCallId = `call_vec_${Date.now()}`;
        notify('TOOL_CALL_START', {
          callId: vecCallId,
          tool: 'memory_engine.vector_search',
          action: 'VECTOR_SEARCH',
          args: { query: userPrompt, dimensions: this.vectorMemory.dimensions },
          stepIndex: 2,
          totalSteps: 5
        });
        notify('TOOL_CALL_RESULT', {
          callId: vecCallId,
          tool: 'memory_engine.vector_search',
          action: 'VECTOR_SEARCH',
          result: {
            matches: vectorMatches.map(m => ({ text: m.text.slice(0, 150), score: m.score, similarityPercent: m.similarityPercent, source: m.source })),
            topScore: vectorMatches[0].score,
            topSimilarity: vectorMatches[0].similarityPercent,
            count: vectorMatches.length
          },
          stepIndex: 2,
          totalSteps: 5
        });
      }
    }

    // 3c. Hybrid RAG Knowledge Retrieval over datasets and documents
    let ragContext = '';
    if (this.rag) {
      const ragChunks = this.rag.search(userPrompt, 3);
      if (ragChunks && ragChunks.length > 0) {
        ragContext = this.rag.formatContextEnvelope(ragChunks);
        const ragCallId = `call_rag_${Date.now()}`;
        notify('TOOL_CALL_START', {
          callId: ragCallId,
          tool: 'rag_engine.retrieve_documents',
          action: 'RAG_RETRIEVAL',
          args: { query: userPrompt, sources: Array.from(new Set(ragChunks.map(c => c.source))) },
          stepIndex: 3,
          totalSteps: 5
        });
        notify('TOOL_CALL_RESULT', {
          callId: ragCallId,
          tool: 'rag_engine.retrieve_documents',
          action: 'RAG_RETRIEVAL',
          result: {
            chunks: ragChunks.map(c => ({ source: c.source, score: typeof c.score === 'number' ? c.score.toFixed(2) : c.score, preview: (c.content || '').slice(0, 140) })),
            count: ragChunks.length
          },
          stepIndex: 3,
          totalSteps: 5
        });
      }
    }

    // 3d. Display all skills, MCPs, and personalized files read for agent context grounding
    const skillReadCallId = `call_skill_${Date.now()}`;
    const allSkills = this.skills ? this.skills.listSkills() : [];
    const mcpServers = this.skills ? this.skills.listMcpServers() : [];

    notify('TOOL_CALL_START', {
      callId: skillReadCallId,
      tool: 'skill_runtime.catalog',
      action: 'LOAD_SKILLS_AND_MCPS',
      args: {
        skillsCount: allSkills.length,
        mcpServersCount: mcpServers.length,
        skills: allSkills.map(s => s.name || s.id),
        mcpServers: mcpServers.map(m => m.name)
      },
      stepIndex: 4,
      totalSteps: 5
    });
    notify('TOOL_CALL_RESULT', {
      callId: skillReadCallId,
      tool: 'skill_runtime.catalog',
      action: 'LOAD_SKILLS_AND_MCPS',
      result: {
        skillsCount: allSkills.length,
        skills: allSkills.map(s => ({ name: s.name || s.id, source: s.source })),
        mcpServers: mcpServers.map(m => ({ name: m.name, toolsCount: m.toolsCount }))
      },
      stepIndex: 4,
      totalSteps: 5
    });

    // Read personalized taste.md and profile.md
    const fileReadCallId = `call_file_${Date.now()}`;
    notify('TOOL_CALL_START', {
      callId: fileReadCallId,
      tool: 'vfs.read_file',
      action: 'READ_FILE',
      args: { path: '/taste.md' },
      stepIndex: 5,
      totalSteps: 5
    });
    let tasteContent = '';
    let profileContent = '';
    try {
      tasteContent = this.memory ? this.memory.getTasteMd() : (this.vfs ? this.vfs.readFile('/taste.md') : '');
      profileContent = this.memory ? this.memory.getProfileMd() : (this.vfs ? this.vfs.readFile('/profile.md') : '');
    } catch {}
    notify('TOOL_CALL_RESULT', {
      callId: fileReadCallId,
      tool: 'vfs.read_file',
      action: 'READ_FILE',
      result: {
        path: '/taste.md & /profile.md',
        tasteSize: tasteContent.length,
        profileSize: profileContent.length,
        snippet: (tasteContent || '# Developer Coding Taste').slice(0, 160)
      },
      stepIndex: 5,
      totalSteps: 5
    });

    // 3e. Autonomous Cognitive ReAct Loop driven completely by LLM tool decisions & multi-step thinking
    const loopResult = await this.runAutonomousCognitiveLoop(
      userPrompt,
      history,
      { deepThinking, webGrounding, tinyFish, maxSteps: 5 },
      (evt, data) => notify(evt, data),
      { graphContext, vectorContext, ragContext, tasteContent, profileContent }
    );

    const finalAnswer = loopResult.finalAnswer;
    const thinkingText = loopResult.totalThinking;
    const duration = Date.now() - startTime;

    notify('TEXT_MESSAGE_CONTENT', { text: finalAnswer });
    notify('RUN_FINISHED', { summary: 'Completed autonomous cognitive workflow', durationMs: duration, success: true });

    // Format executed steps from autonomous scratchpad
    const executedSteps = (loopResult.scratchpad || []).map(s => ({
      tool: s.toolCall ? s.toolCall.tool : 'web_research.tinyfish_search',
      action: s.toolCall ? s.toolCall.action : 'TINYFISH_SEARCH',
      result: s.observation
    }));

    // Core Personalized Memory Update Reflection
    const reflection = this.memory ? this.memory.recordTurn(userPrompt, executedSteps, finalAnswer) : null;
    if (reflection && reflection.learned) {
      notify('LEARNED_PREFERENCE', {
        type: reflection.type,
        category: reflection.category,
        item: reflection.item,
        targetFile: reflection.targetFile,
        timestamp: new Date().toISOString()
      });
    }

    // Autonomous Interactive Code Diff Artifact Generation & Live VS Code Integration
    let diffArtifact = null;

    if (this.diffEngine) {
      try {
        const parsedDiff = this.diffEngine.parseDiffFromModelOutput(finalAnswer, null, userPrompt);
        if (parsedDiff && parsedDiff.hasDiff && parsedDiff.newContent && parsedDiff.filePath) {
          diffArtifact = {
            artifactId: `diff_${Date.now()}`,
            filePath: parsedDiff.filePath,
            resolvedPath: parsedDiff.resolvedPath,
            language: parsedDiff.language,
            originalContent: parsedDiff.originalContent,
            newContent: parsedDiff.newContent,
            diff: parsedDiff.diff,
            stats: {
              additions: parsedDiff.diff.additions,
              deletions: parsedDiff.diff.deletions,
              totalChanges: parsedDiff.diff.totalChanges
            },
            timestamp: new Date().toISOString()
          };

          const isCodeAction = /(?:write|create|make|save|code|script|hello|run|exec|vs\s*code|vscode|file)/i.test(userPrompt) || parsedDiff.hasDiff;
          const isVSCodeRequested = true;
          const isRunRequested = /(?:run|execute|exec|test)/i.test(userPrompt);

          if (isCodeAction) {
            // 1. Physically apply the diff and write the file live to workspace!
            const applyCallId = `call_diff_apply_${Date.now()}`;
            notify('TOOL_CALL_START', {
              callId: applyCallId,
              tool: 'code_editor.apply_diff',
              action: 'APPLY_DIFF',
              args: { filePath: parsedDiff.filePath, lines: parsedDiff.newContent.split('\n').length },
              stepIndex: 1,
              totalSteps: isVSCodeRequested ? 2 : 1
            });

            const applyRes = this.diffEngine.applyDiff(parsedDiff.filePath, parsedDiff.newContent);
            diffArtifact.applied = applyRes.success;
            diffArtifact.backupPath = applyRes.backupPath;

            notify('TOOL_CALL_RESULT', {
              callId: applyCallId,
              tool: 'code_editor.apply_diff',
              action: 'APPLY_DIFF',
              result: applyRes,
              stepIndex: 1,
              totalSteps: isVSCodeRequested ? 2 : 1
            });
            executedSteps.push({ tool: 'code_editor.apply_diff', action: 'APPLY_DIFF', result: applyRes });

            // 2. Open live in VS Code!
            if (isVSCodeRequested && applyRes.success) {
              const vscodeCallId = `call_vscode_${Date.now()}`;
              notify('TOOL_CALL_START', {
                callId: vscodeCallId,
                tool: 'code_editor.open_vscode',
                action: 'OPEN_VSCODE',
                args: { filePath: applyRes.filePath || parsedDiff.filePath },
                stepIndex: 2,
                totalSteps: isRunRequested ? 3 : 2
              });

              const vscodeRes = await this.diffEngine.openInVSCode(applyRes.filePath || parsedDiff.filePath);
              diffArtifact.openedInVSCode = vscodeRes.success;

              notify('TOOL_CALL_RESULT', {
                callId: vscodeCallId,
                tool: 'code_editor.open_vscode',
                action: 'OPEN_VSCODE',
                result: vscodeRes,
                stepIndex: 2,
                totalSteps: isRunRequested ? 3 : 2
              });
              executedSteps.push({ tool: 'code_editor.open_vscode', action: 'OPEN_VSCODE', result: vscodeRes });

              // 3. If run requested, execute code!
              if (isRunRequested) {
                const runCallId = `call_run_${Date.now()}`;
                let runCmd = null;
                const ext = path.extname(parsedDiff.filePath).toLowerCase();
                if (ext === '.py') runCmd = `python "${applyRes.filePath}"`;
                else if (ext === '.js') runCmd = `node "${applyRes.filePath}"`;
                else if (ext === '.ps1') runCmd = `powershell -ExecutionPolicy Bypass -File "${applyRes.filePath}"`;

                if (runCmd) {
                  notify('TOOL_CALL_START', {
                    callId: runCallId,
                    tool: 'code_editor.run_checks',
                    action: 'RUN_CHECKS',
                    args: { command: runCmd, filePath: parsedDiff.filePath },
                    stepIndex: 3,
                    totalSteps: 3
                  });
                  const runRes = await this.diffEngine.runWorkspaceVerification(runCmd);
                  notify('TOOL_CALL_RESULT', {
                    callId: runCallId,
                    tool: 'code_editor.run_checks',
                    action: 'RUN_CHECKS',
                    result: runRes,
                    stepIndex: 3,
                    totalSteps: 3
                  });
                  executedSteps.push({ tool: 'code_editor.run_checks', action: 'RUN_CHECKS', result: runRes });
                }
              }
            }
          }

          if (this.vfs) {
            this.vfs.writeJson(`/artifacts/${diffArtifact.artifactId}.json`, diffArtifact);
          }

          notify('DIFF_ARTIFACT_GENERATED', diffArtifact);
        }
      } catch (err) {
        console.warn('[AgentHarness] Error generating diff artifact:', err.message);
      }
    }

    return {
      runId,
      thought: thinkingText,
      stepsExecuted: executedSteps,
      finalResponse: finalAnswer,
      diffArtifact,
      durationMs: duration
    };
  }

  // Backward compatibility single-turn execute
  async execute(userPrompt) {
    return this.executeMultiStep(userPrompt);
  }
}

module.exports = BionicAgentHarness;
