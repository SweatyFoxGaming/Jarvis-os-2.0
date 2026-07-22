export interface ConfidenceInputs {
  memoryConfidence: number;      // 0 - 1.0
  toolConfidence: number;        // 0 - 1.0
  validationConfidence: number;  // 0 - 1.0
  capabilityConfidence: number;  // 0 - 1.0
  environmentConfidence: number; // 0 - 1.0
  outcomeConfidence: number;     // 0 - 1.0 — rolling real-world success rate; omit entirely when no outcome data exists yet
}

export class ConfidenceModel {
  // Averages only over inputs the caller actually provided. A naive fixed
  // divisor (e.g. always /6 with a default of 1.0 for a missing input)
  // would shift every existing call site's score the moment this field was
  // added, even before any real outcome data exists — omitting a field
  // from the average entirely, not defaulting it to neutral within a fixed
  // divisor, is what keeps a cold start byte-for-byte identical to today.
  public calculateOverallConfidence(inputs: Partial<ConfidenceInputs>): number {
    const provided = Object.values(inputs).filter((v): v is number => v !== undefined);
    if (provided.length === 0) return 100;
    const avg = provided.reduce((sum, v) => sum + v, 0) / provided.length;
    return Math.round(avg * 100);
  }
}
