/**
 * Bionic-GPT Knowledge Graph Memory Engine
 * Implements Entity-Relation-Entity Graph Traversal & Bi-Temporal Semantic Triples
 * Based on Graph-RAG (arxiv.org/abs/2404.16130) and Personal Knowledge Graphs
 */

class BionicGraphMemory {
  constructor(vfs, options = {}) {
    this.vfs = vfs;
    this.storagePath = '/memory/knowledge_graph.json';
    this.nodes = new Map(); // id -> { id, label, type, properties }
    this.edges = [];        // { id, source, target, predicate, weight, properties }
    this.loadGraph();
  }

  // Load graph from VFS or seed default knowledge graph
  loadGraph() {
    if (!this.vfs) {
      this.seedDefaultGraph();
      return;
    }

    try {
      const stored = this.vfs.readJson(this.storagePath, null);
      if (stored && Array.isArray(stored.nodes) && Array.isArray(stored.edges)) {
        this.nodes.clear();
        for (const n of stored.nodes) {
          this.nodes.set(n.id.toLowerCase(), n);
        }
        this.edges = stored.edges;
      } else {
        this.seedDefaultGraph();
      }
    } catch {
      this.seedDefaultGraph();
    }
  }

  // Persist graph to VFS
  saveGraph() {
    if (!this.vfs) return;
    try {
      this.vfs.writeJson(this.storagePath, {
        savedAt: new Date().toISOString(),
        nodeCount: this.nodes.size,
        edgeCount: this.edges.length,
        nodes: Array.from(this.nodes.values()),
        edges: this.edges
      });
    } catch {}
  }

  // Seed default knowledge graph with user & system entities
  seedDefaultGraph() {
    this.addNode('krishna_maheshwari', 'Krishna Maheshwari', 'Person', { role: 'Founder & Lead Engineer', tone: 'concise and professional' });
    this.addNode('bionic_gpt', 'Bionic-GPT', 'Agent', { type: 'Autonomous Personal Assistant', version: '2.0' });
    this.addNode('wispr_flow', 'Wispr Flow', 'Product', { type: 'Voice-to-Text & Desktop Agent Platform' });
    this.addNode('qwen_2_5_coder', 'Qwen 2.5 Coder 3B', 'Model', { role: 'Primary Local Sovereign LLM', context: 4096 });
    this.addNode('tinyfish', 'TinyFish', 'Tool', { type: 'Real-time Web Search & Clean Scraping Agent' });
    this.addNode('antigravity', 'Antigravity Protocol', 'Framework', { type: 'AG-UI Protocol & Token Streaming' });
    this.addNode('vector_db', 'Vector DB', 'Architecture', { type: 'Cosine Similarity Semantic Memory' });
    this.addNode('knowledge_graph', 'Knowledge Graph', 'Architecture', { type: 'Entity-Relation-Entity Multi-Hop Graph Memory' });
    this.addNode('vfs', 'Bionic VFS', 'Architecture', { type: 'Sandboxed Virtual File System with SSRF Protection' });

    // Seed Edges
    this.addEdge('krishna_maheshwari', 'bionic_gpt', 'FOUNDED_AND_LEADS');
    this.addEdge('krishna_maheshwari', 'wispr_flow', 'BUILT');
    this.addEdge('bionic_gpt', 'qwen_2_5_coder', 'POWERED_BY');
    this.addEdge('bionic_gpt', 'tinyfish', 'SEARCHES_WEB_VIA');
    this.addEdge('bionic_gpt', 'antigravity', 'FOLLOWS_PROTOCOL');
    this.addEdge('bionic_gpt', 'vector_db', 'EMBEDS_MEMORY_WITH');
    this.addEdge('bionic_gpt', 'knowledge_graph', 'REASONS_OVER');
    this.addEdge('bionic_gpt', 'vfs', 'STORES_DATA_IN');
    this.addEdge('wispr_flow', 'bionic_gpt', 'HOSTS_COPILOT');

    this.saveGraph();
  }

  // Add or update node
  addNode(id, label, type = 'Entity', properties = {}) {
    const key = (id || label).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const existing = this.nodes.get(key) || {};
    const node = {
      id: key,
      label: label || id,
      type: type || existing.type || 'Entity',
      properties: { ...(existing.properties || {}), ...properties },
      updatedAt: new Date().toISOString()
    };
    this.nodes.set(key, node);
    return node;
  }

