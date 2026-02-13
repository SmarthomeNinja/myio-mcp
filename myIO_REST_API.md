# myIO Server – REST API Documentation

> **Version:** 1.0  
> **Purpose:** Smart home controller REST API reference. Suitable for integration, automation tools, and MCP server development.

---

## Table of Contents

1. [Connection & Authentication](#1-connection--authentication)
2. [Data Endpoints](#2-data-endpoints)
   - [sens_out.json – Status Snapshot](#21-sens_outjson--status-snapshot)
   - [d_sens_out.json – Full Description Snapshot](#22-d_sens_outjson--full-description-snapshot)
3. [Command Endpoint](#3-command-endpoint)
   - [POST Command](#31-post-command)
   - [GET Command](#32-get-command)
4. [JSON Data Structure Reference](#4-json-data-structure-reference)
   - [relays](#41-relays)
   - [PCA](#42-pca-universal-outputs)
   - [PWM](#43-pwm-outputs)
   - [group](#44-group)
   - [joiner](#45-joiner)
   - [protection](#46-protection)
   - [sensors](#47-sensors)
5. [Sensor ID Reference](#5-sensor-id-reference)
6. [Command Reference](#6-command-reference)
   - [Relay Commands](#61-relay-commands)
   - [PCA Commands](#62-pca-commands)
   - [PWM Commands](#63-pwm-commands)
   - [Group Commands](#64-group-commands)
7. [Value Encoding Notes](#7-value-encoding-notes)
8. [Usage Examples](#8-usage-examples)

---

## 1. Connection & Authentication

| Parameter       | Description                                                |
|-----------------|------------------------------------------------------------|
| **Base URL**    | `http://<HOST>:<PORT>` — internal IP or DDNS with port forwarding |
| **Example**     | `http://192.168.1.179:80` or `http://myhome.ddns.net:8080` |
| **Auth method** | HTTP Basic Authentication                                  |
| **Credentials** | `USERNAME:PASSWORD`                                        |

All requests must include a Basic Auth header:

```
Authorization: Basic <base64(USERNAME:PASSWORD)>
```

---

## 2. Data Endpoints

### 2.1 `sens_out.json` – Status Snapshot

Returns the current **state** of all outputs and sensors. Does **not** include description fields.  
This is the primary polling endpoint — lightweight and fast.

```
GET http://<HOST>:<PORT>/sens_out.json
```

**When to use:** Poll frequently (e.g. every 1–5 seconds) to keep state up-to-date.

**Response:** `Content-Type: application/json`

```json
{
  "relays":     { "<index>": { "id": 1, "state": 1, ... } },
  "PCA":        { "<index>": { "id": 2001, "state": 128, ... } },
  "PWM":        { "<index>": { "id": 101, "state": 0, ... } },
  "group":      { "<index>": { "id": 501, ... } },
  "joiner":     { "<index>": { "element0": 502, ... } },
  "protection": {},
  "sensors":    { "<sensor_id>": { "id": 1, "temp": 2712 } }
}
```

---

### 2.2 `d_sens_out.json` – Full Description Snapshot

Returns the same data as `sens_out.json` **plus** a `description` field for every output and sensor.  
Descriptions are stored on the server's SD card and rarely change.

```
GET http://<HOST>:<PORT>/d_sens_out.json
```

**When to use:**  
- Once on startup / first connection  
- Manually when the user renames a device  
- **Do not** poll frequently — download is significantly slower

**Response:** Same structure as `sens_out.json`, with `description` populated:

```json
{
  "relays": {
    "0": { "id": 1, "description": "hangulat fény", "state": 1, ... }
  }
}
```

> **Recommended strategy:** Fetch `d_sens_out.json` once to build a name→id mapping, then poll `sens_out.json` for live state updates.

---

## 3. Command Endpoint

Commands are sent to the server to control outputs. Both POST and GET are supported.  
Multiple commands can be chained in a single request.

### 3.1 POST Command

```
POST http://<HOST>:<PORT>/
Content-Type: application/x-www-form-urlencoded

r_ON=16
```

Multiple commands in one POST body:

```
r_ON=16&r_OFF=5&PCA_ON=2001
```

**cURL example:**
```bash
curl -X POST http://192.168.1.179/ \
  -u USERNAME:PASSWORD \
  -d "r_ON=16"
```

---

### 3.2 GET Command

```
GET http://<HOST>:<PORT>/?command:r_ON=16&r_OFF=30
```

> Note the `command:` prefix before the first parameter in the GET query string.

**cURL example:**
```bash
curl "http://192.168.1.179/?command:r_ON=16&r_OFF=30" \
  -u USERNAME:PASSWORD
```

---

## 4. JSON Data Structure Reference

> **Important:** The top-level keys in all JSON sections use **array index** as the key (e.g. `"0"`, `"1"`, `"2"`...). The actual device identifier is the `id` field inside each object.

---

### 4.1 `relays`

Relay outputs — simple on/off switching.  
**ID range: 1–100** (as referenced in commands)

| Field          | Type    | Description |
|----------------|---------|-------------|
| `id`           | int     | Unique relay identifier. Used in all commands. |
| `description`  | string  | Human-readable name (only in `d_sens_out.json`) |
| `state`        | int     | Current output state: `0` = OFF, `1` = ON |
| `inverse`      | int     | Hardware wiring inversion flag: `0` = normal, `1` = inverted |
| `alarm`        | int     | Alarm flag: `1` = triggers alert when output is ON |
| `justOn`       | int     | If `1`: physical input can only turn ON this output (e.g. motion sensor), not OFF |
| `timer`        | int     | Auto-off timer duration in **seconds** (`0` = disabled) |
| `timerActive`  | int     | `1` if the auto-off timer is currently counting down |
| `timerRemain`  | int     | Seconds remaining until auto-off |
| `delay`        | int     | Turn-on delay in **seconds** |
| `delayActive`  | int     | `1` if the turn-on delay is currently active |
| `delayRemain`  | int     | Seconds remaining until the output turns on |
| `sensor`       | int     | Sensor ID controlling this output (`0` = none). See [Sensor ID Reference](#5-sensor-id-reference) |
| `sensorON`     | int     | Sensor threshold to turn ON (value × 10 for temperature/humidity) |
| `sensorOFF`    | int     | Sensor threshold to turn OFF (value × 10 for temperature/humidity) |

**Example entry:**
```json
"2": {
  "id": 3,
  "description": "wellnes fűtés",
  "state": 0,
  "inverse": 1,
  "alarm": 0,
  "justOn": 0,
  "timer": 0,
  "timerActive": 0,
  "timerRemain": 0,
  "delay": 0,
  "delayActive": 0,
  "delayRemain": 0,
  "sensor": 1,
  "sensorON": 240,
  "sensorOFF": 246
}
```
> This relay is controlled by sensor 1 (temperature). It turns ON at 24.0°C (`240÷10`) and OFF at 24.6°C (`246÷10`).

---

### 4.2 `PCA` (Universal Outputs)

PCA outputs support both on/off switching and PWM (dimming, analog control).  
**ID range: 2001–2128** (offset of 2000 from array index starting at 1)

Includes all `relays` fields, plus:

| Field     | Type    | Description |
|-----------|---------|-------------|
| `id`      | int     | Unique ID starting at **2001** |
| `state`   | int     | Current value: `0–255` (maps to `0–100%`) |
| `turnOFF` | int     | Value assigned when output is "OFF" (`0–255`). Useful for minimum brightness. |
| `turnON`  | int     | Value assigned when output is "ON" (`0–255`) |
| `fade`    | int     | `1` if a fade/dimming transition is currently active |
| `speed`   | int     | Speed of fade transition (`0–255`) |
| `mixer`   | int     | `1` = analog/mixer mode: sensor value is linearly mapped between `sensorON`/`sensorOFF` to `turnON`/`turnOFF` |
| `pwm`     | int     | `0` = digital relay mode (on/off only), `1` = PWM dimming mode |

**Example entry:**
```json
"0": {
  "id": 2001,
  "description": "LED strip living room",
  "state": 128,
  "turnOFF": 0,
  "turnON": 255,
  "fade": 1,
  "speed": 5,
  "mixer": 0,
  "pwm": 1,
  "sensor": 0,
  "sensorON": 0,
  "sensorOFF": 0
}
```

---

### 4.3 `PWM` Outputs

Legacy PWM outputs. Functionally similar to PCA but simpler — no `mixer`, `pwm`, or `inverse`/`alarm`/`justOn` flags.  
**ID range: 101–113**

| Field     | Type    | Description |
|-----------|---------|-------------|
| `id`      | int     | Unique ID: **101–113** |
| `state`   | int     | Current value: `0–255` |
| `turnOFF` | int     | OFF-state value (`0–255`) |
| `turnON`  | int     | ON-state value (`0–255`) |
| `fade`    | int     | `1` if fade transition active |
| `speed`   | int     | Fade speed (`0–255`) |
| `sensor`  | int     | Controlling sensor ID |
| `sensorON`  | int   | Sensor ON threshold |
| `sensorOFF` | int   | Sensor OFF threshold |

> PWM outputs operate in mixer/analog mode by default.

---

### 4.4 `group`

Relay groups — collections of outputs controlled together.  
**ID range: 500–550**

| Field       | Type    | Description |
|-------------|---------|-------------|
| `id`        | int     | Group ID (`500–550`) |
| `description` | string | Group name |
| `pullUP`    | int     | Conflict resolution: `1` = turn ON all if mixed state, `0` = turn OFF all if mixed state |
| `elementN`  | int     | ID of the Nth member output |
| `elementNd` | string  | Description of the Nth member (in `d_sens_out.json`) |

**Example:**
```json
"1": {
  "id": 502,
  "description": "mennyezet csoport",
  "pullUP": 0,
  "element0": 9,
  "element1": 2002,
  "element2": 2003
}
```

---

### 4.5 `joiner`

Output pairs where the first controls the second. When the first is switched ON/OFF, the second follows automatically.

| Field       | Type | Description |
|-------------|------|-------------|
| `element0`  | int  | Primary (master) output ID |
| `element0d` | string | Master description |
| `element1`  | int  | Secondary (slave) output ID |
| `element1d` | string | Slave description |

---

### 4.6 `protection`

Output pairs with mutual exclusion — the server ensures both are never active simultaneously (e.g. shutter UP/DOWN motors). If both are detected ON, the server turns both OFF immediately.

Same structure as `joiner`.

---

### 4.7 `sensors`

Sensor readings. The JSON key matches the sensor ID.

| Sensor ID Range | Type             | Field  | Description |
|-----------------|------------------|--------|-------------|
| `1–100`         | Temperature      | `temp` | Temperature × 100 → divide by 100 for °C |
| `101–108`       | Humidity         | `hum`  | Humidity × 100 → divide by 100 for % |
| `200`           | Pulse counter    | `imp`  | Energy counter × 100 → divide by 100 for kWh |
| `201–203`       | SDM630 Power     | `P`    | Active power × 100 → divide by 100 for kW (per phase) |
| `204–206`       | SDM630 Voltage   | `U`    | Voltage × 100 → divide by 100 for V (per phase) |
| `207–209`       | SDM630 Current   | `I`    | Current × 100 → divide by 100 for A (per phase) |

**Example:**
```json
"sensors": {
  "1":   { "id": 1,   "description": "hőszenzor",   "temp": 2712 },
  "101": { "id": 101, "description": "Talaj szonda", "hum": 4523 },
  "200": { "id": 200, "description": "kW",           "imp": 0 },
  "201": { "id": 201, "description": "P1-kW",        "P": 138 }
}
```

> **Decoded:** `temp: 2712` → `27.12°C` | `hum: 4523` → `45.23%` | `P: 138` → `1.38 kW`

---

## 5. Sensor ID Reference

Used in `sensor`, `sensorON`, `sensorOFF` fields of outputs.

| Sensor ID | Type                         | Notes |
|-----------|------------------------------|-------|
| `0`       | None                         | No sensor control |
| `1–100`   | Temperature sensor           | `sensorON`/`sensorOFF` values are × 10 (e.g. `245` = 24.5°C) |
| `101–108` | Humidity sensor              | Same ×10 encoding |
| `200`     | Pulse counter (energy meter) | |
| `201–203` | SDM630 Power (per phase)     | |
| `204–206` | SDM630 Voltage (per phase)   | |
| `207–209` | SDM630 Current (per phase)   | |
| `255`     | Sun position                 | `sensorON`/`sensorOFF`: `1` = sunrise, `2` = sunset |

---

## 6. Command Reference

Commands are sent as key=value pairs. Multiple commands can be combined with `&`.

---

### 6.1 Relay Commands

| Command                    | Description |
|----------------------------|-------------|
| `r_ON=<id>`                | Turn ON relay with given ID |
| `r_OFF=<id>`               | Turn OFF relay with given ID |
| `r_INV=<id>`               | Toggle (invert) relay state |
| `thermoActivator*<id>=<sensor_id>` | Assign temperature sensor to control relay `<id>` |
| `min_temp_ON*<id>=<val>`   | Set relay ON threshold (value × 10, e.g. `245` = 24.5°C) |
| `max_temp_OFF*<id>=<val>`  | Set relay OFF threshold (value × 10) |

**Examples:**
```
r_ON=16           → Turn on relay #16
r_OFF=5           → Turn off relay #5
r_INV=3           → Toggle relay #3
thermoActivator*1=2   → Relay #1 now controlled by temperature sensor #2
min_temp_ON*3=245     → Relay #3 turns ON below 24.5°C
max_temp_OFF*3=248    → Relay #3 turns OFF above 24.8°C
```

---

### 6.2 PCA Commands

| Command                        | Description |
|--------------------------------|-------------|
| `PCA*<id>=<value>`             | Set PCA output `<id>` to percentage value (`0–100%`) — ID is the real ID (e.g. 2005) |
| `PCA_ON=<id>`                  | Turn ON PCA output |
| `PCA_OFF=<id>`                 | Turn OFF PCA output |
| `PCA_INV=<id>`                 | Toggle PCA output state |
| `PCA_thermoActivator*<id>=<sensor_id>` | Assign temperature sensor to PCA output |
| `PCA_temp_MIN*<id>=<val>`      | Set PCA ON threshold (× 10) |
| `PCA_temp_MAX*<id>=<val>`      | Set PCA OFF threshold (× 10) |

> **Note:** For `PCA*<id>=<val>`, use the **real ID** (e.g. `2005`). The value is a percentage (0–100), internally mapped to 0–255.

**Examples:**
```
PCA*2005=50       → Set PCA output #2005 to 50%
PCA_ON=2001       → Turn on PCA output #2001
PCA_OFF=2003      → Turn off PCA output #2003
PCA_thermoActivator*2001=2   → PCA #2001 controlled by sensor #2
PCA_temp_MIN*2003=245        → PCA #2003 turns ON at 24.5°C
PCA_temp_MAX*2003=248        → PCA #2003 turns OFF at 24.8°C
```

---

### 6.3 PWM Commands

| Command                        | Description |
|--------------------------------|-------------|
| `fet*<id>=<value>`             | Set PWM output `<id>` to percentage (`0–100%`) — ID is offset (e.g. `5` → id 105) |
| `f_ON=<id>`                    | Turn ON PWM output (using real ID, e.g. 106) |
| `f_OFF=<id>`                   | Turn OFF PWM output |
| `f_INV=<id>`                   | Toggle PWM output |
| `fet_thermoActivator*<id>=<sensor_id>` | Assign temperature sensor to PWM output |
| `mix_temp_MIN*<id>=<val>`      | Set PWM ON threshold (× 10) |
| `mix_temp_MAX*<id>=<val>`      | Set PWM OFF threshold (× 10) |

> **Note:** For `fet*<id>=<val>`, `<id>` is the offset index (real_id − 100). Example: `fet*5=50` → controls output with ID 105.

**Examples:**
```
fet*5=50          → Set PWM output #105 to 50%
f_ON=6            → Turn on PWM output #106
f_OFF=6           → Turn off PWM output #106
fet_thermoActivator*1=2   → PWM #101 controlled by sensor #2
mix_temp_MIN*3=245        → PWM #103 turns ON at 24.5°C
mix_temp_MAX*3=248        → PWM #103 turns OFF at 24.8°C
```

---

### 6.4 Group Commands

| Command       | Description |
|---------------|-------------|
| `g_ON=<id>`   | Turn ON all outputs in group `<id>` |
| `g_OFF=<id>`  | Turn OFF all outputs in group `<id>` |
| `g_INV=<id>`  | Toggle group (respects `pullUP` flag for mixed states) |

**Examples:**
```
g_ON=501          → Turn on all members of group #501
g_OFF=502         → Turn off all members of group #502
g_INV=503         → Toggle group #503 (pullUP determines behavior for mixed states)
```

---

## 7. Value Encoding Notes

| Context | Encoding | How to decode |
|---------|----------|---------------|
| Temperature sensor readings (`temp`) | × 100 | `temp / 100` → °C |
| Humidity sensor readings (`hum`) | × 100 | `hum / 100` → % |
| Power readings (`P`, `U`, `I`, `imp`) | × 100 | `value / 100` → kW / V / A / kWh |
| `sensorON` / `sensorOFF` thresholds | × 10 | `value / 10` → °C or % |
| PCA `state` / `turnON` / `turnOFF` | 0–255 | `value / 255 * 100` → % |
| Sun sensor `sensorON`/`sensorOFF` | Special | `1` = sunrise, `2` = sunset |

---

## 8. Usage Examples

### Read current temperature from sensor #1

```bash
curl http://192.168.1.179/sens_out.json -u USER:PASS | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sensors']['1']['temp']/100, '°C')"
```

### Turn on relay #16 (POST)

```bash
curl -X POST http://192.168.1.179/ \
  -u USER:PASS \
  -d "r_ON=16"
```

### Turn off relay #5 and dim PCA #2001 to 30% (combined POST)

```bash
curl -X POST http://192.168.1.179/ \
  -u USER:PASS \
  -d "r_OFF=5&PCA*2001=30"
```

### Turn on relay #16 (GET)

```bash
curl "http://192.168.1.179/?command:r_ON=16" \
  -u USER:PASS
```

### Activate group #502 (GET)

```bash
curl "http://192.168.1.179/?command:g_ON=502" \
  -u USER:PASS
```

### Set relay #3 to be controlled by temperature sensor #1, ON at 24.0°C, OFF at 24.6°C

```bash
curl -X POST http://192.168.1.179/ \
  -u USER:PASS \
  -d "thermoActivator*3=1&min_temp_ON*3=240&max_temp_OFF*3=246"
```

---

## Appendix: sens_out.json – Minimal Schema

```json
{
  "relays": {
    "<index>": {
      "id": "<int: 1-100>",
      "description": "<string>",
      "state": "<int: 0|1>",
      "inverse": "<int: 0|1>",
      "alarm": "<int: 0|1>",
      "justOn": "<int: 0|1>",
      "timer": "<int: seconds>",
      "timerActive": "<int: 0|1>",
      "timerRemain": "<int: seconds>",
      "delay": "<int: seconds>",
      "delayActive": "<int: 0|1>",
      "delayRemain": "<int: seconds>",
      "sensor": "<int: sensor_id>",
      "sensorON": "<int: threshold×10>",
      "sensorOFF": "<int: threshold×10>"
    }
  },
  "PCA": {
    "<index>": {
      "id": "<int: 2001-2128>",
      "state": "<int: 0-255>",
      "turnOFF": "<int: 0-255>",
      "turnON": "<int: 0-255>",
      "fade": "<int: 0|1>",
      "speed": "<int: 0-255>",
      "mixer": "<int: 0|1>",
      "pwm": "<int: 0|1>",
      "sensor": "<int>",
      "sensorON": "<int>",
      "sensorOFF": "<int>"
    }
  },
  "PWM": {
    "<index>": {
      "id": "<int: 101-113>",
      "state": "<int: 0-255>",
      "turnOFF": "<int: 0-255>",
      "turnON": "<int: 0-255>",
      "fade": "<int: 0|1>",
      "speed": "<int: 0-255>",
      "sensor": "<int>",
      "sensorON": "<int>",
      "sensorOFF": "<int>"
    }
  },
  "group": {
    "<index>": {
      "id": "<int: 500-550>",
      "description": "<string>",
      "pullUP": "<int: 0|1>",
      "element0": "<int: output_id>",
      "element1": "<int: output_id>"
    }
  },
  "joiner": {
    "<index>": {
      "element0": "<int: master_id>",
      "element1": "<int: slave_id>"
    }
  },
  "protection": {
    "<index>": {
      "element0": "<int: output_id>",
      "element1": "<int: output_id>"
    }
  },
  "sensors": {
    "<sensor_id>": {
      "id": "<int>",
      "description": "<string>",
      "temp": "<int: °C×100>",
      "hum": "<int: %×100>",
      "imp": "<int: kWh×100>",
      "P": "<int: kW×100>",
      "U": "<int: V×100>",
      "I": "<int: A×100>"
    }
  }
}
```

---

*Documentation generated from myIO Server firmware behavior and live device data.*  
*For additions or corrections, update this document and re-export for MCP server use.*
