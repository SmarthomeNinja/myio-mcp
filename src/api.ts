/**
 * myIO REST API Client
 * Uses axios instead of fetch — the myIO server sends non-standard HTTP headers
 * (e.g. "Renderer-Mode: Standards compliance mode") that Node.js fetch (undici) rejects.
 * Axios is more lenient and handles these responses correctly.
 */

import axios, { AxiosInstance } from 'axios';

// ─── Raw API Types ─────────────────────────────────────────────────────────────

export interface RawRelay {
  id: number;
  description?: string;
  state: number;
  inverse?: number;
  alarm?: number;
  justOn?: number;
  timer?: number;
  timerActive?: number;
  timerRemain?: number;
  delay?: number;
  delayActive?: number;
  delayRemain?: number;
  sensor?: number;
  sensorON?: number;
  sensorOFF?: number;
}

export interface RawPCA extends RawRelay {
  turnOFF?: number;
  turnON?: number;
  fade?: number;
  speed?: number;
  mixer?: number;
  pwm?: number;
}

export interface RawPWM {
  id: number;
  description?: string;
  state: number;
  turnOFF?: number;
  turnON?: number;
  fade?: number;
  speed?: number;
  sensor?: number;
  sensorON?: number;
  sensorOFF?: number;
}

export interface RawGroup {
  id: number;
  description?: string;
  pullUP?: number;
  [key: string]: number | string | undefined;
}

export interface RawSensor {
  id: number;
  description?: string;
  temp?: number;
  hum?: number;
  imp?: number;
  P?: number;
  U?: number;
  I?: number;
}

export interface SensOutData {
  relays:     Record<string, RawRelay>;
  PCA:        Record<string, RawPCA>;
  PWM:        Record<string, RawPWM>;
  group:      Record<string, RawGroup>;
  joiner:     Record<string, unknown>;
  protection: Record<string, unknown>;
  sensors:    Record<string, RawSensor>;
}

// ─── Decoded Types ─────────────────────────────────────────────────────────────

export interface DeviceInfo {
  id: number;
  description: string;
  type: 'relay' | 'pca' | 'pwm' | 'group';
  state: boolean;
  levelPercent?: number;
}

export interface SensorReading {
  id: number;
  description: string;
  type: 'temperature' | 'humidity' | 'energy' | 'power' | 'voltage' | 'current';
  value: number;
  unit: string;
}

// ─── Config ────────────────────────────────────────────────────────────────────

export interface MyIOConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}

// ─── API Client ────────────────────────────────────────────────────────────────

export class MyIOAPI {
  private client: AxiosInstance;

  constructor(config: MyIOConfig) {
    const baseURL = config.baseUrl.replace(/\/$/, '');
    this.client = axios.create({
      baseURL,
      auth: {
        username: config.username ?? '',
        password: config.password ?? '',
      },
      timeout: 5000,
    });
  }

  async getStatus(): Promise<SensOutData> {
    const res = await this.client.get<SensOutData>('/sens_out.json');
    return res.data;
  }

  async getFullStatus(): Promise<SensOutData> {
    const res = await this.client.get<SensOutData>('/d_sens_out.json');
    return res.data;
  }

  async sendCommand(commands: Record<string, string | number>): Promise<void> {
    const body = Object.entries(commands)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    await this.client.post('/', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  // ─── Relay (1–100) ──────────────────────────────────────────────────────────
  async relayOn(id: number): Promise<void>     { await this.sendCommand({ r_ON: id }); }
  async relayOff(id: number): Promise<void>    { await this.sendCommand({ r_OFF: id }); }
  async relayToggle(id: number): Promise<void> { await this.sendCommand({ r_INV: id }); }

  // ─── PCA (2001–2128) ────────────────────────────────────────────────────────
  async pcaOn(id: number): Promise<void>     { await this.sendCommand({ PCA_ON: id }); }
  async pcaOff(id: number): Promise<void>    { await this.sendCommand({ PCA_OFF: id }); }
  async pcaToggle(id: number): Promise<void> { await this.sendCommand({ PCA_INV: id }); }
  async pcaSet(id: number, percent: number): Promise<void> {
    await this.sendCommand({ [`PCA*${id}`]: Math.max(0, Math.min(100, Math.round(percent))) });
  }

  // ─── PWM (101–113) ──────────────────────────────────────────────────────────
  async pwmOn(id: number): Promise<void>     { await this.sendCommand({ f_ON: id }); }
  async pwmOff(id: number): Promise<void>    { await this.sendCommand({ f_OFF: id }); }
  async pwmToggle(id: number): Promise<void> { await this.sendCommand({ f_INV: id }); }
  async pwmSet(id: number, percent: number): Promise<void> {
    await this.sendCommand({ [`fet*${id - 100}`]: Math.max(0, Math.min(100, Math.round(percent))) });
  }

  // ─── Group (500–550) ────────────────────────────────────────────────────────
  async groupOn(id: number): Promise<void>     { await this.sendCommand({ g_ON: id }); }
  async groupOff(id: number): Promise<void>    { await this.sendCommand({ g_OFF: id }); }
  async groupToggle(id: number): Promise<void> { await this.sendCommand({ g_INV: id }); }

  // ─── High-level helpers ─────────────────────────────────────────────────────

  async listDevices(): Promise<DeviceInfo[]> {
    const data = await this.getFullStatus();
    const devices: DeviceInfo[] = [];

    for (const entry of Object.values(data.relays)) {
      devices.push({
        id: entry.id,
        description: entry.description ?? `Relay ${entry.id}`,
        type: 'relay',
        state: entry.state === 1,
      });
    }
    for (const entry of Object.values(data.PCA)) {
      devices.push({
        id: entry.id,
        description: entry.description ?? `PCA ${entry.id}`,
        type: 'pca',
        state: entry.state > 0,
        levelPercent: Math.round((entry.state / 255) * 100),
      });
    }
    for (const entry of Object.values(data.PWM)) {
      devices.push({
        id: entry.id,
        description: entry.description ?? `PWM ${entry.id}`,
        type: 'pwm',
        state: entry.state > 0,
        levelPercent: Math.round((entry.state / 255) * 100),
      });
    }
    for (const entry of Object.values(data.group)) {
      devices.push({
        id: entry.id,
        description: (entry.description as string) ?? `Group ${entry.id}`,
        type: 'group',
        state: false,
      });
    }

    return devices;
  }

  async readSensors(): Promise<SensorReading[]> {
    const data = await this.getStatus();
    const readings: SensorReading[] = [];

    for (const [key, sensor] of Object.entries(data.sensors)) {
      const id = sensor.id ?? parseInt(key);
      const desc = sensor.description ?? `Sensor ${id}`;

      if (sensor.temp !== undefined)
        readings.push({ id, description: desc, type: 'temperature', value: sensor.temp / 100, unit: '°C' });
      else if (sensor.hum !== undefined)
        readings.push({ id, description: desc, type: 'humidity',    value: sensor.hum  / 100, unit: '%' });
      else if (sensor.imp !== undefined)
        readings.push({ id, description: desc, type: 'energy',      value: sensor.imp  / 100, unit: 'kWh' });
      else if (sensor.P !== undefined)
        readings.push({ id, description: desc, type: 'power',       value: sensor.P    / 100, unit: 'kW' });
      else if (sensor.U !== undefined)
        readings.push({ id, description: desc, type: 'voltage',     value: sensor.U    / 100, unit: 'V' });
      else if (sensor.I !== undefined)
        readings.push({ id, description: desc, type: 'current',     value: sensor.I    / 100, unit: 'A' });
    }

    return readings;
  }
}