  // Add edge between two nodes
  addEdge(sourceId, targetId, predicate, properties = {}, weight = 1.0) {
    const srcKey = sourceId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const tgtKey = targetId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

    // Ensure nodes exist
    if (!this.nodes.has(srcKey)) this.addNode(srcKey, sourceId);
    if (!this.nodes.has(tgtKey)) this.addNode(tgtKey, targetId);

    const edgeId = `${srcKey}--[${predicate}]-->${tgtKey}`;
    const existingIdx = this.edges.findIndex(e => e.id === edgeId);

    const edge = {
      id: edgeId,
      source: srcKey,
      target: tgtKey,
      predicate: predicate.toUpperCase(),
      weight,
      properties,
      updatedAt: new Date().toISOString()
    };

    if (existingIdx !== -1) {
      this.edges[existingIdx] = edge;
    } else {
      this.edges.push(edge);
    }

    this.saveGraph();
    return edge;
  }

  // Find node by label, name, or alias
  findNode(text) {
    const clean = text.toLowerCase().trim();
    if (this.nodes.has(clean)) return this.nodes.get(clean);

    for (const node of this.nodes.values()) {
      if (node.label.toLowerCase() === clean) return node;
      if (node.label.toLowerCase().includes(clean) || clean.includes(node.label.toLowerCase())) {
        return node;
      }
    }
    return null;
  }

  // Extract entity candidates from prompt
  extractEntitiesFromText(text) {
    const clean = (text || '').toLowerCase();
    const matched = [];

    for (const node of this.nodes.values()) {
      const labelLower = node.label.toLowerCase();
      if (labelLower.length >= 3 && clean.includes(labelLower)) {
        matched.push(node);
      }
    }
    return matched;
  }

  // 1-hop & 2-hop neighborhood expansion over Knowledge Graph
  queryGraph(userPrompt, maxHops = 2, maxResults = 8) {
    const seedNodes = this.extractEntitiesFromText(userPrompt);
    if (seedNodes.length === 0) return { matchedEntities: [], relationships: [], formattedContext: '' };

    const visitedNodes = new Set();
    const traversedEdges = [];

    // Queue of { nodeId, hop }
    const queue = seedNodes.map(n => ({ nodeId: n.id, hop: 0 }));
    seedNodes.forEach(n => visitedNodes.add(n.id));

    while (queue.length > 0 && traversedEdges.length < maxResults) {
      const { nodeId, hop } = queue.shift();
      if (hop >= maxHops) continue;

      // Find outbound and inbound edges
      for (const edge of this.edges) {
        if (edge.source === nodeId) {
          traversedEdges.push(edge);
          if (!visitedNodes.has(edge.target)) {
            visitedNodes.add(edge.target);
            queue.push({ nodeId: edge.target, hop: hop + 1 });
          }
        } else if (edge.target === nodeId) {
          traversedEdges.push(edge);
          if (!visitedNodes.has(edge.source)) {
            visitedNodes.add(edge.source);
            queue.push({ nodeId: edge.source, hop: hop + 1 });
          }
        }
      }
    }

    // Format knowledge subgraph into readable relationship triples
    const triples = [];
    for (const edge of traversedEdges) {
      const srcNode = this.nodes.get(edge.source);
      const tgtNode = this.nodes.get(edge.target);
      if (srcNode && tgtNode) {
        triples.push(`(${srcNode.label}) -[${edge.predicate}]-> (${tgtNode.label})`);
      }
    }

    let formattedContext = '';
    if (triples.length > 0) {
      formattedContext = '## KNOWLEDGE GRAPH RELATIONS (GRAPH-RAG MEMORY):\n' +
        triples.map(t => `- ${t}`).join('\n') + '\n';
    }

    return {
      matchedEntities: seedNodes.map(n => ({ id: n.id, label: n.label, type: n.type })),
      relationships: triples,
      formattedContext
    };
  }

  // Learn a fact triple from conversation or observation
  learnTriple(subject, predicate, object, properties = {}) {
    return this.addEdge(subject, object, predicate, properties);
  }
}

module.exports = BionicGraphMemory;
