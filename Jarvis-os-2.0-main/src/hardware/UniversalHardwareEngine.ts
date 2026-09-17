export interface TelemetryPacket {
  timestamp: number;
  batteryPercentage?: number;
  position?: { x: number; y: number; z: number };
  velocity?: { vx: number; vy: number; vz: number };
  systemStatus: 'IDLE' | 'ARMED' | 'DISARMED' | 'EXECUTING' | 'ERROR';
  customMetrics?: Record<string, any>;
}

export interface HardwareCommand {
  action: string;
  parameters?: Record<string, any>;
}

export interface IHardwareDriver {
  driverId: string;
  supportedActions: string[];
  connect(target: string): Promise<boolean>;
  disconnect(): Promise<void>;
  sendCommand(cmd: HardwareCommand): Promise<{ success: boolean; message?: string }>;
  getTelemetry(): Promise<TelemetryPacket>;
}

export class UniversalHardwareEngine {
  private drivers: Map<string, IHardwareDriver> = new Map();
  private activeDriverId?: string;

  registerDriver(driver: IHardwareDriver): void {
    this.drivers.set(driver.driverId, driver);
    if (!this.activeDriverId) {
      this.activeDriverId = driver.driverId;
    }
  }

  setActiveDriver(driverId: string): void {
    if (!this.drivers.has(driverId)) {
      throw new Error(`Driver '${driverId}' is not registered.`);
    }
    this.activeDriverId = driverId;
  }

  async execute(command: HardwareCommand): Promise<{ success: boolean; message?: string }> {
    if (!this.activeDriverId) {
      return { success: false, message: 'No active hardware driver registered.' };
    }
    const driver = this.drivers.get(this.activeDriverId)!;
    return await driver.sendCommand(command);
  }

  async pollTelemetry(): Promise<TelemetryPacket | null> {
    if (!this.activeDriverId) return null;
    return await this.drivers.get(this.activeDriverId)!.getTelemetry();
  }
}
