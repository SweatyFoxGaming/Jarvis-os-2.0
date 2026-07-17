/**
 * Pass 10: Polishing frontend interaction & state synchronization for `/mind` route
 */

// Shares the same sessionStorage key as admin.html so logging in once
// carries over — never ship a real credential in static JS.
function getApiKey() {
    let key = sessionStorage.getItem('admin_api_key');
    if (!key) {
        key = window.prompt('Enter your Jarvis API key:') || '';
        if (key) sessionStorage.setItem('admin_api_key', key);
    }
    return key;
}

const API_KEY = getApiKey();

const NODES = [
    { id: 'user', label: 'User', type: 'user', color: '#6a8cff' },
    { id: 'conversation', label: 'Conversation', type: 'conversation', color: '#8899cc' },
    { id: 'intent', label: 'Intent', type: 'executive', color: '#4a8fc7' },
    { id: 'goals', label: 'Goals', type: 'executive', color: '#4a8fc7' },
    { id: 'strategy', label: 'Strategy', type: 'executive', color: '#4a8fc7' },
    { id: 'planner', label: 'Planner', type: 'executive', color: '#4a8fc7' },
    { id: 'decision', label: 'Decision Engine', type: 'executive', color: '#4a8fc7' },
    { id: 'delegation', label: 'Delegation', type: 'executive', color: '#4a8fc7' },
    { id: 'execution', label: 'Execution', type: 'execution', color: '#4CAF50' },
    { id: 'reflection', label: 'Reflection', type: 'cognitive', color: '#9C27B0' },
    { id: 'learning', label: 'Learning', type: 'cognitive', color: '#9C27B0' },
    { id: 'knowledge', label: 'Knowledge', type: 'cognitive', color: '#9C27B0' },
    { id: 'workspace', label: 'Workspace', type: 'cognitive', color: '#9C27B0' },
    { id: 'memory', label: 'Memory', type: 'cognitive', color: '#9C27B0' },
    { id: 'capability_platform', label: 'Capability Platform', type: 'capability', color: '#FF9800' },
    { id: 'capability_resolver', label: 'Capability Resolver', type: 'capability', color: '#FF9800' },
    { id: 'capability_registry', label: 'Capability Registry', type: 'capability', color: '#FF9800' },
    { id: 'scheduler', label: 'Scheduler', type: 'execution', color: '#4CAF50' },
    { id: 'event_bus', label: 'Event Bus', type: 'infrastructure', color: '#78909C' },
    { id: 'system', label: 'System', type: 'infrastructure', color: '#78909C' },
];

const EDGES = [
    { source: 'user', target: 'conversation' },
    { source: 'conversation', target: 'intent' },
    { source: 'intent', target: 'goals' },
    { source: 'goals', target: 'strategy' },
    { source: 'strategy', target: 'planner' },
    { source: 'planner', target: 'decision' },
    { source: 'decision', target: 'delegation' },
    { source: 'delegation', target: 'execution' },
    { source: 'execution', target: 'capability_platform' },
    { source: 'capability_platform', target: 'capability_resolver' },
    { source: 'capability_resolver', target: 'capability_registry' },
    { source: 'capability_platform', target: 'scheduler' },
    { source: 'scheduler', target: 'execution' },
    { source: 'execution', target: 'reflection' },
    { source: 'reflection', target: 'learning' },
    { source: 'learning', target: 'knowledge' },
    { source: 'knowledge', target: 'workspace' },
    { source: 'workspace', target: 'memory' },
    { source: 'memory', target: 'goals' },
    { source: 'event_bus', target: 'execution' },
    { source: 'event_bus', target: 'delegation' },
    { source: 'system', target: 'event_bus' },
    { source: 'system', target: 'capability_registry' },
];

// ---- Cytoscape Graph Initialization ----
const graphContainer = document.getElementById('mind-graph');

const cy = cytoscape({
    container: graphContainer,
    elements: [
        ...NODES.map(n => ({ data: { id: n.id, label: n.label, type: n.type, color: n.color } })),
        ...EDGES.map(e => ({ data: { source: e.source, target: e.target } })),
    ],
    style: [
        {
            selector: 'node',
            style: {
                'background-color': 'data(color)',
                'width': 44,
                'height': 44,
                'border-width': 2,
                'border-color': 'rgba(255,255,255,0.15)',
                'label': 'data(label)',
                'font-size': '10px',
                'color': '#b0c8e8',
                'text-valign': 'bottom',
                'text-halign': 'center',
                'text-margin-y': 10,
                'text-max-width': 80,
                'text-wrap': 'wrap',
                'text-justification': 'center',
            },
        },
        {
            selector: 'edge',
            style: {
                'width': 1.5,
                'line-color': 'rgba(120,160,255,0.2)',
                'curve-style': 'bezier',
                'target-arrow-shape': 'none',
                'opacity': 0.6,
            },
        },
        {
            selector: 'node.user',
            style: {
                'background-color': '#6a8cff',
                'border-color': '#6a8cff',
                'width': 52,
                'height': 52,
                'font-size': '11px',
            },
        },
    ],
    layout: {
        name: 'cose',
        idealEdgeLength: 80,
        nodeRepulsion: 600,
        gravity: 0.2,
        numIter: 1000,
        animate: false,
    },
    zoom: 0.75,
    pan: { x: 0, y: -10 },
    minZoom: 0.4,
    maxZoom: 1.4,
});

