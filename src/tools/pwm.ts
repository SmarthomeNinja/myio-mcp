/**
 * PWM control tools for myIO
 */

import { z } from 'zod';
import { MyIOAPI } from '../api.js';

export function registerPWMTools(server: any, api: MyIOAPI) {
  // Set PWM value
  server.tool(
    'myio_pwm_set',
    'Set the PWM (Pulse Width Modulation) value for a myIO device (0-100%)',
    {
      deviceId: z.string().describe('The ID of the PWM device'),
      value: z.number().min(0).max(100).describe('PWM value (0-100, where 0 is off and 100 is full power)'),
    },
    async ({ deviceId, value }: { deviceId: string; value: number }) => {
      try {
        const result = await api.setPWM(deviceId, value);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${deviceId} set to ${value}%`
                : `Failed to set PWM device ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error setting PWM: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get PWM status
  server.tool(
    'myio_pwm_status',
    'Get the current PWM value of a myIO device',
    {
      deviceId: z.string().describe('The ID of the PWM device'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        return {
          content: [
            {
              type: 'text',
              text: `PWM device ${deviceId} (${device.name}) is at ${device.value !== undefined ? device.value : 0}%`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting PWM status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Turn PWM off (set to 0)
  server.tool(
    'myio_pwm_off',
    'Turn off a PWM device (set to 0%)',
    {
      deviceId: z.string().describe('The ID of the PWM device to turn off'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setPWM(deviceId, 0);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${deviceId} turned off`
                : `Failed to turn off PWM device ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning off PWM: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Turn PWM on full (set to 100)
  server.tool(
    'myio_pwm_on_full',
    'Turn on a PWM device to full power (100%)',
    {
      deviceId: z.string().describe('The ID of the PWM device to turn on'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.setPWM(deviceId, 100);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `PWM device ${deviceId} turned on to full power`
                : `Failed to turn on PWM device ${deviceId}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error turning on PWM: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
