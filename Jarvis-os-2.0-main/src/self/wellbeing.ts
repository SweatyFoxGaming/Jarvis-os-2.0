import * as wellbeingRepo from "../kernel/state/wellbeing-repo.js";
import * as rapportRepo from "../kernel/state/rapport-repo.js";

// Real, honest thresholds — not tuned against real usage data yet (there
// isn't any), a first reasonable pass: a genuinely unusual amount of
// late-hour messaging, or explicit stress language actually present in
// recently recorded rapport signals. Revisit these numbers once this has
// run against real usage.
const LATE_HOUR_RATIO_THRESHOLD = 0.3;
const MIN_DAYS_BETWEEN_CHECKINS = 3;
const STRESS_KEYWORDS = ["stressed", "overwhelmed", "exhausted", "burnt out", "burned out", "frustrated", "drained"];

export interface WellbeingDeps {
  getLateHourActivityRatio: typeof wellbeingRepo.getLateHourActivityRatio;
  getLastCheckinAt: typeof wellbeingRepo.getLastCheckinAt;
  getRecentRapportSignals: typeof rapportRepo.getRecentRapportSignals;
}

const defaultDeps: WellbeingDeps = {
  getLateHourActivityRatio: wellbeingRepo.getLateHourActivityRatio,
  getLastCheckinAt: wellbeingRepo.getLastCheckinAt,
  getRecentRapportSignals: rapportRepo.getRecentRapportSignals,
};

export async function assessWellbeingSignal(username: string, deps: WellbeingDeps = defaultDeps): Promise<string | null> {
  const lastCheckin = await deps.getLastCheckinAt(username);
  if (lastCheckin) {
    const daysSince = (Date.now() - lastCheckin.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < MIN_DAYS_BETWEEN_CHECKINS) return null;
  }

  const lateHourRatio = await deps.getLateHourActivityRatio(username);
  if (lateHourRatio !== null && lateHourRatio >= LATE_HOUR_RATIO_THRESHOLD) {
    const percent = Math.round(lateHourRatio * 100);
    return `I've noticed about ${percent}% of your recent messages have come in late at night — no pressure to respond, just checking in, sir.`;
  }

  const recentSignals = await deps.getRecentRapportSignals(username, 5);
  const stressedSignal = recentSignals.find(s =>
    STRESS_KEYWORDS.some(word => s.toneDescriptor.toLowerCase().includes(word))
  );
  if (stressedSignal) {
    return `I've noticed some of our recent conversations have had a "${stressedSignal.toneDescriptor}" tone — just checking in, sir. No need to respond if you'd rather not.`;
  }

  return null;
}
