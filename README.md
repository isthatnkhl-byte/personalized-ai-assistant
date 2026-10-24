# Bionic Agent 🚀
### Sovereign Autonomous Desktop AI Copilot & Engineering Agent

Bionic Agent is a high-performance, private, sovereign AI engineering copilot that runs locally on your machine. Featuring real-time token streaming, multi-step autonomous tool execution, persistent cognitive memory (Vector + Graph RAG), and deep VS Code workspace integration.

---

## 🌟 Key Architecture & Capabilities

1. **Autonomous Engineering & VS Code Integration**
   - Automatically writes, patches, and refactors workspace files in-place with auto-backups (`.bionic_backups`).
   - Generates interactive side-by-side Myers/LCS code diff artifacts with live **"Apply"** and **"VS Code"** triggers.
   - Launches VS Code directly and opens files/diffs live on screen without command-line quotes bugs.
   - Autonomous Self-Healing loop: runs tests, inspects compiler output, and iterates fixes.

2. **Personalized Cognitive Memory Vault**
   - **Episodic Conversations**: Multi-turn conversation logs stored in `bionic_data/conversations/today/` with full thread history replay.
   - **Developer Taste Grounding**: Dynamically updates `/taste.md` reflecting your preferred frameworks, coding style, and standards.
   - **Vector & Graph RAG**: In-process semantic memory indexing and knowledge graph traversal.

3. **Frameless Minimalist UI**
   - Built to mirror the clean, distraction-free aesthetic of Antigravity & Cursor.
   - **Single-Line Thinking Accordion**: Deep cognitive thoughts auto-collapse to a clean single line (`Thought for X.Xs`) upon completion.
   - **Minimalist SVG Line Icons**: Clean line sketched icons for thinking, web grounding, and TinyFish search.
   - **Bottom Clearance Spacer**: Permanent 220px clearance ensuring no text or tool cards are ever occluded behind the floating input capsule.
   - **Dynamic Recent Conversations Panel**: Live sidebar showing recent and active conversations with search and deletion.

4. **Sovereign Local Inference Engine**
   - Powered by local `llama-server.exe` running **Qwen 2.5 Coder 3B Instruct** with an 8192 context window.
   - Zero-dependency Node.js runtime for ultra-fast, offline operation.

---

## 📁 Repository Structure

```
bionic-agent/
├── package.json               # Package configuration & scripts
├── main.js                    # Electron main process & IPC coordinator
├── preload.js                 # Secure contextBridge API bindings
├── ui/                        # Frontend UI Canvas
│   └── index.html             # Frameless Minimalist Hub UI
├── bionic/                    # Core Agent Subsystems
│   ├── index.js               # Runtime entrypoint
│   ├── agent_harness.js       # Central agent harness & thinking loop
│   ├── diff_engine.js         # Interactive code diff & VS Code engine
│   ├── memory_engine.js       # Personalized memory & chat history
│   ├── vector_memory.js       # Local vector semantic database
│   ├── graph_memory.js        # Knowledge graph RAG
│   ├── rag_engine.js          # Hybrid lexical + vector RAG
│   ├── skills_engine.js       # Skills & MCP tool coordinator
│   ├── sandbox_gateway.js     # System & web execution gateway
│   ├── vfs.js                 # Virtual File System
│   ├── agui_protocol.js       # AG-UI event streaming protocol
│   └── builtin_skills/        # Builtin system skills
├── bionic_data/               # Persistent User Memory Vault
│   ├── taste.md               # Learned coding style
│   ├── profile.md             # Developer profile
│   ├── profile.json
│   ├── contacts.json
│   └── conversations/today/   # Saved multi-turn conversation logs
├── llm/                       # Local Model Engine
│   ├── llama-server.exe       # Local inference server
│   └── *.gguf                 # Qwen 2.5 Coder model weights
├── run.bat                    # One-click Windows launch script
└── README.md
```

---

## ⚡ Quick Start

### Option 1: One-Click Run (Windows)
Double-click `run.bat` in this folder.

### Option 2: Terminal / NPM
```bash
npm start
```

### Option 3: VS Code
Open this folder in VS Code:
```bash
code .
```
Press `F5` to start debugging and launch the agent.
