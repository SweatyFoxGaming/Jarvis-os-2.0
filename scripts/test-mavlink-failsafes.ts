import { MAVLinkHardwareDriver } from '../src/hardware/MAVLinkHardwareDriver.js';

async function verifyFailsafes() {
  console.log('====================================================');
  console.log('=== PHASE 2: MAVLINK FAILSAFES & TELEMETRY DROPS ===');
  console.log('====================================================\n');

  const driver = new MAVLinkHardwareDriver();
  await driver.connect('udp://127.0.0.1:14550');

  // [Test 1] Heartbeat Silence / Telemetry Drop Failsafe
  console.log('[Test 1] Arming vehicle and simulating heartbeat drop (>3000ms)...');
  await driver.sendCommand({ action: 'ARM' });
  await driver.sendCommand({ action: 'TAKEOFF', parameters: { altitude: 10 } });

  console.log('  Waiting 3200ms to trigger telemetry drop monitor...');
  await new Promise((r) => setTimeout(r, 3200));

  let telemetry = await driver.getTelemetry();
  if (driver.failsafeTriggered && telemetry.systemStatus === 'ERROR') {
    console.log(`✓ Telemetry Drop Failsafe Triggered Successfully!`);
    console.log(`  └─ Reason: ${driver.lastFailsafeReason}`);
    console.log(`  └─ Telemetry Status: ${telemetry.systemStatus}`);
  } else {
    console.error(`❌ Failsafe failed to trigger after telemetry drop.`);
  }

  await driver.disconnect();

  // [Test 2] Critical Battery Threshold Failsafe (<15%)
  console.log('\n[Test 2] Reconnecting and simulating critical low battery (<15%)...');
  await driver.connect('udp://127.0.0.1:14550');
  await driver.sendCommand({ action: 'ARM' });

  // Access private state for test simulation
  (driver as any).latestTelemetry.batteryPercentage = 12;

  // Wait for 600ms check interval
  await new Promise((r) => setTimeout(r, 600));

  telemetry = await driver.getTelemetry();
  if (driver.failsafeTriggered && telemetry.systemStatus === 'ERROR') {
    console.log(`✓ Low Battery Failsafe Triggered Successfully!`);
    console.log(`  └─ Reason: ${driver.lastFailsafeReason}`);
    console.log(`  └─ Telemetry Status: ${telemetry.systemStatus}`);
  } else {
    console.error(`❌ Battery failsafe failed to trigger.`);
  }

  await driver.disconnect();

  console.log('\n====================================================');
  console.log('=== PHASE 2 VERIFICATION COMPLETE ===');
  console.log('====================================================');
}

verifyFailsafes().catch(console.error);
