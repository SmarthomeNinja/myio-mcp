/**
 * myIO REST API Client
 * Provides methods to interact with myIO smart home controller
 */

export interface MyIOConfig {
  baseUrl: string;
}

export interface Device {
  id: string;
  name: string;
  type: 'switch' | 'sensor' | 'pwm' | 'relay';
  state?: boolean;
  value?: number;
}

export class MyIOAPI {
  private baseUrl: string;

  constructor(config: MyIOConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Get all devices
   */
  async getDevices(): Promise<Device[]> {
    const response = await fetch(`${this.baseUrl}/api/devices`);
    if (!response.ok) {
      throw new Error(`Failed to get devices: ${response.statusText}`);
    }
    return await response.json() as Device[];
  }

  /**
   * Get device status
   */
  async getDeviceStatus(deviceId: string): Promise<Device> {
    const response = await fetch(`${this.baseUrl}/api/devices/${deviceId}`);
    if (!response.ok) {
      throw new Error(`Failed to get device status: ${response.statusText}`);
    }
    return await response.json() as Device;
  }

  /**
   * Set switch state
   */
  async setSwitch(deviceId: string, state: boolean): Promise<{ success: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/switch/${deviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set switch: ${response.statusText}`);
    }
    return await response.json() as { success: boolean };
  }

  /**
   * Set relay state
   */
  async setRelay(deviceId: string, state: boolean): Promise<{ success: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/relay/${deviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set relay: ${response.statusText}`);
    }
    return await response.json() as { success: boolean };
  }

  /**
   * Set PWM value (0-100)
   */
  async setPWM(deviceId: string, value: number): Promise<{ success: boolean }> {
    if (value < 0 || value > 100) {
      throw new Error('PWM value must be between 0 and 100');
    }
    const response = await fetch(`${this.baseUrl}/api/pwm/${deviceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set PWM: ${response.statusText}`);
    }
    return await response.json() as { success: boolean };
  }

  /**
   * Read sensor value
   */
  async readSensor(deviceId: string): Promise<{ value: number; unit?: string }> {
    const response = await fetch(`${this.baseUrl}/api/sensor/${deviceId}`);
    if (!response.ok) {
      throw new Error(`Failed to read sensor: ${response.statusText}`);
    }
    return await response.json() as { value: number; unit?: string };
  }
}
