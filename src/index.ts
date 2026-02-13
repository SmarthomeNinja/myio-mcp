#!/usr/bin/env node

/**
 * myIO MCP Server
 * Model Context Protocol server for myIO smart home controller
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { MyIOAPI } from './api.js';

// Get configuration from environment variables
const MYIO_BASE_URL = process.env.MYIO_BASE_URL || 'http://192.168.1.100';

// Initialize myIO API client
const myioAPI = new MyIOAPI({ baseUrl: MYIO_BASE_URL });

// Create MCP server
const server = new Server(
  {
    name: 'myio-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const tools: Tool[] = [
  // Switch tools
  {
    name: 'myio_switch_on',
    description: 'Turn on a myIO switch device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the switch device to turn on',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_switch_off',
    description: 'Turn off a myIO switch device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the switch device to turn off',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_switch_toggle',
    description: 'Toggle a myIO switch device (get current state and flip it)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the switch device to toggle',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_switch_status',
    description: 'Get the current status of a myIO switch device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the switch device',
        },
      },
      required: ['deviceId'],
    },
  },
  // Relay tools
  {
    name: 'myio_relay_on',
    description: 'Turn on a myIO relay',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the relay to turn on',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_relay_off',
    description: 'Turn off a myIO relay',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the relay to turn off',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_relay_toggle',
    description: 'Toggle a myIO relay (get current state and flip it)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the relay to toggle',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_relay_status',
    description: 'Get the current status of a myIO relay',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the relay',
        },
      },
      required: ['deviceId'],
    },
  },
  // PWM tools
  {
    name: 'myio_pwm_set',
    description: 'Set the PWM (Pulse Width Modulation) value for a myIO device (0-100%)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the PWM device',
        },
        value: {
          type: 'number',
          description: 'PWM value (0-100, where 0 is off and 100 is full power)',
          minimum: 0,
          maximum: 100,
        },
      },
      required: ['deviceId', 'value'],
    },
  },
  {
    name: 'myio_pwm_status',
    description: 'Get the current PWM value of a myIO device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the PWM device',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_pwm_off',
    description: 'Turn off a PWM device (set to 0%)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the PWM device to turn off',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_pwm_on_full',
    description: 'Turn on a PWM device to full power (100%)',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the PWM device to turn on',
        },
      },
      required: ['deviceId'],
    },
  },
  // Sensor tools
  {
    name: 'myio_sensor_read',
    description: 'Read the current value from a myIO sensor',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the sensor to read',
        },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'myio_sensor_status',
    description: 'Get the current status and metadata of a myIO sensor',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The ID of the sensor',
        },
      },
      required: ['deviceId'],
    },
  },
  // General tools
  {
    name: 'myio_list_devices',
    description: 'List all devices connected to the myIO system',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error('Missing arguments');
  }

  try {
    switch (name) {
      // Switch tools
      case 'myio_switch_on': {
        const result = await myioAPI.setSwitch(args.deviceId as string, true);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${args.deviceId} turned ON successfully`
                : `Failed to turn on switch ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_switch_off': {
        const result = await myioAPI.setSwitch(args.deviceId as string, false);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${args.deviceId} turned OFF successfully`
                : `Failed to turn off switch ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_switch_toggle': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        const newState = !device.state;
        const result = await myioAPI.setSwitch(args.deviceId as string, newState);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${args.deviceId} toggled to ${newState ? 'ON' : 'OFF'}`
                : `Failed to toggle switch ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_switch_status': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        return {
          content: [
            {
              type: 'text',
              text: `Switch ${args.deviceId} (${device.name}) is currently ${device.state ? 'ON' : 'OFF'}`,
            },
          ],
        };
      }
      // Relay tools
      case 'myio_relay_on': {
        const result = await myioAPI.setRelay(args.deviceId as string, true);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${args.deviceId} turned ON successfully`
                : `Failed to turn on relay ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_relay_off': {
        const result = await myioAPI.setRelay(args.deviceId as string, false);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${args.deviceId} turned OFF successfully`
                : `Failed to turn off relay ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_relay_toggle': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        const newState = !device.state;
        const result = await myioAPI.setRelay(args.deviceId as string, newState);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${args.deviceId} toggled to ${newState ? 'ON' : 'OFF'}`
                : `Failed to toggle relay ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_relay_status': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        return {
          content: [
            {
              type: 'text',
              text: `Relay ${args.deviceId} (${device.name}) is currently ${device.state ? 'ON' : 'OFF'}`,
            },
          ],
        };
      }
      // PWM tools
      case 'myio_pwm_set': {
        const result = await myioAPI.setPWM(args.deviceId as string, args.value as number);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${args.deviceId} set to ${args.value}%`
                : `Failed to set PWM device ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_pwm_status': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        return {
          content: [
            {
              type: 'text',
              text: `PWM device ${args.deviceId} (${device.name}) is at ${device.value !== undefined ? device.value : 0}%`,
            },
          ],
        };
      }
      case 'myio_pwm_off': {
        const result = await myioAPI.setPWM(args.deviceId as string, 0);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${args.deviceId} turned off`
                : `Failed to turn off PWM device ${args.deviceId}`,
            },
          ],
        };
      }
      case 'myio_pwm_on_full': {
        const result = await myioAPI.setPWM(args.deviceId as string, 100);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${args.deviceId} turned on to full power`
                : `Failed to turn on PWM device ${args.deviceId}`,
            },
          ],
        };
      }
      // Sensor tools
      case 'myio_sensor_read': {
        const result = await myioAPI.readSensor(args.deviceId as string);
        const unitText = result.unit ? ` ${result.unit}` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Sensor ${args.deviceId} value: ${result.value}${unitText}`,
            },
          ],
        };
      }
      case 'myio_sensor_status': {
        const device = await myioAPI.getDeviceStatus(args.deviceId as string);
        return {
          content: [
            {
              type: 'text',
              text: `Sensor ${args.deviceId} (${device.name}): ${device.value !== undefined ? device.value : 'No value'}`,
            },
          ],
        };
      }
      // General tools
      case 'myio_list_devices': {
        const devices = await myioAPI.getDevices();
        const deviceList = devices
          .map(
            (d) =>
              `- ${d.id}: ${d.name} (${d.type})${d.state !== undefined ? ` - ${d.state ? 'ON' : 'OFF'}` : ''}${d.value !== undefined ? ` - ${d.value}` : ''}`
          )
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `myIO Devices:\n${deviceList}`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  console.error('Starting myIO MCP server...');
  console.error(`myIO Base URL: ${MYIO_BASE_URL}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('myIO MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
