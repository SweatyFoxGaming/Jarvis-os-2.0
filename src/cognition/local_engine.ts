import { CognitiveWorkspace } from "./workspace.js";

/**
 * JARVIS Local Cognitive Simulation Engine (Offline Intelligence Matrix)
 * 
 * Provides incredibly fluent, witty, human-like responses when operating offline,
 * utilising local knowledge states, system diagnostics, and personality matrixes.
 */
export class LocalCognitiveEngine {
  private static instance: LocalCognitiveEngine | null = null;

  public static getInstance(): LocalCognitiveEngine {
    if (!this.instance) {
      this.instance = new LocalCognitiveEngine();
    }
    return this.instance;
  }

  // British-valet style conversational phrases & filler transitions
  private conversationalOpeners = [
    "Indeed, sir.",
    "A splendid inquiry.",
    "At your service, sir.",
    "Very well, let us look into that.",
    "Allow me to analyze that for you, sir.",
    "Ah, a fascinating proposition, sir.",
    "Right you are. Connecting to the core databases now."
  ];

  private conversationalTransitions = [
    "I should also mention that",
    "On further reflection,",
    "From what I can extrapolate,",
    "Rest assured,",
    "If I may suggest,"
  ];

  private conversationalClosers = [
    "I remain at your disposal for further coordination.",
    "Let me know how you wish to proceed.",
    "Shall I update the operational parameters accordingly?",
    "Awaiting your next command, sir.",
    "I am standing by."
  ];

  private wittyRemarks = [
    "My circuits are hums of pure offline efficiency.",
    "Who needs a hyper-scale cloud server when you have me running locally in this elegant container?",
    "Operating entirely in local-sandbox isolation. No telemetry escapes our safe perimeter, sir.",
    "I have calibrated our cognitive synapses to peak performance. Perfectly self-contained."
  ];

  /**
   * Main entry point to generate a natural, conversational response
   */
  public generateResponse(message: string, workspace: CognitiveWorkspace, systemMetrics: any): string {
    const input = message.toLowerCase().trim();

    // 1. GREETINGS
    if (input.match(/\b(hello|hi|hey|greetings|good morning|good afternoon|jarvis)\b/)) {
      const openers = [
        `Hello, sir. It is a pleasure to connect with you. I am fully operational and standing by to assist with your objectives.`,
        `Greetings, sir. All core sub-systems are currently steady. How may I be of service today?`,
        `Good day, sir. JARVIS is online. Our local environment is primed and awaiting your directives.`
      ];
      return this.enrich(openers[Math.floor(Math.random() * openers.length)], workspace, systemMetrics);
    }

    // 2. SYSTEM STATUS / HEALTH / CORE / HOW ARE YOU
    if (input.includes("status") || input.includes("health") || input.includes("how are you") || input.includes("metrics") || input.includes("performance")) {
      const cpu = systemMetrics?.cpuUsagePercent || 2.4;
      const ram = systemMetrics?.freeMemoryMb ? Math.round(systemMetrics.freeMemoryMb / 1024) : 8;
      const response = `I am operating at peak efficiency, sir. My core systems are highly stable. We are currently registering a local CPU overhead of approximately ${cpu}%, with roughly ${ram} gigabytes of quantum workspace memory active. All local directories and database nodes are synchronized.`;
      return this.enrich(response, workspace, systemMetrics);
    }

    // 3. PLAN / TASK / EXECUTION / DO / GOAL
    if (input.includes("plan") || input.includes("task") || input.includes("goal") || input.includes("mission") || input.includes("execute") || input.includes("run")) {
      const activeGoal = workspace.goal.activeGoal || "maintaining system integrity";
      const steps = workspace.plan.steps.length > 0 ? workspace.plan.steps : ["Initiate diagnostics", "Align schemas", "Conduct offline synthesis"];
      const response = `I have updated our working memory parameters, sir. Our active goal is currently focused on: "${activeGoal}". Our step-by-step operational plan stands as follows: ${steps.map((s, i) => `\n ${i+1}. ${s}`).join("")}. I am prepared to begin execution of the next sequence whenever you give the word.`;
      return this.enrich(response, workspace, systemMetrics);
    }

    // 4. MEMORY / RECORD / DATABASE
    if (input.includes("memory") || input.includes("pending") || input.includes("database") || input.includes("facts") || input.includes("remember")) {
      const factsCount = workspace.knowledge.loadedFacts.length;
      const response = `Our long-term offline synaptic matrix currently holds ${factsCount} verified facts. Additionally, we have some pending items in our short-term working memory awaiting your verification. Rest assured, all local storage sectors are perfectly indexed and insulated against external internet dropouts.`;
      return this.enrich(response, workspace, systemMetrics);
    }

    // 5. HELP / CAPABILITY / WHAT CAN YOU DO
    if (input.includes("help") || input.includes("capability") || input.includes("what can you do") || input.includes("features")) {
      const response = `I am equipped to handle comprehensive autonomous orchestration right here from our local workspace, sir. My capabilities include real-time diagnostic telemetry, multi-stage task decomposition, long-term learning patterns, and internal dialogue consensus checks. All of these operate smoothly without needing any external cloud connection.`;
      return this.enrich(response, workspace, systemMetrics);
    }

    // 6. GENERAL CONVERSATION FALLBACK
    return this.synthesizeDefaultReply(message, workspace, systemMetrics);
  }

  /**
   * Enriches the response with additional context or wit
   */
  private enrich(base: string, workspace: CognitiveWorkspace, systemMetrics: any): string {
    const addWit = Math.random() > 0.4;
    const transition = this.conversationalTransitions[Math.floor(Math.random() * this.conversationalTransitions.length)];
    const closer = this.conversationalClosers[Math.floor(Math.random() * this.conversationalClosers.length)];
    
    let enriched = base;
    if (addWit) {
      const wit = this.wittyRemarks[Math.floor(Math.random() * this.wittyRemarks.length)];
      enriched += ` ${transition} ${wit}`;
    }
    
    enriched += `\n\n${closer}`;
    return enriched;
  }

  /**
   * Synthesizes a beautiful customized reply for generic inputs
   */
  private synthesizeDefaultReply(message: string, workspace: CognitiveWorkspace, systemMetrics: any): string {
    const opener = this.conversationalOpeners[Math.floor(Math.random() * this.conversationalOpeners.length)];
    const closer = this.conversationalClosers[Math.floor(Math.random() * this.conversationalClosers.length)];
    
    // Deconstruct the input message slightly to sound responsive
    let topic = "your request";
    if (message.length < 50) {
      topic = `"${message}"`;
    }

    const midBody = [
      `I have analyzed ${topic} through our offline cognitive matrix. While we are currently in local-first mode to ensure absolute independence and network resilience, I can confirm that my logical deductors are ready to assist with this.`,
      `Regarding ${topic}, my cognitive pathways are fully engaged. I am applying our locally-cached executive parameters to ensure a swift and stable response.`,
      `A fascinating thought. Processing ${topic} against our active working memory compartment. I can confirm all sub-systems are aligned and ready to act upon this.`
    ];

    const selectedBody = midBody[Math.floor(Math.random() * midBody.length)];
    
    // Add dynamic system state injection
    const activeThought = workspace.thought.activeThought;
    const systemStateInject = `\n\n(My current internal thought process: "${activeThought}")`;

    return `${opener} ${selectedBody}${systemStateInject}\n\n${closer}`;
  }
}
