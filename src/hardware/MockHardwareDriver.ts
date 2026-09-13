import { IHardwareDriver, HardwareCommand, TelemetryPacket } from './UniversalHardwareEngine.js';

export class MockHardwareDriver implements IHardwareDriver {
  driverId = 'mock_hardware_v1';
  supportedActions = ['TAKEOFF', 'LAND', 'GOTO', 'HOLD'];
  private connected = false;

  async connect(target: string): Promise<boolean> {
    this.connected = true;
    return true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendCommand(cmd: HardwareCommand): Promise<{ success: boolean; message?: string }> {
    if (!this.connected) return { success: false, message: 'Hardware not connected' };
    return { success: true, message: `Executed ${cmd.action} successfully` };
  }

  async getTelemetry(): Promise<TelemetryPacket> {
    return {
      timestamp: Date.now(),
      batteryPercentage: 98,
      position: { x: 0, y: 0, z: 1.5 },
      velocity: { vx: 0, vy: 0, vz: 0 },
      systemStatus: this.connected ? 'ARMED' : 'DISARMED'
    };
  }
}
