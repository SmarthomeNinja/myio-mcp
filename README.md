# myIO MCP Server

Model Context Protocol (MCP) server for the myIO smart home controller system.

## Overview

This MCP server enables AI assistants to control and monitor myIO smart home devices through a standardized protocol. It provides tools for controlling switches, relays, PWM devices, and reading sensor data.

## Features

- **Switch Control**: Turn switches on/off, toggle, and check status
- **Relay Control**: Control relays with on/off/toggle operations
- **PWM Control**: Set PWM values (0-100%) for dimmable devices
- **Sensor Reading**: Read sensor values and status
- **Device Discovery**: List all connected devices

## Installation

### Prerequisites

- Node.js 16 or higher
- Access to a myIO controller on your network
- The myIO controller's IP address

### Install Dependencies

```bash
npm install
```

### Build the Project

```bash
npm run build
```

## Configuration

The server requires the myIO controller's base URL to be configured via an environment variable:

```bash
export MYIO_BASE_URL="http://192.168.1.100"
```

**Note**: Replace `192.168.1.100` with your myIO controller's actual IP address. The default port is typically 843 for myIO controllers.

For example, if your myIO is at IP `192.168.1.50` on port 843:

```bash
export MYIO_BASE_URL="http://192.168.1.50:843"
```

## Usage

### Running the Server

```bash
npm start
```

Or with custom configuration:

```bash
MYIO_BASE_URL="http://192.168.1.50:843" npm start
```

### Development Mode

For development with auto-rebuild:

```bash
npm run watch
```

### Using with MCP Clients

To use this server with an MCP client (like Claude Desktop), add it to your MCP configuration:

```json
{
  "mcpServers": {
    "myio": {
      "command": "node",
      "args": ["/path/to/myio-mcp/dist/index.js"],
      "env": {
        "MYIO_BASE_URL": "http://192.168.1.100:843"
      }
    }
  }
}
```

## Available Tools

### Switch Control

- `myio_switch_on` - Turn on a switch device
- `myio_switch_off` - Turn off a switch device
- `myio_switch_toggle` - Toggle a switch device state
- `myio_switch_status` - Get current switch status

### Relay Control

- `myio_relay_on` - Turn on a relay
- `myio_relay_off` - Turn off a relay
- `myio_relay_toggle` - Toggle a relay state
- `myio_relay_status` - Get current relay status

### PWM Control

- `myio_pwm_set` - Set PWM value (0-100%)
- `myio_pwm_off` - Turn off PWM device (0%)
- `myio_pwm_on_full` - Turn on PWM device to full power (100%)
- `myio_pwm_status` - Get current PWM value

### Sensor Reading

- `myio_sensor_read` - Read sensor value
- `myio_sensor_status` - Get sensor status and metadata

### Device Management

- `myio_list_devices` - List all devices in the myIO system

## Example Usage

Once configured with an MCP client, you can interact with your myIO devices using natural language:

- "Turn on the living room light" (switch control)
- "Set the bedroom dimmer to 50%" (PWM control)
- "What's the temperature in the kitchen?" (sensor reading)
- "Toggle the garage door relay" (relay control)
- "Show me all my devices" (device listing)

## API Reference

The server communicates with myIO via REST API endpoints:

- `GET /api/devices` - List all devices
- `GET /api/devices/{id}` - Get device status
- `POST /api/switch/{id}` - Set switch state
- `POST /api/relay/{id}` - Set relay state
- `POST /api/pwm/{id}` - Set PWM value
- `GET /api/sensor/{id}` - Read sensor value

**Note**: These endpoints are based on standard myIO API patterns. Please refer to your myIO Valet API documentation (IO Valet-3.9+API_HU.pdf) for the exact endpoint structure used by your specific myIO version.

## Project Structure

```
myio-mcp/
├── src/
│   ├── index.ts          # Main MCP server entry point
│   ├── api.ts            # myIO REST API client
│   └── tools/            # Device-specific tool implementations
│       ├── switch.ts     # Switch control tools
│       ├── relay.ts      # Relay control tools
│       ├── pwm.ts        # PWM control tools
│       └── sensor.ts     # Sensor reading tools
├── dist/                 # Compiled JavaScript output
├── package.json          # Project dependencies and scripts
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

## Development

### Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run the compiled server
- `npm run dev` - Build and run in one command
- `npm run watch` - Watch mode for development

### Adding New Tools

To add new tools:

1. Create a new file in `src/tools/` (e.g., `newdevice.ts`)
2. Implement the tool registration function
3. Import and register in `src/index.ts`

## Troubleshooting

### Connection Issues

If you cannot connect to the myIO controller:

1. Verify the IP address is correct
2. Check that the myIO controller is powered on and connected to the network
3. Ensure your computer can ping the myIO IP address
4. Verify the port number (default is usually 843)
5. Check if authentication is required by your myIO version

### Authentication

Some myIO configurations may require HTTP authentication. If you encounter 401 errors, you may need to modify the API client to include authentication headers.

## License

MIT

## Support

For myIO-specific questions, please refer to:
- myIO Valet API documentation: IO Valet-3.9+API_HU.pdf
- SmartHome Ninja website: https://smarthomeninja.hu/

For MCP server issues, please open an issue on this repository.
