/**
 * Bionic-GPT Sandbox Gateway & Policy Gate
 * Implements execution boundaries, SSRF prevention, audit hashes, and safe OS actions
 * Based on crates/sandbox and crates/cli-gateway
 */

const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const vm = require('vm');
const url = require('url');

class BionicSandboxGateway {
  constructor(vfs) {
    this.vfs = vfs;
    this.auditLog = [];
    this.connectors = new Map();
    this.initConnectors();

    // Pre-registered desktop apps
    this.desktopApps = {
      'spotify': { name: 'Spotify', cmd: 'start "" "spotify:"' },
      'calculator': { name: 'Calculator', cmd: 'calc.exe' },
      'calc': { name: 'Calculator', cmd: 'calc.exe' },
      'notepad': { name: 'Notepad', cmd: 'notepad.exe' },
      'paint': { name: 'Paint', cmd: 'mspaint.exe' },
      'vs code': { name: 'Visual Studio Code', cmd: 'code' },
      'vscode': { name: 'Visual Studio Code', cmd: 'code' },
      'visual studio code': { name: 'Visual Studio Code', cmd: 'code' },
      'code': { name: 'Visual Studio Code', cmd: 'code' },
      'chrome': { name: 'Google Chrome', cmd: 'start chrome' },
      'google chrome': { name: 'Google Chrome', cmd: 'start chrome' },
      'edge': { name: 'Microsoft Edge', cmd: 'start msedge' },
      'microsoft edge': { name: 'Microsoft Edge', cmd: 'start msedge' },
      'terminal': { name: 'Windows Terminal', cmd: 'wt.exe' },
      'cmd': { name: 'Command Prompt', cmd: 'start cmd' },
      'command prompt': { name: 'Command Prompt', cmd: 'start cmd' },
      'powershell': { name: 'PowerShell', cmd: 'start powershell' },
      'settings': { name: 'Windows Settings', cmd: 'start "" "ms-settings:"' },
      'explorer': { name: 'File Explorer', cmd: 'explorer.exe' },
      'file explorer': { name: 'File Explorer', cmd: 'explorer.exe' },
      'task manager': { name: 'Task Manager', cmd: 'taskmgr.exe' },
      'taskmgr': { name: 'Task Manager', cmd: 'taskmgr.exe' },
      'snipping tool': { name: 'Snipping Tool', cmd: 'snippingtool.exe' }
    };

    // Pre-registered web apps
    this.webApps = {
      'pinterest': { url: 'https://www.pinterest.com', label: 'Pinterest' },
      'pin': { url: 'https://www.pinterest.com', label: 'Pinterest' },
      'gmail': { url: 'https://mail.google.com', label: 'Gmail' },
      'google mail': { url: 'https://mail.google.com', label: 'Gmail' },
      'youtube': { url: 'https://youtube.com', label: 'YouTube' },
      'github': { url: 'https://github.com', label: 'GitHub' },
      'twitter': { url: 'https://x.com', label: 'X (Twitter)' },
      'x': { url: 'https://x.com', label: 'X (Twitter)' },
      'reddit': { url: 'https://reddit.com', label: 'Reddit' },
      'instagram': { url: 'https://www.instagram.com', label: 'Instagram' },
      'facebook': { url: 'https://www.facebook.com', label: 'Facebook' },
      'tiktok': { url: 'https://www.tiktok.com', label: 'TikTok' },
      'linkedin': { url: 'https://linkedin.com', label: 'LinkedIn' },
      'amazon': { url: 'https://amazon.com', label: 'Amazon' },
      'netflix': { url: 'https://netflix.com', label: 'Netflix' },
      'google docs': { url: 'https://docs.google.com', label: 'Google Docs' },
      'docs': { url: 'https://docs.google.com', label: 'Google Docs' },
      'google drive': { url: 'https://drive.google.com', label: 'Google Drive' },
      'drive': { url: 'https://drive.google.com', label: 'Google Drive' },
      'google': { url: 'https://www.google.com', label: 'Google' },
      'google maps': { url: 'https://maps.google.com', label: 'Google Maps' },
      'maps': { url: 'https://maps.google.com', label: 'Google Maps' },
      'wikipedia': { url: 'https://www.wikipedia.org', label: 'Wikipedia' },
      'whatsapp': { url: 'https://web.whatsapp.com', label: 'WhatsApp Web' },
      'discord': { url: 'https://discord.com', label: 'Discord' },
      'slack': { url: 'https://slack.com', label: 'Slack' },
      'chatgpt': { url: 'https://chatgpt.com', label: 'ChatGPT' },
      'openai': { url: 'https://openai.com', label: 'OpenAI' },
      'claude': { url: 'https://claude.ai', label: 'Claude AI' },
      'anthropic': { url: 'https://anthropic.com', label: 'Anthropic' },
      'perplexity': { url: 'https://perplexity.ai', label: 'Perplexity' },
      'leetcode': { url: 'https://leetcode.com', label: 'LeetCode' },
      'huggingface': { url: 'https://huggingface.co', label: 'Hugging Face' },
      'notion': { url: 'https://notion.so', label: 'Notion' },
      'figma': { url: 'https://figma.com', label: 'Figma' },
      'canva': { url: 'https://canva.com', label: 'Canva' },
      'spotify': { url: 'https://open.spotify.com', label: 'Spotify' },
      'soundcloud': { url: 'https://soundcloud.com', label: 'SoundCloud' },
      'twitch': { url: 'https://twitch.tv', label: 'Twitch' },
      'stackoverflow': { url: 'https://stackoverflow.com', label: 'Stack Overflow' },
      'medium': { url: 'https://medium.com', label: 'Medium' },
      'coursera': { url: 'https://coursera.org', label: 'Coursera' },
      'udemy': { url: 'https://udemy.com', label: 'Udemy' },
      'supabase': { url: 'https://supabase.com', label: 'Supabase' },
      'vercel': { url: 'https://vercel.com', label: 'Vercel' },
      'linear': { url: 'https://linear.app', label: 'Linear' },
      'quora': { url: 'https://www.quora.com', label: 'Quora' },
      'ebay': { url: 'https://www.ebay.com', label: 'eBay' },
      'flipkart': { url: 'https://www.flipkart.com', label: 'Flipkart' }
    };
  }