// ---- Node State Management ----
const nodeStates = {};

function setNodeState(nodeId, state, duration = 1500) {
    const node = cy.getElementById(nodeId);
    if (!node.length) return;

    const colors = {
        idle: NODES.find(n => n.id === nodeId)?.color || '#4a8fc7',
        thinking: '#ffffff',
        planning: '#FFD700',
        learning: '#9C27B0',
        executing: '#4CAF50',
        warning: '#FFA726',
        failure: '#EF5350',
        sleeping: '#80DEEA',
    };

    const bg = colors[state] || colors.idle;
    node.style('background-color', bg);
    if (state === 'thinking') {
        node.style('border-color', '#ffffff');
        node.style('border-width', 4);
    } else {
        node.style('border-color', 'rgba(255,255,255,0.15)');
        node.style('border-width', 2);
    }

    nodeStates[nodeId] = { state, timestamp: Date.now() };
}

// ---- Micro Animations ----
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function animateThinking() {
    const path = ['user', 'conversation', 'intent', 'goals', 'strategy', 'planner', 'decision', 'delegation', 'execution'];
    NODES.forEach(n => setNodeState(n.id, 'idle'));
    for (const id of path) {
        setNodeState(id, 'thinking', 500);
        await sleep(200);
    }
}

// ---- Node Click: Show Info Panel ----
const infoPanel = document.getElementById('info-panel');
const infoTitle = document.getElementById('info-title');
const infoContent = document.getElementById('info-content');
const infoClose = document.getElementById('info-close');

cy.on('tap', 'node', async (evt) => {
    const node = evt.target;
    const id = node.id();
    const data = node.data();
    const label = data.label || id;

    infoTitle.textContent = label;
    infoPanel.classList.remove('hidden');

    try {
        const headers = { 'X-API-Key': API_KEY };
        const res = await fetch('/api/cognition/workspace', { headers });
        if (res.ok) {
            const ws = await res.json();
            
            let contextSpecificHTML = '';
            if (id === 'goals') {
                contextSpecificHTML = `
                    <div class="label">Primary Active Objective</div>
                    <div class="value" style="color: #FF9800;">${ws.goal.activeGoal}</div>
                    <div class="label">Priority Rating</div>
                    <div class="value">${ws.goal.priority}/10</div>
                `;
            } else if (id === 'execution') {
                contextSpecificHTML = `
                    <div class="label">Active Task</div>
                    <div class="value">${ws.execution.activeTask || 'None'}</div>
                    <div class="label">State Status</div>
                    <div class="value" style="color: #4CAF50; font-weight: 600;">${ws.execution.status.toUpperCase()}</div>
                `;
            } else if (id === 'knowledge') {
                contextSpecificHTML = `
                    <div class="label">Active Knowledge Facts</div>
                    <div class="value">${ws.knowledge.factsCount} rules integrated in-memory</div>
                `;
            } else if (id === 'workspace') {
                contextSpecificHTML = `
                    <div class="label" style="font-weight: bold; color: #8ab4f8; margin-bottom: 8px;">Cognitive Workspace 2.0 (9 Working Memory Compartments)</div>
                    <div style="border-left: 2px solid rgba(120, 160, 255, 0.3); padding-left: 10px; margin-bottom: 8px;">
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">1. Current Mission</div>
                        <div class="value" style="color: #FFD700; font-size: 0.8rem;">${ws.mission?.currentMission || 'N/A'} (Progress: ${ws.mission?.progressPercent || 0}%)</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">2. Current Thought</div>
                        <div class="value" style="font-style: italic; font-size: 0.8rem;">"${ws.thought?.activeThought || 'N/A'}"</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">3. Current Goal</div>
                        <div class="value" style="color: #6a8cff; font-size: 0.8rem;">${ws.goal?.activeGoal || 'N/A'} (Priority: ${ws.goal?.priority || 0})</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">4. Current Plan</div>
                        <div class="value" style="font-size: 0.8rem;">${(ws.plan?.steps || []).join(' ➔ ') || 'N/A'} (Status: ${ws.plan?.status || 'idle'})</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">5. Current Environment</div>
                        <div class="value" style="font-size: 0.8rem;">Host OS: ${ws.environment?.osType || 'N/A'} | Network: ${ws.environment?.networkConnected ? 'Connected' : 'Disconnected'}</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">6. Current User Context</div>
                        <div class="value" style="font-size: 0.8rem;">${ws.userContext?.factsCount || 0} Facts Integrated | ${ws.userContext?.historyLength || 0} Chat Messages</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">7. Active Capabilities</div>
                        <div class="value" style="color: #FF9800; font-size: 0.8rem;">Selected: ${ws.capabilities?.selectedCapability || 'None'}</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">8. Attention Focus</div>
                        <div class="value" style="color: #4CAF50; font-size: 0.8rem;">Files: ${(ws.attention?.focusedFiles || []).join(', ') || 'None'}</div>
                        
                        <div class="label" style="margin-top: 4px; font-size: 0.65rem; color: rgba(255,255,255,0.4);">9. Reasoning State</div>
                        <div class="value" style="font-size: 0.8rem;">Thought: ${ws.reasoningState?.currentThought || 'None'} (Confidence: ${Math.round((ws.reasoningState?.confidenceScore || 0) * 100)}%)</div>
                    </div>
                `;
            }

            infoContent.innerHTML = `
                <div class="label">Bound Subsystem</div>
                <div class="value">${id} (Type: ${data.type || 'unknown'})</div>
                ${contextSpecificHTML}
                <div class="label">Functional Boundary</div>
                <div class="value">${getNodeDescription(id)}</div>
            `;
        } else {
            throw new Error();
        }
    } catch {
        infoContent.innerHTML = `
            <div class="label">ID</div><div class="value">${id}</div>
            <div class="label">Type</div><div class="value">${data.type || 'unknown'}</div>
            <div class="label">Boundary Description</div><div class="value">${getNodeDescription(id)}</div>
        `;
    }
});

