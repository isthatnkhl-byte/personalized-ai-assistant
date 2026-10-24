/**
 * Bionic-GPT Unified Platform Runtime
 * Main entry point initializing VFS, Skills, Memory, RAG, Gateway & Harness
 */

const path = require('path');
const BionicVFS = require('./vfs');
const BionicSkillsEngine = require('./skills_engine');
const BionicMemoryEngine = require('./memory_engine');
const BionicRAGEngine = require('./rag_engine');
const BionicVectorMemory = require('./vector_memory');
const BionicGraphMemory = require('./graph_memory');
const BionicSandboxGateway = require('./sandbox_gateway');
const BionicDiffEngine = require('./diff_engine');
const AGUIProtocolBridge = require('./ag_ui_protocol');
const BionicAgentHarness = require('./agent_harness');

function createBionicRuntime(options = {}) {
  let rootDir = options.storageRoot;
  if (!rootDir) {
    if (__dirname.includes('app.asar')) {
      rootDir = path.join(path.dirname(process.execPath), 'bionic_data');
    } else {
      rootDir = path.join(__dirname, 'data');
    }
  }
  const builtinSkillsDir = options.builtinSkillsDir || path.join(__dirname, 'builtin_skills');

  // 1. Initialize Virtual File System
  const vfs = new BionicVFS(rootDir);

  // 2. Initialize Vector DB Semantic Memory
  const vectorMemory = new BionicVectorMemory(vfs);
  vectorMemory.reindexAll();

  // 3. Initialize Knowledge Graph Memory
  const graphMemory = new BionicGraphMemory(vfs);

  // 4. Initialize AG-UI Protocol Bridge
  const agui = new AGUIProtocolBridge(options.ipcWindow || null);

  // 5. Initialize Memory Engine (Filesystem-based + Vector + Graph)
  const memory = new BionicMemoryEngine(vfs, { vectorMemory, graphMemory });

  // 6. Initialize Skills Engine & Load Builtin Skills
  const skills = new BionicSkillsEngine(vfs, builtinSkillsDir);
  skills.loadAll();

  // 7. Initialize In-Process Hybrid RAG Engine (BM25 Lexical + Vector Semantic)
  const rag = new BionicRAGEngine(vfs, vectorMemory);

  // 8. Initialize Execution Sandbox Gateway
  const gateway = new BionicSandboxGateway(vfs);

  // 8b. Initialize Interactive Diff & Code Editing Engine
  const diffEngine = new BionicDiffEngine({
    workspaceRoot: options.workspaceRoot || path.resolve(__dirname, '..', '..', '..')
  });

  // 9. Initialize Central Agent Harness
  const harness = new BionicAgentHarness({
    vfs,
    skills,
    memory,
    rag,
    vectorMemory,
    graphMemory,
    gateway,
    diffEngine,
    agui,
    clipboard: options.clipboard || null
  });

  return {
    vfs,
    skills,
    memory,
    rag,
    vectorMemory,
    graphMemory,
    gateway,
    diffEngine,
    agui,
    harness,
    // Convenient top-level API
    execute: (userPrompt) => harness.execute(userPrompt),
    dumpVfsTree: () => vfs.dumpTree('/')
  };
}

module.exports = {
  createBionicRuntime,
  BionicVFS,
  BionicSkillsEngine,
  BionicMemoryEngine,
  BionicRAGEngine,
  BionicVectorMemory,
  BionicGraphMemory,
  BionicSandboxGateway,
  BionicDiffEngine,
  AGUIProtocolBridge,
  BionicAgentHarness
};
