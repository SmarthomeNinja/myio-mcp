/**
 * Relay control tools for myIO
 */

import { z } from 'zod';
import { MyIOAPI } from '../api.js';

export function registerRelayTools(server: any, api: MyIOAPI) {
  // Turn relay on
  server.tool(
    'myio_relay_on',
    'Turn on a myIO relay',
    {
      deviceId: z.string().describe('The ID of the relay to turn on'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setRelay(deviceId, true);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${deviceId} turned ON successfully`
                : `Failed to turn on relay ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning on relay: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Turn relay off
  server.tool(
    'myio_relay_off',
    'Turn off a myIO relay',
    {
      deviceId: z.string().describe('The ID of the relay to turn off'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setRelay(deviceId, false);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${deviceId} turned OFF successfully`
                : `Failed to turn off relay ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning off relay: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Toggle relay
  server.tool(
    'myio_relay_toggle',
    'Toggle a myIO relay (get current state and flip it)',
    {
      deviceId: z.string().describe('The ID of the relay to toggle'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        const newState = !device.state;
        const result = await api.setRelay(deviceId, newState);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Relay ${deviceId} toggled to ${newState ? 'ON' : 'OFF'}`
                : `Failed to toggle relay ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error toggling relay: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get relay status
  server.tool(
    'myio_relay_status',
    'Get the current status of a myIO relay',
    {
      deviceId: z.string().describe('The ID of the relay'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        return {
          content: [
            {
              type: 'text',
              text: `Relay ${deviceId} (${device.name}) is currently ${device.state ? 'ON' : 'OFF'}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting relay status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
