/**
 * Bionic-GPT Virtual Filesystem (VFS)
 * Implements Unix-style virtual filesystem abstraction for agentic context engineering:
 * /
 * ├── memory.md
 * ├── profile.json
 * ├── contacts.json
 * ├── attachments/
 * ├── conversations/
 * │   └── today/
 * ├── datasets/
 * ├── skills/
 * ├── artifacts/
 * └── tmp/
 */

const fs = require('fs');
const path = require('path');

class BionicVFS {
  constructor(storageRoot) {
    this.storageRoot = storageRoot || path.join(__dirname, 'data');
    this.mounts = new Map();
    this.init();
  }

  init() {
    const requiredDirs = [
      '',
      'attachments',
      'conversations',
      'conversations/today',
      'datasets',
      'skills',
      'artifacts',
      'tmp'
    ];

    for (const dir of requiredDirs) {
      const fullPath = path.join(this.storageRoot, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }

    // Default top-level memory file if missing
    const memoryPath = path.join(this.storageRoot, 'memory.md');
    if (!fs.existsSync(memoryPath)) {
      const defaultMemory = `# Bionic Agentic Memory Vault
Last Synchronized: ${new Date().toISOString()}

## Active User Profile
- Name: Krishna Maheshwari
- Role: Founder & Lead Engineer
- Default Communication Tone: Concise, high-signal, professional
- Timezone: Asia/Kolkata (IST)

## Ongoing Projects & Objectives
- Wispr Flow Desktop: Full-duplex conversational voice OS, Bionic-GPT agent harness, AG-UI streaming.
- Architecture: 100% sovereign local Whisper STT, Qwen 2.5 0.5B reasoning, Kokoro-82M TTS talkback.

## Recent Context & Epistemic Facts
- Verified Spotify Windows URI protocol: spotify:search:<query>
- System actions resolve in <1ms (fast path) or ~200ms (local LLM path).
`;
      fs.writeFileSync(memoryPath, defaultMemory, 'utf-8');
    }

    // Default taste.md (coding style, patterns, technical preferences)
    const tastePath = path.join(this.storageRoot, 'taste.md');
    if (!fs.existsSync(tastePath)) {
      const defaultTaste = `# Developer Coding Taste & Architectural Preferences
Last Updated: ${new Date().toISOString()}

## Preferred Languages & Stacks
- Primary: TypeScript / Node.js, Modern Rust, Python
- Web & Desktop: Clean modern HTML5/CSS3, Tailwind CSS, Electron

## Architecture & Design Patterns
- Sovereign local execution with isolated sandboxes
- Clean architecture with explicit interfaces and zero hardcoded magic numbers
- Durable multi-step workflows with comprehensive audit logs and error resilience
- Modular component structure with single responsibility principle

## Code Style & Implementation Preferences
- Elegant, production-grade code with concise, meaningful comments
- Strict typing, explicit return types, and early guard returns
- Prefer modern ES6+ (async/await, destructuring, arrow functions where appropriate)
- Kebab-case for file names, camelCase for functions and variables, PascalCase for classes
`;
      fs.writeFileSync(tastePath, defaultTaste, 'utf-8');
    }

    // Default profile.md (personal identity, communication tone, personalized response text)
    const profileMdPath = path.join(this.storageRoot, 'profile.md');
    if (!fs.existsSync(profileMdPath)) {
      const defaultProfileMd = `# User Identity & Response Personalization Vault
Last Updated: ${new Date().toISOString()}

## User Identity & Role
- Name: Krishna Maheshwari
- Role: Founder & Lead Engineer
- Organization: Bionic-GPT & Wispr Flow

## Communication Tone & Response Style
- Tone: Direct, concise, authoritative, professional
- Information Density: High signal-to-noise ratio, skip unnecessary polite conversational filler
- Formatting: Clean GitHub-flavored Markdown with clear headings, bullet points, and code blocks
- Signature: Best regards, Krishna Maheshwari

## Behaviour & Workflow Patterns
- Prefers live visual UI feedback and real-time token streaming
- Values sovereign, offline-first local AI execution
`;
      fs.writeFileSync(profileMdPath, defaultProfileMd, 'utf-8');
    }
  }

  // Resolve virtual path to real disk path with traversal protection
  resolve(virtualPath) {
    let clean = (virtualPath || '/').replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;

    // Check mounts
    for (const [prefix, diskTarget] of this.mounts.entries()) {
      if (clean === prefix || clean.startsWith(prefix + '/')) {
        const sub = clean.slice(prefix.length).replace(/^\//, '');
        const target = path.resolve(diskTarget, sub);
        if (!target.startsWith(path.resolve(diskTarget))) {
          throw new Error(`Security Violation: Path traversal blocked out of mount: ${clean}`);
        }
        return target;
      }
    }

    // Standard VFS root mapping
    const relative = clean.replace(/^\//, '');
    const resolved = path.resolve(this.storageRoot, relative);
    const rootResolved = path.resolve(this.storageRoot);

    if (!resolved.startsWith(rootResolved)) {
      throw new Error(`Security Violation: Path traversal blocked: ${virtualPath}`);
    }
    return resolved;
  }

  mount(virtualPrefix, diskPath) {
    let clean = virtualPrefix.replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    clean = clean.replace(/\/$/, '');
    this.mounts.set(clean, path.resolve(diskPath));
  }

  unmount(virtualPrefix) {
    let clean = virtualPrefix.replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    this.mounts.delete(clean);
  }

  exists(virtualPath) {
    try {
      const diskPath = this.resolve(virtualPath);
      return fs.existsSync(diskPath);
    } catch {
      return false;
    }
  }

  stat(virtualPath) {
    const diskPath = this.resolve(virtualPath);
    const s = fs.statSync(diskPath);
    return {
      size: s.size,
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      createdAt: s.birthtime,
      modifiedAt: s.mtime
    };
  }

  readFile(virtualPath, encoding = 'utf-8') {
    const diskPath = this.resolve(virtualPath);
    if (!fs.existsSync(diskPath)) {
      throw new Error(`VFS File Not Found: ${virtualPath}`);
    }
    return fs.readFileSync(diskPath, encoding);
  }

  readJson(virtualPath, fallback = null) {
    try {
      const content = this.readFile(virtualPath);
      return JSON.parse(content);
    } catch {
      return fallback;
    }
  }

  writeFile(virtualPath, content, encoding = 'utf-8') {
    const diskPath = this.resolve(virtualPath);
    const parent = path.dirname(diskPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(diskPath, content, encoding);
    return true;
  }

  writeJson(virtualPath, obj) {
    return this.writeFile(virtualPath, JSON.stringify(obj, null, 2));
  }

  appendFile(virtualPath, content, encoding = 'utf-8') {
    const diskPath = this.resolve(virtualPath);
    const parent = path.dirname(diskPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.appendFileSync(diskPath, content, encoding);
    return true;
  }

  readDir(virtualPath = '/', recursive = false) {
    const diskPath = this.resolve(virtualPath);
    if (!fs.existsSync(diskPath)) return [];

    const results = [];
    const entries = fs.readdirSync(diskPath, { withFileTypes: true });

    for (const ent of entries) {
      const vSub = path.join(virtualPath, ent.name).replace(/\\/g, '/');
      results.push({
        name: ent.name,
        virtualPath: vSub,
        isDirectory: ent.isDirectory(),
        isFile: ent.isFile()
      });

      if (recursive && ent.isDirectory()) {
        const nested = this.readDir(vSub, true);
        results.push(...nested);
      }
    }
    return results;
  }

  deleteFile(virtualPath) {
    const diskPath = this.resolve(virtualPath);
    if (fs.existsSync(diskPath)) {
      fs.unlinkSync(diskPath);
      return true;
    }
    return false;
  }

  // Content search across VFS
  search(query, virtualDir = '/', options = {}) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];

    const maxResults = options.maxResults || 20;
    const all = this.readDir(virtualDir, true);
    const matches = [];

    for (const item of all) {
      if (item.isFile) {
        // Filename match
        if (item.name.toLowerCase().includes(q)) {
          matches.push({ ...item, matchType: 'filename' });
          if (matches.length >= maxResults) break;
          continue;
        }

        // Text content match
        if (/\.(md|txt|json|js|csv|html|xml)$/i.test(item.name)) {
          try {
            const content = this.readFile(item.virtualPath);
            const idx = content.toLowerCase().indexOf(q);
            if (idx !== -1) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(content.length, idx + q.length + 60);
              const snippet = content.slice(start, end).replace(/\r?\n/g, ' ');
              matches.push({
                ...item,
                matchType: 'content',
                snippet: `...${snippet}...`
              });
              if (matches.length >= maxResults) break;
            }
          } catch {}
        }
      }
    }
    return matches;
  }

  // Dump ASCII tree representation of VFS structure
  dumpTree(virtualPath = '/', indent = '') {
    const diskPath = this.resolve(virtualPath);
    let output = '';
    const entries = fs.readdirSync(diskPath, { withFileTypes: true });

    entries.forEach((ent, idx) => {
      const isLast = idx === entries.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      output += `${indent}${branch}${ent.name}${ent.isDirectory() ? '/' : ''}\n`;

      if (ent.isDirectory()) {
        const nextIndent = indent + (isLast ? '    ' : '│   ');
        const vSub = path.join(virtualPath, ent.name).replace(/\\/g, '/');
        output += this.dumpTree(vSub, nextIndent);
      }
    });
    return output;
  }
}

module.exports = BionicVFS;
