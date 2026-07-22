import { getPool } from "./db.js";

export interface NetworkDevice {
  mac_address: string;
  ip_address: string;
  hostname: string | null;
  vendor: string | null;
  is_known: boolean;
  first_seen: Date;
  last_seen: Date;
}

// Called once per scan cycle for every device the host-side scanner saw.
// A device already marked known just gets its ip/last_seen refreshed —
// re-flagging a device the user already acknowledged every scan would make
// the findings feed useless. A genuinely new MAC gets both the device row
// and a real "new device" finding, once, at the moment it's first seen.
export async function upsertNetworkDevice(
  mac: string,
  ip: string,
  hostname: string | null,
  vendor: string | null
): Promise<{ device: NetworkDevice; isNew: boolean }> {
  const db = getPool();
  const { rows: existing } = await db.query(`SELECT * FROM network_devices WHERE mac_address = $1`, [mac]);
  if (existing.length > 0) {
    const { rows } = await db.query(
      `UPDATE network_devices SET ip_address = $1, hostname = COALESCE($2, hostname), vendor = COALESCE($3, vendor), last_seen = now() WHERE mac_address = $4 RETURNING *`,
      [ip, hostname, vendor, mac]
    );
    return { device: rows[0], isNew: false };
  }
  const { rows } = await db.query(
    `INSERT INTO network_devices (mac_address, ip_address, hostname, vendor) VALUES ($1, $2, $3, $4) RETURNING *`,
    [mac, ip, hostname, vendor]
  );
  return { device: rows[0], isNew: true };
}

export async function getNetworkDevices(): Promise<NetworkDevice[]> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM network_devices ORDER BY last_seen DESC`);
  return rows;
}

export async function acknowledgeDevice(mac: string): Promise<NetworkDevice | null> {
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE network_devices SET is_known = true WHERE mac_address = $1 RETURNING *`,
    [mac]
  );
  return rows[0] || null;
}

export type FindingStatus = "open" | "acknowledged" | "resolved";

export interface SecurityFinding {
  id: number;
  category: string;
  severity: string;
  title: string;
  description: string;
  source: string;
  status: FindingStatus;
  detected_at: Date;
  resolved_at: Date | null;
}

export async function addFinding(
  category: string,
  severity: string,
  title: string,
  description: string,
  source: string
): Promise<SecurityFinding> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO security_findings (category, severity, title, description, source) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [category, severity, title, description, source]
  );
  return rows[0];
}

export async function getFindings(status?: FindingStatus): Promise<SecurityFinding[]> {
  const db = getPool();
  if (status) {
    const { rows } = await db.query(
      `SELECT * FROM security_findings WHERE status = $1 ORDER BY detected_at DESC`,
      [status]
    );
    return rows;
  }
  const { rows } = await db.query(`SELECT * FROM security_findings ORDER BY detected_at DESC`);
  return rows;
}

export async function updateFindingStatus(id: number, status: FindingStatus): Promise<SecurityFinding | null> {
  const db = getPool();
  const resolvedAt = status === "resolved" ? "now()" : "NULL";
  const { rows } = await db.query(
    `UPDATE security_findings SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return rows[0] || null;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface RemediationProposal {
  id: number;
  finding_id: number | null;
  proposed_action: string;
  proposed_command: string | null;
  status: ProposalStatus;
  created_at: Date;
  resolved_at: Date | null;
}

export async function addProposal(
  findingId: number | null,
  proposedAction: string,
  proposedCommand: string | null
): Promise<RemediationProposal> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO remediation_proposals (finding_id, proposed_action, proposed_command) VALUES ($1, $2, $3) RETURNING *`,
    [findingId, proposedAction, proposedCommand]
  );
  return rows[0];
}

export async function getProposals(status?: ProposalStatus): Promise<RemediationProposal[]> {
  const db = getPool();
  if (status) {
    const { rows } = await db.query(
      `SELECT * FROM remediation_proposals WHERE status = $1 ORDER BY created_at DESC`,
      [status]
    );
    return rows;
  }
  const { rows } = await db.query(`SELECT * FROM remediation_proposals ORDER BY created_at DESC`);
  return rows;
}

// Approving/rejecting only ever changes this status column — nothing in
// this codebase reads proposed_command back out to actually run it. Real
// execution, if the user wants it, is a manual step they take themselves.
export async function updateProposalStatus(id: number, status: ProposalStatus): Promise<RemediationProposal | null> {
  const db = getPool();
  const resolvedAt = status === "approved" || status === "rejected" ? "now()" : "NULL";
  const { rows } = await db.query(
    `UPDATE remediation_proposals SET status = $1, resolved_at = ${resolvedAt} WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return rows[0] || null;
}
