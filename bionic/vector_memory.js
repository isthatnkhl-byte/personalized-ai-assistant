/**
 * Bionic-GPT In-Process Vector DB & Semantic Memory Engine
 * Implements high-dimensional subword + TF-IDF normalized vector space
 * Fast cosine similarity search, episodic memory recall & persistent VFS store
 * Based on crates/memory-engine & vector-space indexing
 */

class BionicVectorMemory {
  constructor(vfs, options = {}) {
    this.vfs = vfs;
    this.dimensions = options.dimensions || 512;
    this.storagePath = '/memory/vector_index.json';
    this.documents = []; // { id, text, vector, metadata, source, timestamp }
    this.loadIndex();
  }

  // Load persisted vector store from VFS
  loadIndex() {
    if (!this.vfs) return;
    try {
      const stored = this.vfs.readJson(this.storagePath, null);
      if (stored && Array.isArray(stored.documents)) {
        this.documents = stored.documents;
      }
    } catch {
      this.documents = [];
    }
  }

  // Persist vector store to VFS
  saveIndex() {
    if (!this.vfs) return;
    try {
      this.vfs.writeJson(this.storagePath, {
        dimensions: this.dimensions,
        count: this.documents.length,
        savedAt: new Date().toISOString(),
        documents: this.documents
      });
    } catch {}
  }

  // Hash a token or n-gram into a deterministic bucket [0, dimensions - 1]
  hashToken(token) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return Math.abs(hash) % this.dimensions;
  }

  // Generate subword + unigram n-grams from text
  extractTokens(text) {
    const clean = (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .trim();
    if (!clean) return [];

    const words = clean.split(/\s+/).filter(w => w.length > 0);
    const tokens = [];

    for (const w of words) {
      tokens.push(w);
      // Character 3-grams and 4-grams for subword semantic fuzzy matching
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) {
          tokens.push(w.slice(i, i + 3));
        }
      }
      if (w.length >= 4) {
        for (let i = 0; i <= w.length - 4; i++) {
          tokens.push(w.slice(i, i + 4));
        }
      }
    }

    // Word bigrams
    for (let i = 0; i < words.length - 1; i++) {
      tokens.push(`${words[i]}_${words[i + 1]}`);
    }

    return tokens;
  }

  // Generate L2-normalized dense embedding vector (Euclidean norm = 1.0)
  embed(text) {
    const vec = new Float32Array(this.dimensions);
    const tokens = this.extractTokens(text);
    if (tokens.length === 0) return Array.from(vec);

    const termFreq = new Map();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) || 0) + 1);
    }

    // Sub-linear term frequency scaling: 1 + ln(tf)
    let sumSq = 0;
    for (const [token, tf] of termFreq.entries()) {
      const bucket = this.hashToken(token);
      const weight = 1 + Math.log(tf);
      vec[bucket] += weight;
    }

    for (let i = 0; i < this.dimensions; i++) {
      sumSq += vec[i] * vec[i];
    }

    // L2 Normalize
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm;
      }
    }

    return Array.from(vec);
  }

  // Fast cosine similarity between two unit vectors (dot product)
  cosineSimilarity(v1, v2) {
    if (!v1 || !v2 || v1.length !== v2.length) return 0;
    let dot = 0;
    for (let i = 0; i < v1.length; i++) {
      dot += v1[i] * v2[i];
    }
    return Math.max(0, Math.min(1, dot));
  }

  // Insert document or memory chunk into vector store
  addDocument(id, text, metadata = {}, source = 'memory') {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length < 5) return;

    // Check if duplicate ID exists, replace if so
    const existingIdx = this.documents.findIndex(d => d.id === id);
    const vector = this.embed(trimmed);
    const docEntry = {
      id: id || `vec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: trimmed,
      vector,
      metadata,
      source,
      timestamp: new Date().toISOString()
    };

    if (existingIdx !== -1) {
      this.documents[existingIdx] = docEntry;
    } else {
      this.documents.push(docEntry);
    }

    this.saveIndex();
    return docEntry;
  }

  // Search vector store using cosine similarity
  search(query, topK = 3, minScore = 0.15) {
    if (!query || this.documents.length === 0) return [];

    const queryVec = this.embed(query);
    const scored = [];

    for (const doc of this.documents) {
      const score = this.cosineSimilarity(queryVec, doc.vector);
      if (score >= minScore) {
        scored.push({
          id: doc.id,
          text: doc.text,
          score,
          similarityPercent: Math.round(score * 100),
          metadata: doc.metadata,
          source: doc.source,
          timestamp: doc.timestamp
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // Reindex all documents, memory notes, and conversation turns in VFS
  reindexAll() {
    if (!this.vfs) return 0;

    // 1. Index /memory.md sections
    try {
      if (this.vfs.exists('/memory.md')) {
        const memText = this.vfs.readFile('/memory.md');
        const lines = memText.split('\n');
        let currentHeader = 'General Memory';
        let chunk = [];

        for (const line of lines) {
          if (line.startsWith('#')) {
            if (chunk.length > 0) {
              this.addDocument(`memory_${currentHeader.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, chunk.join(' '), { section: currentHeader }, 'memory_vault');
              chunk = [];
            }
            currentHeader = line.replace(/^#+\s*/, '').trim();
          } else if (line.trim()) {
            chunk.push(line.trim());
          }
        }
        if (chunk.length > 0) {
          this.addDocument(`memory_${currentHeader.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, chunk.join(' '), { section: currentHeader }, 'memory_vault');
        }
      }
    } catch {}

    // 2. Index profile and contacts
    try {
      const profile = this.vfs.readJson('/profile.json', null);
      if (profile) {
        this.addDocument('user_profile', `User Profile: Name: ${profile.name}, Role: ${profile.role}, Default Tone: ${profile.defaultTone}, Signature: ${profile.signature}`, profile, 'user_profile');
      }
      const contacts = this.vfs.readJson('/contacts.json', []);
      for (const c of contacts) {
        this.addDocument(`contact_${c.name.toLowerCase().replace(/\s+/g, '_')}`, `Contact: ${c.name}, Email: ${c.email}, Role: ${c.role || ''}, Aliases: ${(c.aliases || []).join(', ')}`, c, 'contacts');
      }
    } catch {}

    // 3. Index datasets and attachments
    const dirs = ['/datasets', '/attachments'];
    for (const d of dirs) {
      if (!this.vfs.exists(d)) continue;
      const files = this.vfs.readDir(d, true);
      for (const f of files) {
        if (f.isFile && /\.(md|txt|json)$/i.test(f.name)) {
          try {
            const content = this.vfs.readFile(f.virtualPath);
            const paragraphs = content.split(/\r?\n\r?\n/);
            paragraphs.forEach((p, idx) => {
              if (p.trim().length > 30) {
                this.addDocument(`${f.virtualPath}#chunk_${idx}`, p.trim(), { file: f.virtualPath }, 'dataset');
              }
            });
          } catch {}
        }
      }
    }

    return this.documents.length;
  }
}

module.exports = BionicVectorMemory;
