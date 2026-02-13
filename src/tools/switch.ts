/**
 * Switch control tools for myIO
 */

import { z } from 'zod';
import { MyIOAPI } from '../api.js';

export function registerSwitchTools(server: any, api: MyIOAPI) {
  // Turn switch on
  server.tool(
    'myio_switch_on',
    'Turn on a myIO switch device',
    {
      deviceId: z.string().describe('The ID of the switch device to turn on'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setSwitch(deviceId, true);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${deviceId} turned ON successfully`
                : `Failed to turn on switch ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning on switch: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Turn switch off
  server.tool(
    'myio_switch_off',
    'Turn off a myIO switch device',
    {
      deviceId: z.string().describe('The ID of the switch device to turn off'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setSwitch(deviceId, false);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${deviceId} turned OFF successfully`
                : `Failed to turn off switch ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning off switch: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Toggle switch
  server.tool(
    'myio_switch_toggle',
    'Toggle a myIO switch device (get current state and flip it)',
    {
      deviceId: z.string().describe('The ID of the switch device to toggle'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        const newState = !device.state;
        const result = await api.setSwitch(deviceId, newState);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switch ${deviceId} toggled to ${newState ? 'ON' : 'OFF'}`
                : `Failed to toggle switch ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error toggling switch: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get switch status
  server.tool(
    'myio_switch_status',
    'Get the current status of a myIO switch device',
    {
      deviceId: z.string().describe('The ID of the switch device'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        return {
          content: [
            {
              type: 'text',
              text: `Switch ${deviceId} (${device.name}) is currently ${device.state ? 'ON' : 'OFF'}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting switch status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
