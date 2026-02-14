/**
 * myIO REST API Client
 * Implements the myIO smart home controller REST API.
 *
 * Endpoints:
 *   GET  /sens_out.json    - Lightweight status snapshot (poll frequently)
 *   GET  /d_sens_out.json  - Full snapshot with device descriptions (startup/init only)
 *   POST /                 - Send control commands (form-encoded key=value pairs)
 *
 * Authentication: HTTP Basic Auth (MYIO_USERNAME / MYIO_PASSWORD env vars)
 */

// ─── Raw API Types ─────────────────────────────────────────────────────────────
import http from 'http';

export interface RawRelay {
  id: number;
  description?: string;
  state: number;           // 0 = OFF, 1 = ON
  inverse: number;
  alarm: number;
  justOn: number;
  timer: number;
  timerActive: number;
  timerRemain: number;
  delay: number;
  delayActive: number;
  delayRemain: number;
  sensor: number;
  sensorON: number;
  sensorOFF: number;
}

export interface RawPCA extends RawRelay {
  turnOFF: number;
  turnON: number;
  fade: number;
  speed: number;
  mixer: number;
  pwm: number;
}

export interface RawPWM {
  id: number;
  description?: string;
  state: number;           // 0–255
  turnOFF: number;
  turnON: number;
  fade: number;
  speed: number;
  sensor: number;
  sensorON: number;
  sensorOFF: number;
}

export interface RawGroup {
  id: number;
  description?: string;
  pullUP: number;
  [key: string]: number | string | undefined; // elementN fields
}

export interface RawJoinerProtection {
  element0: number;
  element0d?: string;
  element1: number;
  element1d?: string;
}

export interface RawSensor {
  id: number;
  description?: string;
  temp?: number;   // °C × 100
  hum?: number;    // % × 100
  imp?: number;    // kWh × 100
  P?: number;      // kW × 100
  U?: number;      // V × 100
  I?: number;      // A × 100
}

export interface SensOutData {
  relays:     Record<string, RawRelay>;
  PCA:        Record<string, RawPCA>;
  PWM:        Record<string, RawPWM>;
  group:      Record<string, RawGroup>;
  joiner:     Record<string, RawJoinerProtection>;
  protection: Record<string, RawJoinerProtection>;
  sensors:    Record<string, RawSensor>;
}

// ─── Decoded / Friendly Types ──────────────────────────────────────────────────

export interface DeviceInfo {
  id: number;
  description: string;
  type: 'relay' | 'pca' | 'pwm' | 'group';
  state: boolean;
  levelPercent?: number;   // for PCA/PWM: 0–100
}

export interface SensorReading {
  id: number;
  description: string;
  type: 'temperature' | 'humidity' | 'energy' | 'power' | 'voltage' | 'current' | 'unknown';
  value: number;
  unit: string;
  raw: number;
}

// ─── API Client ────────────────────────────────────────────────────────────────

import axios, { type AxiosInstance } from 'axios';

export interface MyIOConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}

export class MyIOAPI {
  private http: AxiosInstance;

