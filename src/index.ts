#!/usr/bin/env node

/**
 * myIO MCP Server
 * Model Context Protocol server for myIO smart home controller.
 *
 * Configuration (environment variables):
 *   MYIO_BASE_URL   - Controller URL, e.g. http://192.168.1.179 (required)
 *   MYIO_USERNAME   - Basic Auth username (required)
 *   MYIO_PASSWORD   - Basic Auth password (required)
 *
 * Device ID ranges (myIO):
 *   Relay:      1 – 100
 *   PCA:     2001 – 2128
 *   PWM:      101 – 113
 *   Group:    500 – 550
 *   Sensors:  see API docs
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MyIOAPI } from './api.js';

// ─── Configuration ─────────────────────────────────────────────────────────────

const MYIO_BASE_URL  = process.env.MYIO_BASE_URL  || 'http://192.168.1.170';
const MYIO_USERNAME  = process.env.MYIO_USERNAME  || '';
const MYIO_PASSWORD  = process.env.MYIO_PASSWORD  || '';

const api = new MyIOAPI({
  baseUrl:  MYIO_BASE_URL,
  username: MYIO_USERNAME,
  password: MYIO_PASSWORD,
});

// ─── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'myio-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const tools: Tool[] = [
  // ── Discovery ──────────────────────────────────────────────────────────────
  {
    name: 'myio_list_devices',
    description:
      'List all devices in the myIO system with their IDs, names, types, and current state. ' +
      'Includes relays (1–100), PCA outputs (2001–2128), PWM outputs (101–113), and groups (500–550). ' +
      'Use this first to discover device IDs before sending control commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'myio_read_sensors',
    description:
      'Read all sensor values from the myIO system. Returns decoded values with units. ' +
      'Sensor types: temperature (°C), humidity (%), energy (kWh), power (kW), voltage (V), current (A).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'myio_get_status',
    description:
      'Get raw live status snapshot from /sens_out.json. Returns full JSON with all outputs and sensors. ' +
      'Use myio_list_devices for a friendlier view, or this for raw state details.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Relay (ID: 1–100) ──────────────────────────────────────────────────────
  {
    name: 'myio_relay_on',
    description: 'Turn ON a relay output. Relay IDs are in the range 1–100.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Relay ID (1–100)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_relay_off',
    description: 'Turn OFF a relay output. Relay IDs are in the range 1–100.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Relay ID (1–100)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_relay_toggle',
    description: 'Toggle (invert) a relay output. Relay IDs are in the range 1–100.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Relay ID (1–100)' },
      },
      required: ['id'],
    },
  },

  // ── PCA Universal Output (ID: 2001–2128) ───────────────────────────────────
  {
    name: 'myio_pca_on',
    description: 'Turn ON a PCA output to its configured ON value. PCA IDs are in the range 2001–2128.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PCA ID (2001–2128)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pca_off',
    description: 'Turn OFF a PCA output to its configured OFF value. PCA IDs are in the range 2001–2128.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PCA ID (2001–2128)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pca_toggle',
    description: 'Toggle a PCA output (ON↔OFF). PCA IDs are in the range 2001–2128.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PCA ID (2001–2128)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pca_set',
    description:
      'Set a PCA output to a specific brightness/level percentage (0–100%). ' +
      'Useful for LED strips, dimmers, or analog outputs. PCA IDs are in the range 2001–2128.',
    inputSchema: {
      type: 'object',
      properties: {
        id:      { type: 'number', description: 'PCA ID (2001–2128)' },
        percent: { type: 'number', description: 'Level in percent (0–100)', minimum: 0, maximum: 100 },
      },
      required: ['id', 'percent'],
    },
  },

  // ── PWM Output (ID: 101–113) ───────────────────────────────────────────────
  {
    name: 'myio_pwm_on',
    description: 'Turn ON a PWM output to its configured ON value. PWM IDs are in the range 101–113.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PWM ID (101–113)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pwm_off',
    description: 'Turn OFF a PWM output. PWM IDs are in the range 101–113.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PWM ID (101–113)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pwm_toggle',
    description: 'Toggle a PWM output (ON↔OFF). PWM IDs are in the range 101–113.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'PWM ID (101–113)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_pwm_set',
    description:
      'Set a PWM output to a specific level percentage (0–100%). ' +
      'PWM IDs are in the range 101–113.',
    inputSchema: {
      type: 'object',
      properties: {
        id:      { type: 'number', description: 'PWM ID (101–113)' },
        percent: { type: 'number', description: 'Level in percent (0–100)', minimum: 0, maximum: 100 },
      },
      required: ['id', 'percent'],
    },
  },

  // ── Group (ID: 500–550) ────────────────────────────────────────────────────
  {
    name: 'myio_group_on',
    description:
      'Turn ON all outputs in a group. Group IDs are in the range 500–550. ' +
      'Use myio_list_devices to see group members.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Group ID (500–550)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_group_off',
    description: 'Turn OFF all outputs in a group. Group IDs are in the range 500–550.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Group ID (500–550)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'myio_group_toggle',
    description:
      'Toggle a group of outputs. Respects the pullUP flag: if pullUP=1, mixed states turn ALL ON; ' +
      'if pullUP=0, mixed states turn ALL OFF. Group IDs are in the range 500–550.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Group ID (500–550)' },
      },
      required: ['id'],
    },
  },

  // ── Raw Command (advanced) ─────────────────────────────────────────────────
  {
    name: 'myio_send_command',
    description:
      'Send a raw command string directly to the myIO controller. ' +
      'Multiple commands can be combined. Example: "r_ON=16&r_OFF=5&PCA*2001=50". ' +
      'Use this for advanced operations not covered by other tools, such as setting sensor thresholds.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'string',
          description:
            'URL-encoded command string, e.g. "r_ON=16" or "r_ON=16&PCA*2001=75". ' +
            'See myIO API docs for all available commands.',
        },
      },
      required: ['commands'],
    },
  },
];

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const err = (text: string) => ({ content: [{ type: 'text' as const, text: `❌ ${text}` }], isError: true });

  try {
    switch (name) {

      // ── Discovery ────────────────────────────────────────────────────────

      case 'myio_list_devices': {
        const devices = await api.listDevices();
        if (devices.length === 0) {
          return ok('No devices found.');
        }
        const byType = (t: string) => devices.filter(d => d.type === t);
        const fmt = (d: typeof devices[0]) => {
          const state = d.state ? 'ON' : 'OFF';
          const level = d.levelPercent !== undefined ? ` (${d.levelPercent}%)` : '';
          return `  • [${d.id}] ${d.description} — ${state}${level}`;
        };

        const sections: string[] = [];
        const relays = byType('relay');
        const pcas   = byType('pca');
        const pwms   = byType('pwm');
        const groups = byType('group');

        if (relays.length)  sections.push('Relays (1–100):\n'        + relays.map(fmt).join('\n'));
        if (pcas.length)    sections.push('PCA Outputs (2001–2128):\n' + pcas.map(fmt).join('\n'));
        if (pwms.length)    sections.push('PWM Outputs (101–113):\n'  + pwms.map(fmt).join('\n'));
        if (groups.length)  sections.push('Groups (500–550):\n'       + groups.map(fmt).join('\n'));

        return ok('myIO Devices:\n\n' + sections.join('\n\n'));
      }

      case 'myio_read_sensors': {
        const sensors = await api.readSensors();
        if (sensors.length === 0) {
          return ok('No sensor data available.');
        }
        const lines = sensors.map(s =>
          `  • [${s.id}] ${s.description}: ${s.value.toFixed(2)} ${s.unit}`
        );
        return ok('myIO Sensors:\n\n' + lines.join('\n'));
      }

      case 'myio_get_status': {
        const data = await api.getStatus();
        return ok(JSON.stringify(data, null, 2));
      }

      // ── Relay ────────────────────────────────────────────────────────────

      case 'myio_relay_on': {
        const id = args.id as number;
        await api.relayOn(id);
        return ok(`✅ Relay #${id} turned ON`);
      }

      case 'myio_relay_off': {
        const id = args.id as number;
        await api.relayOff(id);
        return ok(`✅ Relay #${id} turned OFF`);
      }

      case 'myio_relay_toggle': {
        const id = args.id as number;
        await api.relayToggle(id);
        return ok(`✅ Relay #${id} toggled`);
      }

      // ── PCA ──────────────────────────────────────────────────────────────

      case 'myio_pca_on': {
        const id = args.id as number;
        await api.pcaOn(id);
        return ok(`✅ PCA #${id} turned ON`);
      }

      case 'myio_pca_off': {
        const id = args.id as number;
        await api.pcaOff(id);
        return ok(`✅ PCA #${id} turned OFF`);
      }

      case 'myio_pca_toggle': {
        const id = args.id as number;
        await api.pcaToggle(id);
        return ok(`✅ PCA #${id} toggled`);
      }

      case 'myio_pca_set': {
        const id      = args.id as number;
        const percent = args.percent as number;
        await api.pcaSet(id, percent);
        return ok(`✅ PCA #${id} set to ${percent}%`);
      }

      // ── PWM ──────────────────────────────────────────────────────────────

      case 'myio_pwm_on': {
        const id = args.id as number;
        await api.pwmOn(id);
        return ok(`✅ PWM #${id} turned ON`);
      }

      case 'myio_pwm_off': {
        const id = args.id as number;
        await api.pwmOff(id);
        return ok(`✅ PWM #${id} turned OFF`);
      }

      case 'myio_pwm_toggle': {
        const id = args.id as number;
        await api.pwmToggle(id);
        return ok(`✅ PWM #${id} toggled`);
      }

      case 'myio_pwm_set': {
        const id      = args.id as number;
        const percent = args.percent as number;
        await api.pwmSet(id, percent);
        return ok(`✅ PWM #${id} set to ${percent}%`);
      }

      // ── Group ────────────────────────────────────────────────────────────

      case 'myio_group_on': {
        const id = args.id as number;
        await api.groupOn(id);
        return ok(`✅ Group #${id} turned ON`);
      }

      case 'myio_group_off': {
        const id = args.id as number;
        await api.groupOff(id);
        return ok(`✅ Group #${id} turned OFF`);
      }

      case 'myio_group_toggle': {
        const id = args.id as number;
        await api.groupToggle(id);
        return ok(`✅ Group #${id} toggled`);
      }

      // ── Raw Command ──────────────────────────────────────────────────────

      case 'myio_send_command': {
        const raw = args.commands as string;
        // Parse the raw command string into key=value pairs
        const parsed: Record<string, string> = {};
        for (const part of raw.split('&')) {
          const [k, v] = part.split('=');
          if (k && v !== undefined) {
            parsed[decodeURIComponent(k)] = decodeURIComponent(v);
          }
        }
        await api.sendCommand(parsed);
        return ok(`✅ Command sent: ${raw}`);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error('🏠 myIO MCP Server starting...');
  console.error(`   Base URL:  ${MYIO_BASE_URL}`);
  console.error(`   Username:  ${MYIO_USERNAME || '(not set)'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('✅ myIO MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});