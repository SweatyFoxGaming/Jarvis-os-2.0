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
  // A single INSERT ... ON CONFLICT instead of check-then-branch: two scan
  // cycles racing on the same newly-seen MAC used to both pass the SELECT
  // and both attempt an INSERT, with the loser throwing an uncaught
  // unique-violation. `xmax = 0` is the standard Postgres idiom for "this
  // row was actually inserted by this statement" vs "this row already
  // existed and got updated" — RETURNING can't otherwise tell the two apart
  // from a single ON CONFLICT statement.
  const { rows } = await db.query(
    `INSERT INTO network_devices (mac_address, ip_address, hostname, vendor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (mac_address) DO UPDATE
       SET ip_address = EXCLUDED.ip_address,
           hostname = COALESCE(EXCLUDED.hostname, network_devices.hostname),
           vendor = COALESCE(EXCLUDED.vendor, network_devices.vendor),
           last_seen = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [mac, ip, hostname, vendor]
  );
  const { is_new, ...device } = rows[0];
  return { device: device as NetworkDevice, isNew: is_new as boolean };
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