  constructor(config: MyIOConfig) {
    const baseURL = config.baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL,
      auth: {
        username: config.username ?? '',
        password: config.password ?? '',
      },
      timeout: 10_000,
      httpAgent: new http.Agent({ insecureHTTPParser: true } as any),
      // axios tolerates non-standard headers (e.g. "Renderer-Mode") that Node fetch rejects
    });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.http.get<T>(path);
    return res.data;
  }

  /**
   * Lightweight status snapshot. Call this for current state.
   * Do NOT use to get descriptions — use getFullStatus() once at startup.
   */
  async getStatus(): Promise<SensOutData> {
    return this.get<SensOutData>('/sens_out.json');
  }

  /**
   * Full snapshot including device descriptions.
   * Slower — call once at startup or when names change.
   */
  async getFullStatus(): Promise<SensOutData> {
    return this.get<SensOutData>('/d_sens_out.json');
  }

  /**
   * Send one or more commands to the controller.
   *
   * Commands are key=value pairs, e.g.:
   *   { r_ON: 16 }         → turn on relay #16
   *   { r_OFF: 5, PCA_ON: 2001 }  → turn off relay #5 AND turn on PCA #2001
   */
  async sendCommand(commands: Record<string, string | number>): Promise<void> {
    const body = Object.entries(commands)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    await this.http.post('/', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  // ─── Relay Commands (ID: 1–100) ─────────────────────────────────────────────

  async relayOn(id: number): Promise<void>     { await this.sendCommand({ r_ON: id }); }
  async relayOff(id: number): Promise<void>    { await this.sendCommand({ r_OFF: id }); }
  async relayToggle(id: number): Promise<void> { await this.sendCommand({ r_INV: id }); }

  // ─── PCA Commands (ID: 2001–2128) ───────────────────────────────────────────

  async pcaOn(id: number): Promise<void>     { await this.sendCommand({ PCA_ON: id }); }
  async pcaOff(id: number): Promise<void>    { await this.sendCommand({ PCA_OFF: id }); }
  async pcaToggle(id: number): Promise<void> { await this.sendCommand({ PCA_INV: id }); }

  /** Set PCA output to percentage (0–100%) */
  async pcaSet(id: number, percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.sendCommand({ [`PCA*${id}`]: clamped });
  }

  // ─── PWM Commands (ID: 101–113, offset index = id − 100) ────────────────────

  async pwmOn(id: number): Promise<void>     { await this.sendCommand({ f_ON: id }); }
  async pwmOff(id: number): Promise<void>    { await this.sendCommand({ f_OFF: id }); }
  async pwmToggle(id: number): Promise<void> { await this.sendCommand({ f_INV: id }); }

  /** Set PWM output to percentage (0–100%). Uses offset index (id − 100). */
  async pwmSet(id: number, percent: number): Promise<void> {
    const offset = id - 100;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.sendCommand({ [`fet*${offset}`]: clamped });
  }

  // ─── Group Commands (ID: 500–550) ───────────────────────────────────────────

  async groupOn(id: number): Promise<void>     { await this.sendCommand({ g_ON: id }); }
  async groupOff(id: number): Promise<void>    { await this.sendCommand({ g_OFF: id }); }
  async groupToggle(id: number): Promise<void> { await this.sendCommand({ g_INV: id }); }

  // ─── High-level helpers ──────────────────────────────────────────────────────

  /**
   * Returns all devices (relays, PCA, PWM, groups) with descriptions and current state.
   * Calls d_sens_out.json (slow, use sparingly).
   */
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
      // A group is ON if any of its members is on (simplified)
      devices.push({
        id: entry.id,
        description: entry.description ?? `Group ${entry.id}`,
        type: 'group',
        state: false, // Group state isn't directly available; call getStatus() to check members
      });
    }

    return devices;
  }

  /**
   * Returns all sensor readings with decoded values and units.
   */
  async readSensors(): Promise<SensorReading[]> {
    const data = await this.getStatus();
    const readings: SensorReading[] = [];

    for (const [key, sensor] of Object.entries(data.sensors)) {
      const id = sensor.id ?? parseInt(key);

      if (sensor.temp !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'temperature', value: sensor.temp / 100, unit: '°C', raw: sensor.temp,
        });
      } else if (sensor.hum !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'humidity', value: sensor.hum / 100, unit: '%', raw: sensor.hum,
        });
      } else if (sensor.imp !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'energy', value: sensor.imp / 100, unit: 'kWh', raw: sensor.imp,
        });
      } else if (sensor.P !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'power', value: sensor.P / 100, unit: 'kW', raw: sensor.P,
        });
      } else if (sensor.U !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'voltage', value: sensor.U / 100, unit: 'V', raw: sensor.U,
        });
      } else if (sensor.I !== undefined) {
        readings.push({
          id, description: sensor.description ?? `Sensor ${id}`,
          type: 'current', value: sensor.I / 100, unit: 'A', raw: sensor.I,
        });
      }
    }

    return readings;
  }
}