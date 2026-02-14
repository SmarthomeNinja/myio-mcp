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
import { execSync } from 'child_process';

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


export interface MyIOConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}

export class MyIOAPI {
  private baseUrl: string;
  private authStr: string;

  constructor(config: MyIOConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authStr = `${config.username ?? ''}:${config.password ?? ''}`;
  }

  private curlGet(path: string): string {
    const cmd = `curl -s -u "${this.authStr}" --max-time 10 "${this.baseUrl}${path}"`;
    return execSync(cmd, { encoding: 'utf-8' });
  }

  async getStatus(): Promise<SensOutData> {
    return JSON.parse(this.curlGet('/sens_out.json'));
  }

  async getFullStatus(): Promise<SensOutData> {
    return JSON.parse(this.curlGet('/d_sens_out.json'));
  }

  async sendCommand(commands: Record<string, string | number>): Promise<void> {
    const body = Object.entries(commands)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const cmd = `curl -s -u "${this.authStr}" --max-time 10 -X POST -d "${body}" "${this.baseUrl}/"`;
    execSync(cmd, { encoding: 'utf-8' });
  }
}