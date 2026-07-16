# Phoenix Intelligence Platform (JARVIS V3)

The high-level **Executive Mind** and cognitive core for Phoenix OS (AIOS). Designed as an intelligent organization rather than a chatbot, JARVIS V3 implements a permanent executive hierarchy capable of strategic reasoning, long-term planning, and autonomous self-evolution.

## 🧠 Cognitive Architecture (V3)

Phoenix JARVIS follows a Constitution-aligned **Executive Mind** architecture. It separates the "thinking" (Executive) from the "doing" (Specialist Departments), ensuring the system can scale for decades without architectural redesign.

### 1. Executive Hierarchy
- **Executive Mind**: The cognitive core. It performs strategic reasoning, intent analysis, and goal management.
- **Executive Board**: An internal reasoning council of specialized engines (Strategy, Planning, Risk, Resource, Context, Memory, Ethics, World Model).
- **Chief of Staff**: The operational orchestrator. It transforms executive decisions into coordinated department tasks.
- **Capability Registry**: The platform's nervous system. It maps strategic requirements to specialized departmental skills.

### 2. Multi-Agent Organization
- **Commander (Personality Layer)**: The primary interface. It handles general chat, maintains the JARVIS persona (calm, capable, professional), and orchestrates tasks by delegating to specialized agents or calling system functions.
- **Research Agent**: Specialized in multi-source information gathering. It integrates **real-time web search** (via Brave Search API) and cross-references results with local memory.
- **Coding Agent**: Specialized in code analysis, debugging, and review. It is pre-seeded with knowledge of the Phoenix OS (Rust/no_std) kernel architecture.
- **Planning Agent**: Decomposes complex, multi-stage requests into structured action plans.
- **Security Agent**: Audits every request against a capability-based security model before execution.
- **Memory Agent**: Manages hierarchical retrieval (Episodic + Semantic) and autonomous experience summarization.
- **Self-Improvement Agent**: Oversees the reflection and meta-learning cycles to refine system prompts and behavioral logic.

### 2. Universal Multi-lingual Specialist
JARVIS is pre-seeded with core principles for **Rust, C, C++, Python, JS, Go, Java, and Assembly**. If you request assistance with a technology it hasn't mastered yet, JARVIS will autonomously trigger its research swarm to onboard the new language or framework before assisting you.

### 3. Agent Workflow (The Chain of Command)
When you issue a request to the **Commander [Mode 0]**, the following lifecycle occurs:
1. **Security Audit**: The Security Agent checks the request for risks or unauthorized system commands.
2. **Strategic Planning**: The Planning Agent breaks the request into logical steps (e.g., "Step 1: Research X, Step 2: Write code for Y").
3. **Contextual Retrieval**: The Memory Agent pulls relevant history and facts to "prime" the executing agents.
4. **Delegated Execution**: The Commander dispatches tasks to the Research or Coding agents.
5. **System Interaction**: If a system command is needed, the Commander uses the Synapse Bridge to talk to the Phoenix OS kernel.
6. **Introspective Reflection**: The Self-Improvement Agent extracts a lesson from the result to improve future performance.

### 3. Dual-Tier Memory System
Memory is stored in a local SQLite database (`data/memory.db`) to ensure persistence and low memory overhead:
- **Episodic Memory**: A rolling history of specific interactions, including prompts, responses, and autonomous reflections.
- **Semantic Memory**: A permanent Knowledge Base of distilled facts, rules, and system principles.

## 📈 Self-Improvement Cycle

JARVIS is designed to get smarter with every use without the need for high-resource model retraining.

### Phase 1: Active Reflection
Immediately after an interaction, the **Reflection Module** analyzes the performance and extracts a "Lesson Learned." This lesson is stored in episodic memory and automatically injected into future prompts for immediate "behavioral" improvement.

### Phase 2: Sleep-Learning (Semantic Consolidation)
By selecting **Mode [4]**, the system enters "Sleep-Learning." It iterates through recent episodic reflections and uses the LLM to distill them into permanent, high-density factual statements in the **Semantic Knowledge Base**. This allows the model to "learn" new rules and facts permanently.

### Observation does NOT think, plan,execute, remember, It only observes.

## 🔌 System Integration

### Synapse IPC Bridge
The engine includes a `SynapseBridge` that follows the Phoenix OS Synapse specification. It allows the LLM to send structured messages to the kernel (e.g., `SYSTEM_CALL` for stats, file listing, or power management).

### Knowledge Seeding
The `src/seed_knowledge.py` script allows JARVIS to ingest core system documentation directly from the Phoenix OS repository, ensuring it understands the operating system it is running on.

## 🚀 Installation & Usage (Ubuntu Linux)

### 1. Clone & Enter Directory
```bash
git clone https://github.com/SweatyFoxGaming/llm.git
cd llm
```

### 2. Install System Dependencies
JARVIS requires specific build tools and system libraries to run its AI engine on Ubuntu:
```bash
sudo apt update
sudo apt install -y build-essential cmake python3-pip python3-venv python3-dev \
                    python3-pyqt6 espeak libportaudio2 portaudio19-dev python3-all-dev
```

### 3. Setup Virtual Environment
It is highly recommended to use a virtual environment on Linux:
```bash
python3 -m venv venv
source venv/bin/activate
```

### 4. Install Python Dependencies
**Important**: Ensure you are in the `llm` folder where `requirements.txt` is located:
```bash
pip3 install -r requirements.txt
```

### 5. Configuration
- **Model**: JARVIS now automatically downloads the **Dolphin-Phi-2** model on first launch. No manual download is required.
- **API Keys**: Add your `BRAVE_API_KEY` to the `.env` file.
- **Seed Knowledge**: Run `export PYTHONPATH=$PYTHONPATH:. && python3 src/seed_knowledge.py` to ingest AIOS docs.

### 6. Run JARVIS
```bash
python3 src/main.py
```

### 7. Build & Install as a Desktop App (Ubuntu)
**Important**: You must have the virtual environment activated (`source venv/bin/activate`) before running this:
```bash
chmod +x build.sh
./build.sh
```
This will package the app and create a launcher so you can open JARVIS just like Firefox.

## 🛠️ Troubleshooting Installation

If you encounter errors during `pip3 install`:

1. **Error: "Failed building wheel for llama-cpp-python"**:
   Ensure you installed `build-essential` and `cmake`. These are required to compile the engine.

2. **Error: "externally-managed-environment"**:
   You are trying to install to the system python. Ensure you created and activated the **Virtual Environment** (Step 2).

3. **Memory Issues during pip install**:
   Try running the install with a lower thread count:
   ```bash
   pip3 install --no-cache-dir -r requirements.txt
   ```

4. **Error: "Failed to fetch" or "Hash Sum mismatch" (sudo apt update)**:
   This usually means the Ubuntu mirror you are using is currently syncing or broken. Try cleaning your cache and updating again:
   ```bash
   sudo rm -rf /var/lib/apt/lists/*
   sudo apt update
   ```
   If it still fails, you can try changing your download server in Ubuntu's "Software & Updates" settings.

### CLI Modes:
- `[0] Commander`: Full JARVIS orchestration (Auto-delegation).
- `[1] Research`: Manual web research and info gathering.
- `[2] Coding`: Manual code analysis and review.
- `[3] Reflect`: Manually trigger reflection on the last interaction.
- `[4] Sleep-Learn`: Trigger semantic consolidation of all recent lessons.
