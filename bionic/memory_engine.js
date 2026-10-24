/**
 * Bionic-GPT Memory Engine
 * Implements Filesystem-Based Core Architecture for Personalized LLM Agents
 * Manages /taste.md (developer coding taste, style, patterns) and /profile.md (identity, behaviour, response phrasing)
 * Based on arxiv.org/abs/2607.26637 and Dot Personal Relationship Vault
 */

const path = require('path');

class BionicMemoryEngine {
  constructor(vfs, options = {}) {
    this.vfs = vfs;
    this.vectorMemory = options.vectorMemory || null;
    this.graphMemory = options.graphMemory || null;
    this.sessionId = `session_${Date.now()}`;
    this.profile = null;
    this.contacts = [];
    this.loadState();
  }

  loadState() {
    this.profile = this.vfs.readJson('/profile.json', {
      name: 'Krishna Maheshwari',
      role: 'Founder & Lead Engineer',
      defaultTone: 'concise, high-signal, professional',
      signature: 'Best regards,\nKrishna Maheshwari'
    });

    this.contacts = this.vfs.readJson('/contacts.json', []);
  }

  getProfile() {
    return this.profile;
  }

  getContacts() {
    return this.contacts;
  }

  getProfileMd() {
    try {
      return this.vfs.readFile('/profile.md') || '';
    } catch {
      return '';
    }
  }

  getTasteMd() {
    try {
      return this.vfs.readFile('/taste.md') || '';
    } catch {
      return '';
    }
  }

  updateProfileMd(content) {
    try {
      this.vfs.writeFile('/profile.md', content);
      if (this.vectorMemory) {
        this.vectorMemory.addDocument('vfs_profile_md', content, { type: 'profile_md', path: '/profile.md' }, 'learned_profile');
      }
      return true;
    } catch {
      return false;
    }
  }

  updateTasteMd(content) {
    try {
      this.vfs.writeFile('/taste.md', content);
      if (this.vectorMemory) {
        this.vectorMemory.addDocument('vfs_taste_md', content, { type: 'taste_md', path: '/taste.md' }, 'learned_taste');
      }
      return true;
    } catch {
      return false;
    }
  }

