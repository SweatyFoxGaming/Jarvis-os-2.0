export interface ConfidenceInputs {
  memoryConfidence: number;      // 0 - 1.0
  toolConfidence: number;        // 0 - 1.0
  validationConfidence: number;  // 0 - 1.0
  capabilityConfidence: number;  // 0 - 1.0
  environmentConfidence: number; // 0 - 1.0
}

export class ConfidenceModel {
  public calculateOverallConfidence(inputs: Partial<ConfidenceInputs>): number {
    const memory = inputs.memoryConfidence ?? 1.0;
    const tool = inputs.toolConfidence ?? 1.0;
    const validation = inputs.validationConfidence ?? 1.0;
    const capability = inputs.capabilityConfidence ?? 1.0;
    const environment = inputs.environmentConfidence ?? 1.0;

    const avg = (memory + tool + validation + capability + environment) / 5;
    return Math.round(avg * 100);
  }
}