  // Canonical Action Hash: SHA256(tool + normalized_args + timestamp)
  createActionHash(toolName, args) {
    const serialized = JSON.stringify(args || {}, Object.keys(args || {}).sort());
    return crypto.createHash('sha256').update(`${toolName}:${serialized}`).digest('hex');
  }

  // SSRF Validator: Blocks loopback, link-local, and private metadata endpoints
  validateUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { allowed: false, reason: 'Disallowed protocol. Only http and https permitted.' };
      }

      const host = parsed.hostname.toLowerCase();
      // Loopback
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.')) {
        return { allowed: false, reason: 'SSRF Violation: Loopback addresses are restricted.' };
      }
      // AWS/GCP Cloud Metadata Link-Local
      if (host === '169.254.169.254') {
        return { allowed: false, reason: 'SSRF Violation: Cloud instance metadata endpoint blocked.' };
      }
      // Private RFC 1918 subnets
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(host)) {
        return { allowed: false, reason: 'SSRF Violation: Internal network addresses are restricted.' };
      }

      return { allowed: true, url: parsed.toString() };
    } catch (e) {
      return { allowed: false, reason: `Malformed URL: ${e.message}` };
    }
  }

  // Execute sandboxed JS calculation or script
  executeSandboxedJs(codeStr, timeoutMs = 2000) {
    try {
      const sandbox = {
        Math,
        Date,
        JSON,
        parseInt,
        parseFloat,
        String,
        Number,
        Array,
        Object,
        result: null
      };
      const context = vm.createContext(sandbox);
      const script = new vm.Script(`result = (function() { return (${codeStr}); })()`);
      script.runInContext(context, { timeout: timeoutMs });
      return { success: true, result: sandbox.result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Open web URL with SSRF protection
  openUrl(rawUrl, label) {
    const val = this.validateUrl(rawUrl);
    if (!val.allowed) {
      return { success: false, error: val.reason, type: 'URL_BLOCKED' };
    }

    try {
      exec(`start "" "${val.url}"`, { windowsHide: true });
      return { success: true, url: val.url, label: label || val.url, type: 'URL_OPENED' };
    } catch (err) {
      return { success: false, error: err.message, url: val.url, label, type: 'URL_OPENED' };
    }
  }

  // Analyze and extract clean target entity, intent type, and device context
  analyzeOpenTarget(input) {
    let raw = (input || '').trim();

    // Check explicit website / app hints
    const isExplicitWebsite = /\b(?:website|web\s*site|webpage|web\s*page|site|online|in\s+(?:the\s+)?browser|on\s+(?:the\s+)?web)\b/i.test(raw);
    const isExplicitApp = /\b(?:desktop\s+app|desktop\s+application|native\s+app|app|application|program|software)\b/i.test(raw);

    // Strip command prefixes: open, launch, go to, browse, etc.
    let target = raw.replace(/^(?:can\s+you\s+)?(?:please\s+)?(?:open|launch|start|run|go\s+to|navigate\s+to|visit|view|browse|take\s+me\s+to)\s+/i, '');

    // Strip leading "the " e.g. "open the figma website"
    target = target.replace(/^(?:the\s+)/i, '');

    // Strip device and platform qualifiers: "on my laptop", "on my pc", "on my computer", etc.
    target = target.replace(/\b(?:on|in|from)\s+(?:my|the|this)?\s*(?:laptop|pc|computer|device|desktop|machine|system|windows|mac)\b/gi, '');
    target = target.replace(/\b(?:on\s+(?:the\s+)?web|online|in\s+(?:the\s+)?browser|on\s+browser)\b/gi, '');

    // Strip trailing or leading app/website/site words
    target = target.replace(/\b(?:the\s+)?(?:website|web\s*site|webpage|web\s*page|site|page|portal|dashboard|desktop\s+app|app|application|program|software)\b/gi, '');

    // Strip trailing polite words
    target = target.replace(/\b(?:please|for\s+me|now|today)\b/gi, '');

    // Strip any remaining leading or trailing "the"
    target = target.replace(/^(?:the\s+)|(?:\s+the)$/i, '');

    // Trim punctuation and spaces
    target = target.replace(/^[^\w]+|[^\w]+$/g, '').trim();

    // If stripping resulted in empty string, fallback to original input without prefix
    if (!target) {
      target = raw.replace(/^(?:open|launch|go to)\s+/i, '').trim();
    }

    return {
      target,
      rawInput: raw,
      isExplicitWebsite,
      isExplicitApp
    };
  }

  // Check if target is an installed desktop application
  isDesktopApp(appKey) {
    if (!appKey) return false;
    const key = appKey.toLowerCase().trim();
    if (this.desktopApps[key]) return true;

    try {
      execSync(`where.exe "${key}"`, { windowsHide: true, stdio: 'pipe', timeout: 1000 });
      return true;
    } catch {}

    try {
      execSync(`where.exe "${key}.exe"`, { windowsHide: true, stdio: 'pipe', timeout: 1000 });
      return true;
    } catch {}

    return false;
  }

  // Autonomously resolve the authentic official domain for a website or service using TinyFish
  async resolveOfficialDomain(target) {
    const cleanTarget = (target || '').trim();
    if (!cleanTarget) return null;

    const lower = cleanTarget.toLowerCase();

    // 1. Check known web apps dictionary
    if (this.webApps[lower]) {
      let hostname = '';
      try { hostname = new URL(this.webApps[lower].url).hostname; } catch {}
      return {
        url: this.webApps[lower].url,
        title: this.webApps[lower].label,
        domain: hostname || cleanTarget,
        source: 'catalog'
      };
    }

    // 2. Direct URL or domain with dot
    if (cleanTarget.startsWith('http://') || cleanTarget.startsWith('https://')) {
      try {
        const parsed = new URL(cleanTarget);
        return {
          url: cleanTarget,
          title: parsed.hostname,
          domain: parsed.hostname,
          source: 'direct'
        };
      } catch {}
    }

    if (cleanTarget.includes('.') && !cleanTarget.includes(' ')) {
      const u = `https://${cleanTarget}`;
      try {
        const parsed = new URL(u);
        return {
          url: u,
          title: parsed.hostname,
          domain: parsed.hostname,
          source: 'direct'
        };
      } catch {}
    }

    // 3. Autonomous Web Domain Search via TinyFish (with DuckDuckGo fallback)
    const searchQuery = `${cleanTarget} official website`;
    let searchRes = await this.searchTinyFish(searchQuery);

    if (!searchRes || !searchRes.items || searchRes.items.length === 0) {
      searchRes = await this.executeWebSearch(`${cleanTarget} website`);
    }

    if (searchRes && searchRes.items && searchRes.items.length > 0) {
      const targetSlug = cleanTarget.toLowerCase().replace(/[^a-z0-9]/g, '');

      let bestItem = null;
      for (const item of searchRes.items) {
        if (!item.url || !item.url.startsWith('http')) continue;
        try {
          const parsed = new URL(item.url);
          const hostname = parsed.hostname.toLowerCase();

          // Avoid generic social network or app store pages unless the target itself is that site
          const isGenericExternal = (
            hostname.includes('facebook.com') ||
            hostname.includes('instagram.com') ||
            hostname.includes('twitter.com') ||
            hostname.includes('x.com') ||
            hostname.includes('linkedin.com') ||
            hostname.includes('play.google.com') ||
            hostname.includes('apps.apple.com') ||
            hostname.includes('youtube.com')
          ) && !targetSlug.includes(hostname.split('.')[hostname.split('.').length - 2]);

          if (!isGenericExternal) {
            const bareHost = hostname.replace(/^www\./, '');
            if (bareHost.includes(targetSlug) || targetSlug.includes(bareHost.split('.')[0])) {
              bestItem = item;
              break;
            }
          }
        } catch {}
      }

      // If no host matched item, pick first non-store item
      if (!bestItem) {
        for (const item of searchRes.items) {
          if (item.url && !item.url.includes('play.google.com') && !item.url.includes('apps.apple.com')) {
            bestItem = item;
            break;
          }
        }
      }

      if (!bestItem) {
        bestItem = searchRes.items[0];
      }

      if (bestItem && bestItem.url) {
        let domain = '';
        try { domain = new URL(bestItem.url).hostname; } catch {}
        return {
          url: bestItem.url,
          title: bestItem.title || cleanTarget,
          domain: domain || bestItem.url,
          snippet: bestItem.snippet || '',
          source: 'tinyfish_search',
          provider: searchRes.provider || 'tinyfish'
        };
      }
    }

    // 4. Safe fallback: open Google Search for target rather than constructing a fake domain
    const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(cleanTarget)}`;
    return {
      url: fallbackUrl,
      title: `${cleanTarget} (Search)`,
      domain: 'google.com',
      source: 'search_fallback'
    };
  }

  // Autonomous App or Web Resolution and Launch
  async launchApp(rawTarget) {
    if (!rawTarget) return { success: false, error: 'No target provided' };

    // 1. Analyze and normalize the open intent
    const analysis = this.analyzeOpenTarget(rawTarget);
    const target = analysis.target;
    const isExplicitWebsite = analysis.isExplicitWebsite;

    // 2. Check known desktop apps (unless user explicitly requested a website)
    if (!isExplicitWebsite && this.desktopApps[target.toLowerCase()]) {
      const entry = this.desktopApps[target.toLowerCase()];
      try {
        exec(entry.cmd, { windowsHide: true });
        return { success: true, appName: entry.name, type: 'APP_LAUNCHED' };
      } catch (err) {
        return { success: false, error: err.message, appName: entry.name, type: 'APP_LAUNCHED' };
      }
    }

    // 3. Check Windows PATH for executable (unless user explicitly requested a website)
    if (!isExplicitWebsite) {
      try {
        execSync(`where.exe "${target}"`, { windowsHide: true, stdio: 'pipe' });
        exec(`start "" "${target}"`, { windowsHide: true });
        return { success: true, appName: target, type: 'APP_LAUNCHED' };
      } catch {}
    }

    // 4. Resolve official web domain autonomously via TinyFish (or catalog / direct URL)
    const resolved = await this.resolveOfficialDomain(target);
    if (resolved && resolved.url) {
      const openRes = this.openUrl(resolved.url, resolved.title);
      return {
        success: openRes.success,
        url: resolved.url,
        title: resolved.title,
        domain: resolved.domain,
        target: target,
        type: 'URL_OPENED',
        source: resolved.source,
        provider: resolved.provider
      };
    }

    return { success: false, error: `Could not resolve app or website for "${target}"` };
  }

  // Spotify Windows URI Protocol & Live Web Player Playback
  playSpotify(query) {
    const clean = query.replace(/^play\s+/i, '').replace(/\s+(?:on|in)\s+spotify$/i, '').trim();
    const spotifyUri = `spotify:search:${encodeURIComponent(clean)}`;
    const webUrl = `https://open.spotify.com/search/${encodeURIComponent(clean)}`;

    try {
      exec(`start "" "${spotifyUri}"`, { windowsHide: true });
    } catch {}

    // Also open web player so user visually sees the tracks live on screen immediately!
    this.openUrl(webUrl, `Spotify: ${clean}`);

    return {
      success: true,
      query: clean,
      app: 'Spotify',
      webUrl,
      spotifyUri,
      type: 'MUSIC_PLAYING'
    };
  }

  getTinyFishCommand() {
    const fs = require('fs');
    if (fs.existsSync('C:\\nodejs\\tinyfish.cmd')) {
      return '"C:\\nodejs\\tinyfish.cmd"';
    }
    return 'tinyfish';
  }

  // Search using TinyFish Real-Time Web Agent (@tiny-fish/cli)
  async searchTinyFish(query) {
    const clean = (query || '').replace(/^for\s+/i, '').replace(/^(?:search(?:\s+for)?|google|look\s+up)\s+/i, '').trim();
    if (!clean) return { success: false, items: [], error: 'Empty query' };

    return new Promise((resolve) => {
      const sanitized = clean.replace(/"/g, '\\"');
      const cmd = this.getTinyFishCommand();
      exec(`${cmd} search query "${sanitized}"`, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        if (err || !stdout) {
          return resolve({ success: false, error: err ? err.message : stderr, items: [] });
        }
        try {
          const parsed = JSON.parse(stdout);
          const rawResults = parsed.results || [];
          const items = rawResults.map(r => ({
            title: r.title || r.site_name || 'Web Result',
            url: r.url,
            snippet: r.snippet || '',
            siteName: r.site_name || '',
            date: r.date || null
          }));

          if (this.vfs && items.length > 0) {
            try {
              this.vfs.writeJson(`/artifacts/tinyfish_search_${Date.now()}.json`, {
                provider: 'tinyfish',
                query: clean,
                items,
                searchedAt: new Date().toISOString()
              });
            } catch {}
          }

          resolve({
            success: true,
            provider: 'tinyfish',
            query: clean,
            total_count: items.length,
            items,
            type: 'TINYFISH_SEARCH_RESULTS'
          });
        } catch (e) {
          resolve({ success: false, error: e.message, items: [] });
        }
      });
    });
  }

  // Fetch clean markdown page content via TinyFish Web Agent (@tiny-fish/cli)
  async fetchTinyFish(url) {
    const cleanUrl = (url || '').trim();
    if (!cleanUrl) return { success: false, text: '', error: 'Empty URL' };

    return new Promise((resolve) => {
      const sanitized = cleanUrl.replace(/"/g, '\\"');
      const cmd = this.getTinyFishCommand();
      exec(`${cmd} fetch content get "${sanitized}"`, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        if (err || !stdout) {
          return resolve({ success: false, error: err ? err.message : stderr, text: '' });
        }
        try {
          const parsed = JSON.parse(stdout);
          const res = (parsed.results && parsed.results[0]) || {};
          const text = res.text || '';
          
          if (this.vfs && text) {
            try {
              this.vfs.writeJson(`/artifacts/tinyfish_fetch_${Date.now()}.json`, {
                provider: 'tinyfish',
                url: res.url || cleanUrl,
                title: res.title || '',
                length: text.length,
                fetchedAt: new Date().toISOString()
              });
            } catch {}
          }

          resolve({
            success: true,
            provider: 'tinyfish',
            url: res.url || cleanUrl,
            title: res.title || '',
            format: res.format || 'markdown',
            text: text,
            description: res.description || '',
            type: 'TINYFISH_FETCH_RESULT'
          });
        } catch (e) {
          resolve({ success: false, error: e.message, text: '' });
        }
      });
    });
  }

  // Live Web Search & Content Retrieval (TinyFish Web Agent with DuckDuckGo zero-key fallback)
  async executeWebSearch(query) {
    const cleanQuery = (query || '')
      .replace(/^for\s+/i, '')
      .replace(/^(?:search(?:\s+for)?|google|look\s+up)\s+/i, '')
      .trim();

    if (!cleanQuery) return { success: false, items: [], query: cleanQuery };

    // 1. Try TinyFish Search First (High-accuracy real-time index)
    try {
      const tfResult = await this.searchTinyFish(cleanQuery);
      if (tfResult.success && tfResult.items && tfResult.items.length > 0) {
        return tfResult;
      }
    } catch (tfErr) {
      console.warn('[TinyFish Search Warning, falling back to DuckDuckGo]', tfErr.message);
    }

    // 2. DuckDuckGo Fallback
    try {
      const htmlRes = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: `q=${encodeURIComponent(cleanQuery)}`
      });
      const html = await htmlRes.text();

      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

      const links = [];
      let lMatch;
      while ((lMatch = linkRegex.exec(html)) && links.length < 5) {
        links.push({ url: lMatch[1], title: lMatch[2].replace(/<[^>]+>/g, '').trim() });
      }

      const snippets = [];
      let sMatch;
      while ((sMatch = snippetRegex.exec(html)) && snippets.length < 5) {
        snippets.push(sMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      const items = links.map((l, i) => ({
        title: l.title,
        url: l.url,
        snippet: snippets[i] || ''
      }));

      // Also persist to VFS artifact
      if (this.vfs && items.length > 0) {
        try {
          this.vfs.writeJson(`/artifacts/web_search_${Date.now()}.json`, {
            provider: 'duckduckgo',
            query: cleanQuery,
            items,
            searchedAt: new Date().toISOString()
          });
        } catch {}
      }

      return {
        success: true,
        provider: 'duckduckgo',
        query: cleanQuery,
        total_count: items.length,
        items,
        type: 'WEB_SEARCH_RESULTS'
      };
    } catch (err) {
      console.error('[executeWebSearch Error]', err);
      return {
        success: false,
        error: err.message,
        query: cleanQuery,
        items: [],
        type: 'WEB_SEARCH_RESULTS'
      };
    }
  }

  // Web Search via Browser
  webSearch(query) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    try {
      exec(`start "" "${searchUrl}"`, { windowsHide: true });
      return { success: true, query, type: 'WEB_SEARCH' };
    } catch (err) {
      return { success: false, error: err.message, query, type: 'WEB_SEARCH' };
    }
  }

  // Live GitHub Data Retrieval via GitHub REST API (No auth token required for public repos)
  async searchGitHub(query) {
    let cleanQuery = (query || '')
      .replace(/^(?:can\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|check|get|show)\s+(?:me\s+)?/i, '')
      .replace(/^(?:github|gh)\s+(?:for\s+)?/i, '')
      .replace(/^(?:the\s+)?(?:github\s+)?(?:repo|repository)\s+(?:for|of)\s+/i, '')
      .replace(/^(?:for|the|a|an|me)\s+/i, '')
      .replace(/\s+(?:on|in)\s+github$/i, '')
      .replace(/\s+(?:official\s+)?(?:github\s+)?repo(?:sitory)?$/i, '')
      .replace(/[?.,!]$/, '')
      .trim();

    if (!cleanQuery) cleanQuery = (query || '').trim();

    // 1. Visibly navigate the user's browser UI to the GitHub search results
    const searchUrl = `https://github.com/search?q=${encodeURIComponent(cleanQuery)}&type=repositories`;
    this.openUrl(searchUrl, `GitHub Search: ${cleanQuery}`);

    try {
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}&per_page=5`, {
        headers: { 'User-Agent': 'WisprFlow-Bionic-Agent' }
      });
      if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.items || []).slice(0, 5).map(i => ({
        name: i.full_name,
        description: i.description || 'No description provided',
        stars: i.stargazers_count,
        url: i.html_url,
        language: i.language || 'Code',
        updated_at: i.updated_at
      }));

      return {
        success: true,
        query: cleanQuery,
        total_count: data.total_count || 0,
        items,
        searchUrl,
        type: 'GITHUB_SEARCH'
      };
    } catch (err) {
      return { success: false, error: err.message, query: cleanQuery, items: [], searchUrl, type: 'GITHUB_SEARCH' };
    }
  }

  // Autonomous live email composer launch (Gmail web compose + default OS mailto)
  launchEmailComposer(toEmail, subject, body) {
    const s = encodeURIComponent(subject || 'Quick Update');
    const b = encodeURIComponent(body || '');
    const to = encodeURIComponent(toEmail || '');

    // Web Gmail compose dialog (opens pre-filled on screen in browser)
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${s}&body=${b}`;
    this.openUrl(gmailUrl, `Gmail Compose: ${subject}`);

    const mailto = `mailto:${to}?subject=${s}&body=${b}`;

    return {
      success: true,
      gmailUrl,
      mailto,
      to: toEmail,
      subject,
      body,
      type: 'EMAIL_COMPOSER_LAUNCHED'
    };
  }

  // Live UI Search on Web Platforms
  openWebSearch(platform, query) {
    const p = (platform || '').toLowerCase().trim();
    const q = encodeURIComponent(query.trim());
    let targetUrl = '';
    let label = '';

    if (p === 'github' || p === 'gh') {
      targetUrl = `https://github.com/search?q=${q}&type=repositories`;
      label = `GitHub Search: ${query}`;
    } else if (p === 'youtube' || p === 'yt') {
      targetUrl = `https://www.youtube.com/results?search_query=${q}`;
      label = `YouTube Search: ${query}`;
    } else if (p === 'google') {
      targetUrl = `https://www.google.com/search?q=${q}`;
      label = `Google Search: ${query}`;
    } else if (p === 'spotify') {
      targetUrl = `https://open.spotify.com/search/${q}`;
      label = `Spotify Search: ${query}`;
    } else if (p === 'amazon') {
      targetUrl = `https://www.amazon.com/s?k=${q}`;
      label = `Amazon Search: ${query}`;
    } else if (p === 'reddit') {
      targetUrl = `https://www.reddit.com/search/?q=${q}`;
      label = `Reddit Search: ${query}`;
    } else if (p === 'twitter' || p === 'x') {
      targetUrl = `https://x.com/search?q=${q}`;
      label = `X Search: ${query}`;
    } else {
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(p + ' ' + query)}`;
      label = `Search: ${p} ${query}`;
    }

    return this.openUrl(targetUrl, label);
  }

  // Live Web Page Content Extraction (TinyFish markdown extractor with HTTP fallback)
  async fetchWebPage(rawUrl) {
    const val = this.validateUrl(rawUrl);
    if (!val.allowed) {
      return { success: false, error: val.reason, type: 'URL_BLOCKED' };
    }

    // 1. Try TinyFish clean markdown extractor first
    try {
      const tfRes = await this.fetchTinyFish(val.url);
      if (tfRes.success && tfRes.text) {
        return {
          success: true,
          provider: 'tinyfish',
          url: val.url,
          title: tfRes.title || val.url,
          text: tfRes.text.slice(0, 3000),
          format: 'markdown',
          totalLength: tfRes.text.length,
          type: 'WEB_PAGE_FETCHED'
        };
      }
    } catch {}

    // 2. HTTP scrape fallback
    try {
      const res = await fetch(val.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : val.url;

      // Extract readable content
      const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        success: true,
        provider: 'native_http',
        url: val.url,
        title,
        text: clean.slice(0, 2000),
        format: 'text',
        totalLength: clean.length,
        type: 'WEB_PAGE_FETCHED'
      };
    } catch (err) {
      return { success: false, error: err.message, url: val.url, type: 'WEB_PAGE_FETCHED' };
    }
  }

  // ==========================================
  // CONNECTORS SUBSYSTEM
  // ==========================================

  initConnectors() {
    // 1. Git Connector
    this.registerConnector('git', async (action, params = {}) => {
      const allowedActions = ['status', 'log', 'diff', 'branch'];
      const act = (action || 'status').toLowerCase();
      if (!allowedActions.includes(act)) {
        return { success: false, error: `Disallowed git action. Only ${allowedActions.join(', ')} permitted.` };
      }

      const cwd = params.cwd || process.cwd();
      let cmd = 'git status -s';
      if (act === 'log') cmd = 'git log -n 5 --oneline';
      if (act === 'diff') cmd = 'git diff --stat';
      if (act === 'branch') cmd = 'git branch -a';

      return new Promise((resolve) => {
        exec(cmd, { cwd, timeout: 5000 }, (err, stdout, stderr) => {
          if (err) {
            resolve({ success: false, error: stderr || err.message, action: act });
          } else {
            resolve({ success: true, action: act, output: stdout.trim(), cwd });
          }
        });
      });
    });

    // 2. Safe REST API Connector
    this.registerConnector('rest_api', async (action, params = {}) => {
      const endpoint = params.url || params.endpoint;
      if (!endpoint) return { success: false, error: 'Target URL is required for REST API connector' };

      const val = this.validateUrl(endpoint);
      if (!val.allowed) return { success: false, error: val.reason, type: 'URL_BLOCKED' };

      const method = (params.method || 'GET').toUpperCase();
      const headers = params.headers || { 'User-Agent': 'Bionic-GPT/1.0' };
      const body = params.body ? (typeof params.body === 'string' ? params.body : JSON.stringify(params.body)) : undefined;

      try {
        const res = await fetch(val.url, {
          method,
          headers,
          body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
          signal: AbortSignal.timeout(params.timeoutMs || 8000)
        });

        const contentType = res.headers.get('content-type') || '';
        let data = null;
        if (contentType.includes('application/json')) {
          data = await res.json();
        } else {
          data = (await res.text()).slice(0, 4000);
        }

        return {
          success: res.ok,
          status: res.status,
          statusText: res.statusText,
          data,
          url: val.url
        };
      } catch (err) {
        return { success: false, error: err.message, url: val.url };
      }
    });

    // 3. Filesystem Connector (Workspace boundary protected)
    this.registerConnector('filesystem', async (action, params = {}) => {
      const fs = require('fs');
      const act = (action || 'read').toLowerCase();
      const targetPath = params.path;

      if (!targetPath) return { success: false, error: 'Path parameter required' };

      // Resolve within workspace or bionic data
      const resolved = path.resolve(targetPath);
      const userHome = process.env.USERPROFILE || 'C:\\Users\\Krishna Maheshwari';

      // Security check: must reside inside user profile or current workspace
      const normResolved = resolved.toLowerCase();
      const normHome = userHome.toLowerCase();
      const normCwd = process.cwd().toLowerCase();
      if (!normResolved.startsWith(normHome) && !normResolved.startsWith(normCwd)) {
        return { success: false, error: 'Filesystem boundary violation: path is outside allowed directory.' };
      }

      try {
        if (act === 'read') {
          if (!fs.existsSync(resolved)) return { success: false, error: 'File not found' };
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            const files = fs.readdirSync(resolved);
            return { success: true, isDirectory: true, items: files.slice(0, 50), total: files.length };
          }
          const content = fs.readFileSync(resolved, 'utf-8');
          return { success: true, isFile: true, path: resolved, content: content.slice(0, 10000), size: stat.size };
        } else if (act === 'exists') {
          return { success: true, exists: fs.existsSync(resolved), path: resolved };
        }
        return { success: false, error: `Unsupported filesystem action: ${act}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // 4. Webhook Connector
    this.registerConnector('webhook', async (action, params = {}) => {
      const webhookUrl = params.url;
      if (!webhookUrl) return { success: false, error: 'Webhook URL required' };

      const val = this.validateUrl(webhookUrl);
      if (!val.allowed) return { success: false, error: val.reason };

      try {
        const payload = params.payload || { timestamp: new Date().toISOString(), source: 'Bionic-GPT' };
        const res = await fetch(val.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Bionic-Webhook/1.0' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000)
        });
        return { success: res.ok, status: res.status, url: val.url };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  registerConnector(name, handler) {
    if (!name || typeof handler !== 'function') return false;
    this.connectors.set(name.toLowerCase(), handler);
    return true;
  }

  async executeConnector(name, action, params = {}) {
    const key = (name || '').toLowerCase();
    const handler = this.connectors.get(key);
    if (!handler) {
      return { success: false, error: `Connector '${key}' not registered.` };
    }

    try {
      const startTime = Date.now();
      const res = await handler(action, params);
      const actionHash = this.createActionHash(`connector.${key}`, { action, ...params });

      this.auditLog.push({
        type: 'CONNECTOR_EXECUTION',
        connector: key,
        action,
        hash: actionHash,
        success: res.success !== false,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      return {
        success: res.success !== false,
        connector: key,
        action,
        result: res,
        actionHash,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return { success: false, error: err.message, connector: key, action };
    }
  }

  listConnectors() {
    return Array.from(this.connectors.keys());
  }
}

module.exports = BionicSandboxGateway;