  resolveContact(query) {
    if (!query) return null;
    const q = query.trim().toLowerCase();

    for (const c of this.contacts) {
      if (c.name && c.name.toLowerCase().includes(q)) return c;
      if (c.aliases && c.aliases.some(a => a.toLowerCase() === q)) return c;
    }
    return {
      name: query,
      email: `${query.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      role: 'Contact'
    };
  }

  // Retrieve memory context tailored to the user's prompt
  getRelevantContext(userPrompt) {
    const q = (userPrompt || '').toLowerCase();
    const result = {
      user: this.profile,
      matchedContacts: [],
      memorySnippets: []
    };

    // 1. Resolve any mentioned contacts
    for (const c of this.contacts) {
      if (q.includes(c.name.toLowerCase()) || (c.aliases && c.aliases.some(a => q.includes(a.toLowerCase())))) {
        result.matchedContacts.push(c);
      }
    }

    // 2. Read relevant snippets from /memory.md
    try {
      const memoryContent = this.vfs.readFile('/memory.md');
      const lines = memoryContent.split('\n');
      let currentSection = '';

      for (const line of lines) {
        if (line.startsWith('## ')) {
          currentSection = line.replace('## ', '').trim();
        } else if (line.startsWith('- ')) {
          const text = line.replace(/^- /, '').trim();
          const words = q.split(/\s+/).filter(w => w.length > 3);
          const isRelevant = words.some(w => text.toLowerCase().includes(w));
          if (isRelevant || currentSection.includes('Profile') || currentSection.includes('Objectives')) {
            result.memorySnippets.push(`[${currentSection}] ${text}`);
          }
        }
      }
    } catch {}

    return result;
  }

  // Retrieve recent conversation history from today's sessions
  getRecentChatHistory(maxTurns = 6) {
    if (!this.vfs) return [];
    try {
      const logPath = `/conversations/today/${this.sessionId}.json`;
      const sessionLog = this.vfs.readJson(logPath, null);
      if (sessionLog && Array.isArray(sessionLog.turns)) {
        return sessionLog.turns.slice(-maxTurns);
      }
    } catch {}
    return [];
  }

  startNewSession() {
    this.sessionId = `session_${Date.now()}`;
    return this.sessionId;
  }

  listSessions() {
    if (!this.vfs) return [];
    try {
      const files = this.vfs.readDir('/conversations/today');
      const sessions = [];
      for (const f of files) {
        if (!f.name || !f.name.endsWith('.json')) continue;
        try {
          const data = this.vfs.readJson(f.virtualPath);
          if (data && Array.isArray(data.turns) && data.turns.length > 0) {
            const firstTurn = data.turns.find(t => t.user);
            const lastTurn = data.turns[data.turns.length - 1];
            const title = firstTurn ? firstTurn.user.slice(0, 45) : 'Conversation';
            sessions.push({
              sessionId: data.sessionId || f.name.replace('.json', ''),
              title,
              date: data.date,
              turnCount: data.turns.length,
              lastTimestamp: lastTurn && lastTurn.timestamp ? lastTurn.timestamp : (data.date || new Date().toISOString()),
              turns: data.turns
            });
          }
        } catch {}
      }
      sessions.sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
      return sessions;
    } catch {
      return [];
    }
  }

  getSession(sessionId) {
    if (!this.vfs || !sessionId) return null;
    try {
      const data = this.vfs.readJson(`/conversations/today/${sessionId}.json`, null);
      if (data) {
        this.sessionId = data.sessionId || sessionId;
      }
      return data;
    } catch {
      return null;
    }
  }

  deleteSession(sessionId) {
    if (!this.vfs || !sessionId) return false;
    try {
      const ok = this.vfs.deleteFile(`/conversations/today/${sessionId}.json`);
      if (this.sessionId === sessionId) {
        this.startNewSession();
      }
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Core Personalized Memory Reflection:
   * Updates ONLY if the agent learns anything new about the user's:
   * 1. CODING TASTE, paradigms, syntax, libraries, or architecture -> updates /taste.md
   * 2. USER PROFILE, identity, communication tone, or personalized phrasing -> updates /profile.md
   * STRICT NEGATIVE FILTER: Transient interests (movies, sports, food, weather, trivia) and general tech questions MUST NEVER update memory.
   */
  reflectAndLearn(userPrompt, textOutput = '') {
    if (!userPrompt || typeof userPrompt !== 'string') {
      return { learned: false, reason: 'Empty user prompt' };
    }

    const p = userPrompt.trim();
    const pLower = p.toLowerCase();

    // 1. REJECTION FILTER (Transient Interests, Trivia, Standard Actions)
    // Casual greetings
    if (/^(hi|hello|hey|yo|greetings|good\s+(?:morning|evening|afternoon|night))[\s!.]*$/i.test(p)) {
      return { learned: false, reason: 'Casual greeting' };
    }

    // Pure transient interests / entertainment (NOT coding taste or user profile)
    const transientInterestPatterns = [
      /\b(?:movie|film|actor|actress|cricket|football|soccer|tennis|game|gaming|nintendo|playstation|xbox|anime|manga|song|singer|music band|album|pizza|burger|food|recipe|restaurant|weather|forecast|horoscope|vacation|travel|flight|hotel|car|shopping|shoe|dress)\b/i
    ];
    // If it's about a transient interest and has no explicit coding keywords, skip immediately!
    const isTransient = transientInterestPatterns.some(rgx => rgx.test(pLower));
    const hasCodingKeyword = /\b(?:code|coding|function|class|method|typescript|javascript|python|rust|c\+\+|golang|css|tailwind|html|api|react|vue|svelte|node|npm|git|architecture|backend|frontend|database|sql|nosql|async|await|syntax|pattern|library|framework|semicolon|tabs|spaces|camelcase|snake_case|kebab-case|functional|oop)\b/i.test(pLower);

    if (isTransient && !hasCodingKeyword) {
      return { learned: false, reason: 'Transient non-coding interest rejected' };
    }

    // Standard task instructions without personal preference ("open pinterest", "search google for x", "calculate 25*40")
    if (/^(?:open|launch|start|run|search|find|google|calculate|solve|fetch|download|install|tinyfish)\b/i.test(p) &&
        !/\b(?:i prefer|my style|my preference|always use|never use|don't use|i like to use|my pattern)\b/i.test(pLower)) {
      return { learned: false, reason: 'Standard action command without personal preference' };
    }

    // Generic informational questions ("what is python", "how does redis work", "explain quantum computing")
    if (/^(?:what is|what are|how to|how does|why is|explain|tell me about|who is|where is|describe)\b/i.test(p) &&
        !/\b(?:i prefer|in my project|for my taste|my preference|i like|i hate|we use|i always)\b/i.test(pLower)) {
      return { learned: false, reason: 'Generic informational query without personal declaration' };
    }

    // 2. CODING TASTE DETECTION (Updates /taste.md)
    let learnedTaste = null;
    let tasteCategory = 'Code Style & Preferences';

    // Pattern A: "I prefer X over Y", "I prefer X", "I always use X", "I never use X", "Don't use X in my code"
    const codingTastePatterns = [
      {
        regex: /(?:i|we)\s+(?:strongly\s+)?(?:prefer|always use|never use|don't use|hate|dislike|love using|stick to|default to|only use)\s+([^.\n?!]+)/i,
        extract: (m) => m[0].trim()
      },
      {
        regex: /(?:my|our)\s+(?:coding style|coding taste|preferred stack|code preference|style rule|coding pattern|code standard)\s+(?:is|are|must be)\s+([^.\n?!]+)/i,
        extract: (m) => `User preference: ${m[1].trim()}`
      },
      {
        regex: /(?:always|never|do not|don't)\s+(?:write|use|put|add|include)\s+(?:comments|semicolons|classes|var|any|types|interfaces|arrow functions|tabs|spaces|snake_case|camelcase|kebab-case)\b([^.\n?!]*)/i,
        extract: (m) => m[0].trim()
      },
      {
        regex: /(?:prefer|use|choose)\s+([a-zA-Z0-9#+._\s]+)\s+(?:over|instead of|rather than)\s+([a-zA-Z0-9#+._\s]+)/i,
        extract: (m) => `Prefers ${m[1].trim()} over ${m[2].trim()}`
      },
      {
        regex: /(?:in my code|for my projects?|when coding),\s*(?:always|never|prefer)\s+([^.\n?!]+)/i,
        extract: (m) => m[0].trim()
      },
      {
        regex: /(?:functional programming|oop|object-oriented|immutability|clean code|dry principle|solid principles?|guard clauses?|early returns?)\s+(?:is preferred|is my preference|is what i use|rule)/i,
        extract: (m) => `Adheres to: ${m[0].trim()}`
      }
    ];

    for (const pat of codingTastePatterns) {
      const match = p.match(pat.regex);
      if (match) {
        // Ensure this actually contains coding context or keywords
        const candidate = pat.extract(match);
        if (hasCodingKeyword || /\b(?:prefer|use|stack|code|style|pattern|architecture|syntax|types)\b/i.test(candidate)) {
          learnedTaste = candidate;
          if (/\b(?:architecture|solid|clean architecture|microservices|monolith|modular)\b/i.test(candidate)) {
            tasteCategory = 'Architecture & Design Patterns';
          } else if (/\b(?:typescript|rust|python|golang|javascript|c\+\+|node)\b/i.test(candidate)) {
            tasteCategory = 'Preferred Languages & Stacks';
          }
          break;
        }
      }
    }

    if (learnedTaste) {
      // Clean and normalize learned taste text
      learnedTaste = learnedTaste.replace(/^(?:please|can you|agent,)\s*/i, '').trim();
      // Capitalize first letter
      learnedTaste = learnedTaste.charAt(0).toUpperCase() + learnedTaste.slice(1);

      // Deduplication check against existing /taste.md
      const currentTaste = this.getTasteMd();
      const normCheck = learnedTaste.toLowerCase().replace(/[^a-z0-9]/g, ' ');
      const words = normCheck.split(/\s+/).filter(w => w.length > 3);
      const isDuplicate = words.length > 0 && currentTaste.toLowerCase().includes(learnedTaste.toLowerCase());

      if (!isDuplicate) {
        const today = new Date().toISOString().slice(0, 10);
        const entry = `- [${today}] ${learnedTaste}`;

        let updatedTaste = currentTaste;
        if (!updatedTaste.includes('## Learned Coding Preferences')) {
          updatedTaste += `\n\n## Learned Coding Preferences\n${entry}\n`;
        } else {
          updatedTaste = updatedTaste.replace('## Learned Coding Preferences', `## Learned Coding Preferences\n${entry}`);
        }

        this.vfs.writeFile('/taste.md', updatedTaste);

        // Vector memory semantic indexing
        if (this.vectorMemory) {
          try {
            this.vectorMemory.addDocument(
              `taste_${Date.now()}`,
              `Developer Coding Taste: ${learnedTaste}`,
              { type: 'coding_taste', category: tasteCategory, date: today },
              'learned_taste'
            );
          } catch {}
        }

        // Knowledge Graph linking
        if (this.graphMemory) {
          try {
            const nodeId = `taste_${learnedTaste.slice(0, 30).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            this.graphMemory.addNode(nodeId, learnedTaste, 'CodingPreference');
            this.graphMemory.addEdge('krishna_maheshwari', nodeId, 'PREFERS_CODING_STYLE');
          } catch {}
        }

        return {
          learned: true,
          type: 'taste',
          category: tasteCategory,
          item: learnedTaste,
          targetFile: '/taste.md'
        };
      }
    }

    // 3. USER PROFILE & BEHAVIOUR DETECTION (Updates /profile.md)
    let learnedProfile = null;
    let profileCategory = 'Personal Profile & Behaviour';

    const profilePatterns = [
      {
        regex: /(?:call me|refer to me as|my nickname is|my name is)\s+([a-zA-Z0-9_\s]{2,30})/i,
        extract: (m) => `Preferred name/alias: ${m[1].trim()}`
      },
      {
        regex: /(?:my role is|i work as|i am the|i'm the|i am a)\s+([a-zA-Z0-9_\s]{3,40})/i,
        extract: (m) => `Role/Title: ${m[1].trim()}`
      },
      {
        regex: /(?:always respond|reply to me|talk to me|keep your answers|answer me|format your responses?)\s+(?:in|with|using|as)?\s*(?:concise|bullet points|super short|formal|casual|blunt|high signal|straight to the point|minimal text|table format|in markdown)/i,
        extract: (m) => `Communication Tone Preference: ${m[0].trim()}`
      },
      {
        regex: /(?:my signature is|sign off with|use signature)\s+([^\n.?!]{3,50})/i,
        extract: (m) => `Signature: ${m[1].trim()}`
      },
      {
        regex: /(?:i usually work|my working hours|i code mostly|i am active during)\s+([^\n.?!]{3,40})/i,
        extract: (m) => `Working pattern: ${m[0].trim()}`
      }
    ];

    for (const pat of profilePatterns) {
      const match = p.match(pat.regex);
      if (match) {
        learnedProfile = pat.extract(match);
        break;
      }
    }

    if (learnedProfile) {
      learnedProfile = learnedProfile.replace(/^(?:please|can you)\s*/i, '').trim();
      learnedProfile = learnedProfile.charAt(0).toUpperCase() + learnedProfile.slice(1);

      // Deduplication check against existing /profile.md
      const currentProfileMd = this.getProfileMd();
      const isDuplicate = currentProfileMd.toLowerCase().includes(learnedProfile.toLowerCase());

      if (!isDuplicate) {
        const today = new Date().toISOString().slice(0, 10);
        const entry = `- [${today}] ${learnedProfile}`;

        let updatedProfileMd = currentProfileMd;
        if (!updatedProfileMd.includes('## Learned Profile & Behavioural Patterns')) {
          updatedProfileMd += `\n\n## Learned Profile & Behavioural Patterns\n${entry}\n`;
        } else {
          updatedProfileMd = updatedProfileMd.replace('## Learned Profile & Behavioural Patterns', `## Learned Profile & Behavioural Patterns\n${entry}`);
        }

        this.vfs.writeFile('/profile.md', updatedProfileMd);

        // Update profile.json if specific keys matched
        if (learnedProfile.includes('Preferred name/alias:')) {
          const nameVal = learnedProfile.replace('Preferred name/alias:', '').trim();
          this.profile.name = nameVal;
          this.vfs.writeJson('/profile.json', this.profile);
        } else if (learnedProfile.includes('Role/Title:')) {
          const roleVal = learnedProfile.replace('Role/Title:', '').trim();
          this.profile.role = roleVal;
          this.vfs.writeJson('/profile.json', this.profile);
        } else if (learnedProfile.includes('Communication Tone Preference:')) {
          const toneVal = learnedProfile.replace('Communication Tone Preference:', '').trim();
          this.profile.defaultTone = toneVal;
          this.vfs.writeJson('/profile.json', this.profile);
        }

        // Vector memory semantic indexing
        if (this.vectorMemory) {
          try {
            this.vectorMemory.addDocument(
              `profile_${Date.now()}`,
              `User Profile & Behavior: ${learnedProfile}`,
              { type: 'user_profile', category: profileCategory, date: today },
              'learned_profile'
            );
          } catch {}
        }

        // Knowledge Graph linking
        if (this.graphMemory) {
          try {
            const nodeId = `profile_${learnedProfile.slice(0, 30).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            this.graphMemory.addNode(nodeId, learnedProfile, 'UserProfileTrait');
            this.graphMemory.addEdge('krishna_maheshwari', nodeId, 'HAS_PROFILE_TRAIT');
          } catch {}
        }

        return {
          learned: true,
          type: 'profile',
          category: profileCategory,
          item: learnedProfile,
          targetFile: '/profile.md'
        };
      }
    }

    return { learned: false, reason: 'No new coding taste or user profile pattern detected' };
  }

  // Record an episodic conversation turn into /conversations/today/ and trigger personalized reflection
  recordTurn(userPrompt, actionResult, textOutput) {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = `/conversations/today/${this.sessionId}.json`;

    let sessionLog = this.vfs.readJson(logPath, {
      sessionId: this.sessionId,
      date: today,
      turns: []
    });

    const turn = {
      timestamp: new Date().toISOString(),
      user: userPrompt,
      action: actionResult || null,
      response: textOutput || null
    };

    sessionLog.turns.push(turn);
    this.vfs.writeJson(logPath, sessionLog);

    // Index turn into Vector Memory for episodic semantic recall
    if (this.vectorMemory && textOutput) {
      try {
        const docId = `chat_${this.sessionId}_${Date.now()}`;
        this.vectorMemory.addDocument(
          docId,
          `User: "${userPrompt}"\nAssistant: "${(textOutput || '').slice(0, 500)}"`,
          { type: 'episodic_conversation', date: today, sessionId: this.sessionId },
          'recent_chats'
        );
      } catch {}
    }

    // Execute Core Personalized Memory Reflection
    const reflection = this.reflectAndLearn(userPrompt, textOutput);
    return reflection;
  }

  // Autonomously update /memory.md with learned facts
  learnFact(category, fact) {
    const timestamp = new Date().toISOString();
    const formattedFact = `\n- [${timestamp}] ${fact}`;
    try {
      this.vfs.appendFile('/memory.md', formattedFact);
      return true;
    } catch {
      return false;
    }
  }

  // Get full structured system prompt context injecting profile.md and taste.md
  getSystemPromptContext() {
    let ctx = '## PERSONAL AGENTIC CONTEXT (BIONIC MEMORY):\n';
    ctx += `- User: ${this.profile.name} (${this.profile.role})\n`;
    ctx += `- Default Tone: ${this.profile.defaultTone}\n`;
    if (this.contacts && this.contacts.length > 0) {
      ctx += `- Known Contacts: ${this.contacts.map(c => `${c.name} <${c.email}>`).join(', ')}\n`;
    }

    // Inject active profile.md directives
    try {
      const profileMd = this.getProfileMd();
      if (profileMd && profileMd.trim().length > 0) {
        ctx += `\n## USER IDENTITY & PERSONAL BEHAVIOUR DIRECTIVES (/profile.md):\n${profileMd.trim()}\n`;
      }
    } catch {}

    // Inject active taste.md directives (strict coding standards)
    try {
      const tasteMd = this.getTasteMd();
      if (tasteMd && tasteMd.trim().length > 0) {
        ctx += `\n## DEVELOPER CODING TASTE & ARCHITECTURE STANDARDS (/taste.md):\n${tasteMd.trim()}\n`;
        ctx += `(CRITICAL: When generating, editing, or discussing code, you MUST adhere strictly to the languages, paradigms, syntax, and formatting preferences in /taste.md above!)\n`;
      }
    } catch {}

    return ctx;
  }
}

module.exports = BionicMemoryEngine;