infoClose.addEventListener('click', () => {
    infoPanel.classList.add('hidden');
});

function getNodeDescription(id) {
    const desc = {
        user: 'The human operator. The source of all interactions.',
        conversation: 'The current dialogue between Jarvis and the user.',
        intent: 'Interpretation of the user\'s goal and urgency.',
        goals: 'Active objectives. Each goal has a budget and priority.',
        strategy: 'High‑level plan to achieve the goals.',
        planner: 'Breaks goals into executable tasks.',
        decision: 'Commits to a specific course of action.',
        delegation: 'Directs tasks to capabilities and execution.',
        execution: 'Runs tasks, handles retries, monitors progress.',
        reflection: 'Reviews outcomes and identifies lessons.',
        learning: 'Integrates new knowledge and patterns.',
        knowledge: 'Stores facts, procedures, preferences, relationships.',
        workspace: 'Current mental state of Jarvis.',
        memory: 'Long‑term storage with semantic search.',
        capability_platform: 'Abstraction over all capabilities.',
        capability_resolver: 'Selects the best capability for a task.',
        capability_registry: 'Stores manifests and health of capabilities.',
        scheduler: 'Coordinates task timing and resource allocation.',
        event_bus: 'Central communication bus for all components.',
        system: 'The underlying operating system and infrastructure.',
    };
    return desc[id] || 'No description available.';
}

// ---- Conversation ----
const messagesContainer = document.getElementById('conversation-messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.textContent = text;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function handleSend() {
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = '';
    addMessage(text, 'user');

    await animateThinking();

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify({ message: text })
        });

        if (!response.ok) throw new Error();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantMessageDiv = null;
        let fullAssistantText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataStr = line.slice(6).trim();
                    if (dataStr === "[DONE]") break;
                    if (dataStr.startsWith("detail: ")) continue;

                    if (!assistantMessageDiv) {
                        assistantMessageDiv = document.createElement('div');
                        assistantMessageDiv.className = 'message assistant';
                        messagesContainer.appendChild(assistantMessageDiv);
                    }
                    fullAssistantText += dataStr;
                    assistantMessageDiv.textContent = fullAssistantText;
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
            }
        }
    } catch (err) {
        addMessage("Communication severed.", "assistant");
    }
}

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
});

// ---- Live Drift Animation ----
setInterval(() => {
    cy.nodes().forEach(node => {
        node.position({
            x: node.position('x') + (Math.random() - 0.5) * 1.5,
            y: node.position('y') + (Math.random() - 0.5) * 1.5,
        });
    });
}, 5000);

// ---- Warmup ----
setTimeout(() => {
    ['executive', 'cognitive', 'capability_platform', 'memory'].forEach(id => {
        setNodeState(id, 'idle');
    });
}, 500);

console.log('🧠 The Living Mind UI initialized.');
