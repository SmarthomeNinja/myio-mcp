/**
 * Sensor reading tools for myIO
 */

import { z } from 'zod';
import { MyIOAPI } from '../api.js';

export function registerSensorTools(server: any, api: MyIOAPI) {
  // Read sensor value
  server.tool(
    'myio_sensor_read',
    'Read the current value from a myIO sensor',
    {
      deviceId: z.string().describe('The ID of the sensor to read'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const result = await api.readSensor(deviceId);
        const unitText = result.unit ? ` ${result.unit}` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Sensor ${deviceId} value: ${result.value}${unitText}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error reading sensor: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get sensor status (includes metadata)
  server.tool(
    'myio_sensor_status',
    'Get the current status and metadata of a myIO sensor',
    {
      deviceId: z.string().describe('The ID of the sensor'),
    },
    async ({ deviceId }: { deviceId: string }) => {
      try {
        const device = await api.getDeviceStatus(deviceId);
        return {
          content: [
            {
              type: 'text',
              text: `Sensor ${deviceId} (${device.name}): ${device.value !== undefined ? device.value : 'No value'}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting sensor status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
