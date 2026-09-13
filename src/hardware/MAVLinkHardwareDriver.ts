import * as dgram from 'dgram';
import { IHardwareDriver, HardwareCommand, TelemetryPacket } from './UniversalHardwareEngine.js';

export class MAVLinkHardwareDriver implements IHardwareDriver {
  public driverId = 'mavlink_udp_v1';
  public supportedActions = ['TAKEOFF', 'LAND', 'ARM', 'DISARM', 'HOLD', 'GOTO'];

  private socket: dgram.Socket | null = null;
  private targetHost: string = '127.0.0.1';
  private targetPort: number = 14550;
  private sequence: number = 0;
  private connected: boolean = false;
  private systemId: number = 1;
  private componentId: number = 1;

  private latestTelemetry: TelemetryPacket = {
    timestamp: Date.now(),
    batteryPercentage: 100,
    systemStatus: 'STANDBY',
    latitude: 0,
    longitude: 0,
    altitude: 0,
    heading: 0
  };

  /**
   * Calculates MAVLink X.25 CRC-16 checksum over frame payload.
   */
  private calculateCRC(buffer: Buffer, length: number): number {
    let crc = 0xffff;
    for (let i = 1; i < length; i++) {
      let tmp = buffer[i] ^ (crc & 0xff);
      tmp ^= (tmp << 4) & 0xff;
      crc = (crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4);
      crc &= 0xffff;
    }
    return crc;
  }

  /**
   * Encodes a standard MAVLink v1 binary packet.
   */
  private buildPacket(msgId: number, payload: Buffer): Buffer {
    const packetLength = 6 + payload.length + 2;
    const packet = Buffer.alloc(packetLength);

    packet[0] = 0xFE; // MAVLink STX
    packet[1] = payload.length;
    packet[2] = (this.sequence++) & 0xFF;
    packet[3] = this.systemId;
    packet[4] = this.componentId;
    packet[5] = msgId;

    payload.copy(packet, 6);

    const crc = this.calculateCRC(packet, 6 + payload.length);
    packet.writeUInt16LE(crc, 6 + payload.length);

    return packet;
  }

  public async connect(target: string): Promise<boolean> {
    try {
      const url = new URL(target.includes('://') ? target : `udp://${target}`);
      this.targetHost = url.hostname || '127.0.0.1';
      this.targetPort = parseInt(url.port, 10) || 14550;

      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', (msg) => this.handleIncomingPacket(msg));
      this.socket.bind(0);

      this.connected = true;
      this.latestTelemetry.systemStatus = 'CONNECTED';
      return true;
    } catch (err) {
      this.connected = false;
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    this.latestTelemetry.systemStatus = 'DISCONNECTED';
  }

  private handleIncomingPacket(msg: Buffer): void {
    if (msg.length < 8 || msg[0] !== 0xFE) return;
    const msgId = msg[5];

    // Decode Telemetry Packets (e.g., HEARTBEAT #0 or SYS_STATUS #1)
    this.latestTelemetry.timestamp = Date.now();
    if (msgId === 0) {
      this.latestTelemetry.systemStatus = 'ACTIVE';
    } else if (msgId === 1 && msg.length >= 14) {
      this.latestTelemetry.batteryPercentage = msg.readUInt16LE(14) / 10;
    }
  }

  public async sendCommand(cmd: HardwareCommand): Promise<{ success: boolean; message?: string }> {
    if (!this.connected || !this.socket) {
      return { success: false, message: 'MAVLink driver not connected to target UDP socket' };
    }

    let commandId = 0;
    const paramBuffer = Buffer.alloc(28); // 7 float32 parameters (MAV_CMD)

    switch (cmd.action.toUpperCase()) {
      case 'ARM':
        commandId = 400; // MAV_CMD_COMPONENT_ARM_DISARM
        paramBuffer.writeFloatLE(1, 0); // Arm = 1
        break;
      case 'DISARM':
        commandId = 400;
        paramBuffer.writeFloatLE(0, 0); // Disarm = 0
        break;
      case 'TAKEOFF':
        commandId = 22; // MAV_CMD_NAV_TAKEOFF
        paramBuffer.writeFloatLE(cmd.parameters?.altitude || 5.0, 24); // Pitch/Alt
        break;
      case 'LAND':
        commandId = 21; // MAV_CMD_NAV_LAND
        break;
      case 'HOLD':
      default:
        commandId = 19; // MAV_CMD_NAV_LOITER_UNLIM
        break;
    }

    const payload = Buffer.alloc(33);
    paramBuffer.copy(payload, 0);
    payload.writeUInt16LE(commandId, 28); // command ID
    payload[30] = 1; // target system
    payload[31] = 1; // target component
    payload[32] = 0; // confirmation

    const packet = this.buildPacket(76, payload); // COMMAND_LONG (#76)

    return new Promise((resolve) => {
      this.socket!.send(packet, this.targetPort, this.targetHost, (err) => {
        if (err) {
          resolve({ success: false, message: `MAVLink send error: ${err.message}` });
        } else {
          this.latestTelemetry.systemStatus = `EXECUTED_${cmd.action}`;
          resolve({ success: true, message: `MAVLink packet #${commandId} dispatched to ${this.targetHost}:${this.targetPort}` });
        }
      });
    });
  }

  public async getTelemetry(): Promise<TelemetryPacket> {
    return { ...this.latestTelemetry };
  }
}
