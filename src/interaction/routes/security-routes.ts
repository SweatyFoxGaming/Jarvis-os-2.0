import { Router } from "express";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as securityRepo from "../../kernel/state/security-repo.js";
import * as scheduler from "../../kernel/scheduler.js";
import * as commandProposalsRepo from "../../kernel/state/command-proposals-repo.js";
import * as mcpServersRepo from "../../kernel/state/mcp-servers-repo.js";
import * as mcpRegistry from "../../capabilities/mcp-registry.js";

const observation = ObservationPlatform.getInstance();

export const securityRouter = Router();

// ---------- Security Ops (human-gated) ----------
// Jarvis observes and proposes here; it never applies anything itself.
// Ingest routes are called by trusted host-side scanner scripts
// (scripts/security/*.sh, run outside Docker via cron) using the same
// INTERNAL_API_KEY as any other caller — no separate auth mechanism, no new
// privileges for the chat-facing container.
securityRouter.post("/api/security/ingest/devices", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const devices = req.body.devices;
  if (!Array.isArray(devices)) return res.status(400).json({ error: "devices must be an array" });
  try {
    let newCount = 0;
    const newDeviceNames: string[] = [];
    for (const d of devices) {
      if (!d.mac || !d.ip) continue;
      const { isNew } = await securityRepo.upsertNetworkDevice(d.mac, d.ip, d.hostname || null, d.vendor || null);
      if (isNew) {
        newCount++;
        newDeviceNames.push(d.hostname || d.vendor || d.mac);
        await securityRepo.addFinding(
          "network_device",
          "info",
          `New device on network: ${d.hostname || d.vendor || d.mac}`,
          `MAC ${d.mac} (${d.vendor || "unknown vendor"}) first seen at ${d.ip}. Acknowledge it in the dashboard if this is expected.`,
          "network_scan"
        );
      }
    }
    // upsertNetworkDevice's own isNew flag is already genuine per-device
    // newness tracking (unlike findings below, which need their own dedup
    // check) — safe to notify on every batch that actually found something new.
    if (newCount > 0) {
      scheduler.pushNotification(
        "admin",
        newCount === 1
          ? `New device on the network: ${newDeviceNames[0]}, sir.`
          : `${newCount} new devices appeared on the network: ${newDeviceNames.join(", ")}.`,
        "warning"
      );
    }
    res.json({ ingested: devices.length, newDevices: newCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.post("/api/security/ingest/findings", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const findings = req.body.findings;
  if (!Array.isArray(findings)) return res.status(400).json({ error: "findings must be an array" });
  try {
    // host_scan.sh reports the *current* state on every run (e.g. "126
    // pending updates" every single scan), not a diff — addFinding() has no
    // dedup of its own, so without this check a genuinely ongoing condition
    // would notify fresh every scan cycle instead of just once when it's
    // actually new.
    const openFindings = await securityRepo.getFindings("open");
    const alreadyOpen = new Set(openFindings.map(f => `${f.category}::${f.title}`));

    const created = [];
    const newHighSeverity: string[] = [];
    for (const f of findings) {
      if (!f.category || !f.severity || !f.title || !f.description) continue;
      const isGenuinelyNew = !alreadyOpen.has(`${f.category}::${f.title}`);
      const finding = await securityRepo.addFinding(f.category, f.severity, f.title, f.description, f.source || "host_scan");
      if (f.proposedAction) {
        await securityRepo.addProposal(finding.id, f.proposedAction, f.proposedCommand || null);
      }
      if (isGenuinelyNew && f.severity === "high") {
        newHighSeverity.push(f.title);
      }
      created.push(finding.id);
    }
    if (newHighSeverity.length > 0) {
      scheduler.pushNotification(
        "admin",
        newHighSeverity.length === 1
          ? `New security finding, sir: ${newHighSeverity[0]}.`
          : `${newHighSeverity.length} new security findings, sir: ${newHighSeverity.join("; ")}.`,
        "warning"
      );
    }
    res.json({ created: created.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.get("/api/security/devices", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ devices: await securityRepo.getNetworkDevices() });
  } catch (err: any) {
    res.json({ devices: [], error: err.message });
  }
});

securityRouter.post("/api/security/devices/:mac/acknowledge", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  try {
    const updated = await securityRepo.acknowledgeDevice(req.params.mac);
    if (!updated) return res.status(404).json({ error: "Device not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.get("/api/security/findings", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ findings: await securityRepo.getFindings(req.query.status as securityRepo.FindingStatus | undefined) });
  } catch (err: any) {
    res.json({ findings: [], error: err.message });
  }
});

securityRouter.post("/api/security/findings/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const { status } = req.body;
  const valid: securityRepo.FindingStatus[] = ["open", "acknowledged", "resolved"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  try {
    const updated = await securityRepo.updateFindingStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Finding not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.get("/api/security/proposals", validateApiKey, async (req: any, res: any) => {
  try {
    res.json({ proposals: await securityRepo.getProposals(req.query.status as securityRepo.ProposalStatus | undefined) });
  } catch (err: any) {
    res.json({ proposals: [], error: err.message });
  }
});

// Approving/rejecting ONLY changes status — nothing here ever executes
// proposed_command. Real execution, if the user wants it, is a manual step
// they take themselves outside this app.
securityRouter.post("/api/security/proposals/:id/status", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "security.manage")) {
    return res.status(403).json({ error: 'Missing capability grant "security.manage"' });
  }
  const { status } = req.body;
  const valid: securityRepo.ProposalStatus[] = ["pending", "approved", "rejected"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
  try {
    const updated = await securityRepo.updateProposalStatus(Number(req.params.id), status);
    if (!updated) return res.status(404).json({ error: "Proposal not found" });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Command Execution (the single most consequential capability in
// this codebase — see propose_command in src/execution/tools.ts, and
// scripts/security/command_executor.sh, which is the ONLY thing that ever
// actually runs a command, and only ever a HOST-side script, never this
// chat-facing container). Every row requires the user's own fresh approval;
// nothing here auto-approves or auto-executes anything. ----------
securityRouter.get("/api/system/commands", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    res.json({ commands: await commandProposalsRepo.getCommandProposals(req.query.status as commandProposalsRepo.CommandProposalStatus | undefined) });
  } catch (err: any) {
    res.json({ commands: [], error: err.message });
  }
});

securityRouter.post("/api/system/commands/:id/approve", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.setCommandDecision(Number(req.params.id), "approved");
    if (!updated) return res.status(404).json({ error: "Command not found or not pending" });
    observation.logAuditEvent(req.username, "command_approved", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.post("/api/system/mcp-servers/:id/approve", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const result = await mcpRegistry.approveMcpServer(Number(req.params.id));
    if (!result.ok) {
      observation.logAuditEvent(req.username, "mcp_server_approve_failed", "failed", result.error);
      return res.status(422).json({ error: result.error });
    }
    await permissions.loadGrantsFromDb(); // backfill admin for this server's newly-cached tools immediately
    observation.logAuditEvent(req.username, "mcp_server_approved", "success", `#${result.server.id}: ${result.server.name}`);
    res.json(result.server);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.post("/api/system/mcp-servers/:id/disable", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.mcp_manage")) {
    return res.status(403).json({ error: 'Missing capability grant "system.mcp_manage"' });
  }
  try {
    const updated = await mcpServersRepo.setMcpServerStatus(Number(req.params.id), "disabled");
    if (!updated) return res.status(404).json({ error: "Server not found" });
    mcpRegistry.evictFromToolCache(updated.id); // drop cached tools immediately instead of waiting on the next health-check cycle
    observation.logAuditEvent(req.username, "mcp_server_disabled", "success", `#${updated.id}: ${updated.name}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

securityRouter.post("/api/system/commands/:id/reject", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.setCommandDecision(Number(req.params.id), "rejected");
    if (!updated) return res.status(404).json({ error: "Command not found or not pending" });
    observation.logAuditEvent(req.username, "command_rejected", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lets you back out of an already-approved command that hasn't run yet —
// e.g. approved by mistake, or you changed your mind. Cannot touch a command
// the executor has already claimed (cancelApprovedCommand only matches
// status = 'approved'; claim() has already flipped it to 'running' by then).
securityRouter.post("/api/system/commands/:id/cancel", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const updated = await commandProposalsRepo.cancelApprovedCommand(Number(req.params.id));
    if (!updated) return res.status(404).json({ error: "Command not found, not approved, or already claimed for execution" });
    observation.logAuditEvent(req.username, "command_cancelled", "success", `#${updated.id}: ${updated.command}`);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Called only by the host-side executor script — atomically claims exactly
// one approved command (approved -> running) so an overlapping executor run
// can never pick up and run the same command twice.
securityRouter.post("/api/system/commands/claim", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  try {
    const claimed = await commandProposalsRepo.claimApprovedCommand();
    if (!claimed) return res.json({ command: null });
    res.json({ command: claimed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Called only by the host-side executor script, after it actually ran a
// claimed command — reports the real output/exit code back.
securityRouter.post("/api/system/ingest/command-result", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "system.execute")) {
    return res.status(403).json({ error: 'Missing capability grant "system.execute"' });
  }
  const { id, output, exitCode } = req.body;
  if (typeof id !== "number" || typeof exitCode !== "number") {
    return res.status(400).json({ error: "id (number) and exitCode (number) are required" });
  }
  try {
    const updated = await commandProposalsRepo.recordCommandResult(id, output || "", exitCode);
    if (!updated) return res.status(404).json({ error: "Command not found" });
    // A nonzero exit is already an unambiguous outcome signal — only a
    // successful run is actually ambiguous ("it ran, but did it help?"),
    // so only 'executed' rows get the follow-up question.
    if (updated.status === "executed") {
      scheduler.pushNotification(
        updated.requested_by,
        `Ran your command (#${updated.id}), sir: "${updated.command}". Did that fix it?`,
        "info"
      );
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
